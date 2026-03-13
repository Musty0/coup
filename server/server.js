// server.js
import { WebSocketServer } from "ws";
import express from "express";
import http from "http";
import { GameEngine } from "./gameEngine.js";
import { resolveAction, handleResponse } from "./actionResolver.js";
import { BotPlayer, BOT_NAMES, botTick } from "./bot.js";

// Shared helper object passed to botTick so it doesn't need to import server internals
function makeBotFns(room) {
  return {
    resolveAction,
    handleResponse,
    broadcastState: (r) => {
      if (r.game?.gameOver) { checkGameOver(r); return; }
      broadcastState(r);
      const _tc = syncTimer(r);
      if (_tc) broadcastState(r);
    },
    applyPrivates:  (r, result) => applyPrivates(r, result),
  };
}

const MAX_LOBBY_PLAYERS = 8;
const SEAT_COUNT = 4;
const DISCONNECT_GRACE_MS = 600000; // 10 minutes
const ICONS = ["ayla1","ayla2","rumi1","rumi2","tronstad1","tronstad2","tronstad3","zayn1","zayn2","zayn3"];

const app = express();
app.use(express.static("../"));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// rooms: roomCode -> roomState
const rooms = new Map();

// wsMeta: ws -> { room, id }
const wsMeta = new Map();

function sanitizeName(name) {
  return (name || "").toString().trim().slice(0, 7);
}

function sanitizeRoom(room) {
  return (room || "")
    .toString()
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 4);
}

function sendError(ws, code, message) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", code, message }));
  } catch {}
}

function makeEmptySeats() {
  return Array.from({ length: SEAT_COUNT }, () => ({ leaderId: null, advisorId: null }));
}

function seatIdForIndex(seatIndex) {
  return `S${seatIndex + 1}`; // stable engine ids: S1..S4
}

function getOrCreateRoom(roomCode) {
  let r = rooms.get(roomCode);
  if (!r) {
    r = {
      room: roomCode,

      // connection tracking
      clients: new Map(), // Map ws -> {id,name}
      wsById: new Map(), // Map humanId -> ws
      joinOrder: [],

      // lobby/game
      hostId: null,
      phase: "lobby", // "lobby" | "playing" | "ended"
      game: null,

      // seating (authoritative)
      seats: makeEmptySeats(), // always 4
      seatByHumanId: new Map(), // humanId -> { seatIndex, role: "leader"|"advisor" }
      seatLock: false, // false in lobby, true after startGame

      // team UI picks (per seatIndex: 0..3)
teamPicks: Array.from({ length: SEAT_COUNT }, () => ({
  leader: null,  // {k,v} highlight
  advisor: null, // {k,v} suggestion
})),

activityLog: [], // room events (joins, kicks, host changes), capped at 40
gameLog: [],     // in-game events (actions, challenges, blocks), capped at 60

// bots: Map seatId -> BotPlayer  (e.g. "S1" -> BotPlayer)
bots: new Map(),
// botClients: Map botHumanId -> { id, name }  (name lookup, no ws)
botClients: new Map(),
// track how many bots have been added (for names)
botCount: 0,
timerSettings: { enabled: false, turnMs: 45000, responseMs: 10000, paused: false },
timerState: { type: null, seatId: null, stage: null, startedAt: null, durationMs: null, handle: null },
      swapRequests: new Map(), // seatIndex -> { requesterId, handle }
seatChats: Array.from({ length: SEAT_COUNT }, () => []),
};
    rooms.set(roomCode, r);
  }
  return r;
}

function ensureHost(room) {
  if (!room.hostId) {
    room.hostId = room.joinOrder[0] || null;
    return;
  }

  // Only change host if current host no longer exists
  if (!room.joinOrder.includes(room.hostId)) {
    room.hostId = room.joinOrder[0] || null;
  }
}

function unseatHuman(room, humanId) {
  const cur = room.seatByHumanId.get(humanId);
  if (!cur) return;

  const s = room.seats?.[cur.seatIndex];
  if (s) {
    if (cur.role === "leader" && s.leaderId === humanId) s.leaderId = null;
    if (cur.role === "advisor" && s.advisorId === humanId) s.advisorId = null;
  }
  room.seatByHumanId.delete(humanId);
}

function seatInfoForHuman(room, humanId) {
  return room.seatByHumanId.get(humanId) || null; // { seatIndex, role }
}

function seatIdForHuman(room, humanId) {
  const info = seatInfoForHuman(room, humanId);
  if (!info) return null;
  return seatIdForIndex(info.seatIndex);
}

function isLeader(room, humanId) {
  const info = seatInfoForHuman(room, humanId);
  if (!info) return false;
  if (info.role !== "leader") return false;
  const s = room.seats?.[info.seatIndex];
  return !!s && s.leaderId === humanId;
}

function leaderHumanIdForSeat(room, seatId) {
  for (const [humanId, info] of room.seatByHumanId.entries()) {
    if (seatIdForIndex(info.seatIndex) === seatId && info.role === "leader") {
      return humanId;
    }
  }
  return null;
}

function playerNameByHumanId(room, humanId) {
  const ws = room.wsById.get(humanId);
  const c = ws ? room.clients.get(ws) : null;
  if (c) return c.name;
  // Fall back to bot client name
  return room.botClients?.get(humanId)?.name || "Player";
}

function assignRandomIcons(room) {
  const shuffled = [...ICONS].sort(() => Math.random() - 0.5);
  let i = 0;
  for (const seat of room.seats) {
    if (seat.leaderId) seat.icon = shuffled[i++] || null;
    else seat.icon = null;
  }
}

function addLog(room, msg) {
  room.activityLog.push({ t: Date.now(), msg });
  if (room.activityLog.length > 40) room.activityLog.shift();
}

function addGameLog(room, msg) {
  room.gameLog.push({ t: Date.now(), msg });
  if (room.gameLog.length > 60) room.gameLog.shift();
}

function seatDisplayName(room, seatIndex) {
  const s = room.seats[seatIndex];
  const leaderName = s.leaderId ? playerNameByHumanId(room, s.leaderId) : "Empty";
  const advisorName = s.advisorId ? playerNameByHumanId(room, s.advisorId) : null;
  return advisorName ? `${leaderName} + ${advisorName}` : leaderName;
}

function lobbyStateFor(room, viewerId) {
  const youSeat = seatInfoForHuman(room, viewerId);

  const lobbyPlayers = room.joinOrder
  .map((id) => {
    const ws = room.wsById.get(id);
    const c = ws ? room.clients.get(ws) : null;
    if (c) return { id: c.id, name: c.name };
    const bot = room.botClients.get(id);
    if (bot) return { id: bot.id, name: bot.name };
    return null;
  })
  .filter(Boolean);

  return {
    phase: "lobby",

    hostId: room.hostId,
    teamPicks: room.teamPicks,

    // NEW: seating info (authoritative)
    seats: room.seats,
    you: {
      humanId: viewerId,
      seatIndex: youSeat?.seatIndex ?? null,
      role: youSeat?.role ?? null,
    },

    // keep these for now (client currently uses them)
    turnPlayerId: null,
    pendingAction: null,
    activityLog: room.activityLog,
    gameLog: [],
    players: lobbyPlayers.map((p) => ({
      id: p.id,
      name: p.name,
      coins: 0,
      alive: true,
      influence: [
        { role: "?", revealed: false },
        { role: "?", revealed: false },
      ],
    })),

    youId: viewerId,
    timerSettings: { ...room.timerSettings },
    timerEndsAt: null,
    timerSeatId: null,
    timerType: null,
    timerDurationMs: null,
    seatChatHistory: (youSeat?.seatIndex != null) ? (room.seatChats[youSeat.seatIndex] || []) : [],
  };
}

function stateForClient(room, clientId) {
  // playing/ended
  if ((room.phase === "playing" || room.phase === "ended") && room.game) {
    const youSeatId = seatIdForHuman(room, clientId); // S1..S4 or null if spectator

    // spectator view: use a non-existent id (engine should hide all private info)
    const viewerKey = youSeatId || "SPECTATOR";

    const s = room.game.getStateFor(viewerKey);

    // God view for spectators: pull each player's real cards from their own state
    if (!youSeatId && Array.isArray(s.players)) {
      s.players = s.players.map(p => {
        const pState = room.game.getStateFor(p.id);
        const pData = pState?.players?.find(pp => pp.id === p.id);
        return pData ? { ...p, influence: pData.influence } : p;
      });
    }

    // attach seat/lobby metadata
    const youSeat = seatInfoForHuman(room, clientId);
    s.youHumanId = clientId;
    s.youSeatId = youSeatId; // null if spectator
s.you = {
      humanId: clientId,
      seatIndex: youSeat?.seatIndex ?? null,
      role: youSeat?.role ?? null,
      seatId: youSeatId,
    };

    s.hostHumanId = room.hostId;
    s.hostSeatId = room.hostId ? seatIdForHuman(room, room.hostId) : null;

    s.seats = room.seats;
    s.teamPicks = room.teamPicks;

    s.phase = room.game.gameOver ? "ended" : room.phase;

    // On game end, reveal all surviving cards so clients can show them
    if (s.phase === "ended" && Array.isArray(s.players)) {
      s.players = s.players.map(p => {
        const fullState = room.game.getStateFor(p.id);
        const fullP = fullState?.players?.find(pp => pp.id === p.id);
        if (!fullP) return p;
        return { ...p, influence: fullP.influence };
      });
    }
    s.hostId = room.hostId;
    s.activityLog = room.activityLog;
    s.gameLog = room.gameLog;

    // Human player list for log/kick UI (always human ids, not seat ids)
    s.humanPlayers = room.joinOrder.map(id => {
      const ws = room.wsById.get(id);
      const c = ws ? room.clients.get(ws) : null;
      return c ? { id: c.id, name: c.name } : null;
    }).filter(Boolean);

    s.seatChatHistory = (youSeat?.seatIndex != null) ? (room.seatChats[youSeat.seatIndex] || []) : [];
    s.timerSettings = { ...room.timerSettings };
    if (room.timerSettings?.enabled && !room.timerSettings?.paused && room.timerState?.startedAt) {
      s.timerEndsAt = room.timerState.startedAt + room.timerState.durationMs;
      s.timerSeatId = room.timerState.seatId;
      s.timerType = room.timerState.type;
      s.timerDurationMs = room.timerState.durationMs;
      s.timerSeatIds = (room.timerState.type === "response" && room.game?.pendingAction?.responders)
        ? Object.entries(room.game.pendingAction.responders).filter(([,v]) => v === "pending").map(([id]) => id)
        : null;
    } else {
      s.timerEndsAt = null; s.timerSeatId = null; s.timerType = null; s.timerDurationMs = null; s.timerSeatIds = null;
    }

    return s;
  }

  // lobby
  return lobbyStateFor(room, clientId);
}

function broadcastState(room) {
  for (const [ws, c] of room.clients.entries()) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "state", state: stateForClient(room, c.id) }));
    }
  }
}

function sendToPlayer(room, playerId, msgObj) {
  // playerId may be a seatId ("S1") or a humanId — resolve to humanId first
  let humanId = playerId;
  if (/^S\d+$/.test(playerId)) {
    humanId = leaderHumanIdForSeat(room, playerId) || playerId;
  }
  const ws = room.wsById.get(humanId);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msgObj));
}

function applyPrivates(room, result) {
  const privates = result?.privates || [];
  for (const p of privates) sendToPlayer(room, p.to, p.msg);
}

function resetToLobby(room, reason, preserveSeats = false) {
  room.phase = "lobby";
  room.game = null;
  room.seatLock = false;
  room.seatChats = Array.from({ length: SEAT_COUNT }, () => []);
  room.gameLog = [];

  if (!preserveSeats) {
    room.seats = room.seats?.length === SEAT_COUNT ? room.seats : makeEmptySeats();
    for (const s of room.seats) {
      s.leaderId = null;
      s.advisorId = null;
    }
    room.seatByHumanId = new Map();
  }

  if (preserveSeats) assignRandomIcons(room);
  clearRoomTimer(room);
  if (reason) console.log(`[${room.room}] ${reason}`);
  ensureHost(room);
  broadcastState(room);
}

function removePlayer(room, ws) {
  const client = room.clients.get(ws);
  if (!client) return;

  addLog(room, `${client.name} left`);
  const wasSeated = room.seatByHumanId.has(client.id);
  unseatHuman(room, client.id);

  // hard remove from connection tracking
  room.clients.delete(ws);
  wsMeta.delete(ws);

  // Only delete wsById if it points to THIS ws
  const currentWs = room.wsById.get(client.id);
  if (currentWs === ws) room.wsById.delete(client.id);

  // remove from room membership
  room.joinOrder = room.joinOrder.filter((id) => id !== client.id);
  ensureHost(room);

  if (room.phase === "playing" || room.phase === "ended") {
    if (wasSeated) {
      resetToLobby(room, "A player left during the game. Returning to lobby.");
    } else {
      broadcastState(room);
    }
  } else {
    broadcastState(room);
  }

  // If room empty, clean it up
  if (room.joinOrder.length === 0 && room.clients.size === 0) rooms.delete(room.room);
}

function checkGameOver(room) {
  if (!room.game?.gameOver) return;
  if (room.phase === "ended") return;
  room.phase = "ended";
  clearRoomTimer(room);
  addGameLog(room, "Game over.");
  broadcastState(room);
  setTimeout(() => {
    if (room.phase === "ended") resetToLobby(room, "Game ended. Returning to lobby.", true);
  }, 5000);
}

function clearRoomTimer(room, saveRemaining = false) {
  if (room.timerState?.handle) clearTimeout(room.timerState.handle);
  const remaining = saveRemaining && room.timerState?.startedAt
    ? Math.max(0, room.timerState.startedAt + room.timerState.durationMs - Date.now())
    : null;
  room.timerState = { type: null, seatId: null, stage: null, startedAt: null, durationMs: null, handle: null, remainingMs: remaining };
}

function syncTimer(room) {
  const s = room.timerSettings;
  if (!s?.enabled || s.paused || room.phase !== "playing" || !room.game || room.game.gameOver) {
    if (room.timerState?.handle) { clearRoomTimer(room); return true; }
    return false;
  }

  const pending = room.game.pendingAction;
  let shouldType = null, shouldSeatId = null, shouldStage = null, shouldDuration = null;

  if (!pending) {
    const cp = room.game.currentPlayer();
    if (cp) { shouldType = "turn"; shouldSeatId = cp.id; shouldStage = "turn"; shouldDuration = s.turnMs; }
  } else if (["awaitingChallenge", "awaitingBlock", "awaitingChallengeBlock"].includes(pending.stage)) {
    shouldType = "response"; shouldSeatId = pending.actorId; shouldStage = pending.stage; shouldDuration = s.responseMs;
  }

  const cur = room.timerState;
  if (cur.type === shouldType && cur.seatId === shouldSeatId && cur.stage === shouldStage && cur.handle) return false;

  // Capture remainingMs BEFORE clearRoomTimer wipes timerState
  const savedRemaining = cur.remainingMs;
  const wasCleared = cur.type === null;

  clearRoomTimer(room);
  if (!shouldType) return cur.type !== null;

  const isResume = wasCleared && savedRemaining != null && savedRemaining > 0;
  const effectiveDuration = isResume ? savedRemaining : shouldDuration;

const startedAt = Date.now();
const capturedType = shouldType, capturedSeat = shouldSeatId, capturedStage = shouldStage;
room.timerState = { type: capturedType, seatId: capturedSeat, stage: capturedStage, startedAt, durationMs: effectiveDuration, handle: null, remainingMs: null };
room.timerState.handle = setTimeout(() => onTimerFired(room, capturedType, capturedSeat, capturedStage), effectiveDuration);
  return true;
}

function onTimerFired(room, type, seatId, stage) {
  room.timerState = { type: null, seatId: null, stage: null, startedAt: null, durationMs: null, handle: null };
  if (room.phase !== "playing" || !room.game || room.game.gameOver) return;

  if (type === "turn") {
    const cp = room.game.currentPlayer();
    if (!cp || cp.id !== seatId || room.game.pendingAction) return;
    addGameLog(room, `${cp.name}'s turn timed out — auto Income.`);
    const result = resolveAction(room.game, { actorId: seatId, actionType: "income", targetId: null });
    checkGameOver(room);
    if (room.phase !== "ended") {
      broadcastState(room);
      applyPrivates(room, result);
      botTick(room, makeBotFns(room));
      const changed = syncTimer(room);
      if (changed) broadcastState(room);
    }
    return;
  }

  if (type === "response") {
    const pending = room.game.pendingAction;
    if (!pending || pending.actorId !== seatId || pending.stage !== stage) return;
    const pendingIds = Object.entries(pending.responders || {}).filter(([,v]) => v === "pending").map(([id]) => id);
    if (!pendingIds.length) return;
    addGameLog(room, `Response window timed out — auto-pass.`);
    let lastResult;
    for (const responderId of pendingIds) {
      if (!room.game.pendingAction) break;
      lastResult = handleResponse(room.game, { playerId: responderId, responseType: "pass", payload: {} });
    }
    checkGameOver(room);
    if (room.phase !== "ended") {
      broadcastState(room);
      if (lastResult) applyPrivates(room, lastResult);
      botTick(room, makeBotFns(room));
      const changed = syncTimer(room);
      if (changed) broadcastState(room);
    }
  }
}

function startGameFromSeats(room) {
  // Must have at least 2 occupied seats (by leader) to start
// Promote solo advisors to leader before checking seat count
for (let i = 0; i < SEAT_COUNT; i++) {
  const s = room.seats[i];
  if (!s.leaderId && s.advisorId) {
    console.log(`[${room.room}] Promoting advisor ${s.advisorId} to leader in seat ${i}`);
    s.leaderId = s.advisorId;
    s.advisorId = null;
    const info = room.seatByHumanId.get(s.leaderId);
    if (info) info.role = "leader";
  }
}

const occupiedSeatIndexes = [];
for (let i = 0; i < SEAT_COUNT; i++) {
  if (room.seats[i].leaderId) occupiedSeatIndexes.push(i);
}
if (occupiedSeatIndexes.length < 2) return;

// lock seating
room.seatLock = true;

// Build <=4 engine players (seats are the players)
const seatPlayers = occupiedSeatIndexes.map((seatIndex) => ({
  id: seatIdForIndex(seatIndex),
  name: seatDisplayName(room, seatIndex),
}));

// Randomise starting player while preserving clockwise seat order
let startIndex = 0;
if (seatPlayers.length > 1) {
  startIndex = Math.floor(Math.random() * seatPlayers.length);
}
const orderedPlayers = [];
for (let i = 0; i < seatPlayers.length; i++) {
  orderedPlayers.push(seatPlayers[(startIndex + i) % seatPlayers.length]);
}

  console.log("ENGINE PLAYERS:", orderedPlayers);

  try {
    room.game = new GameEngine(orderedPlayers);
    room.phase = "playing";
    broadcastState(room);
    const _tc = syncTimer(room);
    if (_tc) broadcastState(room);
    // Give clients a moment to render before bots start acting
    setTimeout(() => botTick(room, makeBotFns(room)), 800);
  } catch (err) {
    console.log(`[${room.room}] startGame failed:`, err?.message || err);

    room.phase = "lobby";
    room.game = null;
    room.seatLock = false;
    ensureHost(room);

    const hostWs = room.wsById.get(room.hostId);
    if (hostWs) sendError(hostWs, "START_FAILED", err?.message || "Start failed.");

    broadcastState(room);
  }
}

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // JOIN (must include room)
    if (data.type === "join") {
      const roomCode = sanitizeRoom(data.room);
      if (!/^[A-Z]{4}$/.test(roomCode)) return;

      const id = (data.id || "").toString();
      if (!id) {
        sendError(ws, "BAD_JOIN", "Missing id.");
        try {
          ws.close(1008, "Bad join");
        } catch {}
        return;
      }

      // IMPORTANT: don't create a room just to reject someone.
      const existing = rooms.get(roomCode);

      // If room exists, enforce capacity + in-progress rules (allow reconnects)
      if (existing) {
        const isRejoin = existing.joinOrder.includes(id) || existing.wsById.has(id);

        if (!isRejoin && existing.joinOrder.length >= MAX_LOBBY_PLAYERS) {
          sendError(ws, "ROOM_FULL", `Lobby is full (${existing.joinOrder.length}/${MAX_LOBBY_PLAYERS}).`);
          try {
            ws.close(1008, "Room full");
          } catch {}
          return;
        }

        // allow spectators to stay connected during playing only if they already joined earlier
        if (!isRejoin && existing.phase !== "lobby") {
          sendError(ws, "GAME_IN_PROGRESS", "Game already in progress.");
          try {
            ws.close(1008, "Game in progress");
          } catch {}
          return;
        }
      }

// Create room only after passing rejection checks
const wantsCreate =
  data.create === true ||
  data.new === 1 ||
  data.new === "1";

if (!existing && !wantsCreate) {
  sendError(ws, "ROOM_NOT_FOUND", "Room not found. Check the code and try again.");
  try { ws.close(1008, "Room not found"); } catch {}
  return;
}

const room = existing || getOrCreateRoom(roomCode);

const name = sanitizeName(data.name) || "Player";
      const isRejoin = existing && (existing.joinOrder.includes(id) || existing.wsById.has(id));
      if (!isRejoin && existing) {
        const nameTaken = [...existing.clients.values()].some(c => c.id !== id && c.name.toLowerCase() === name.toLowerCase());
        if (nameTaken) {
          sendError(ws, "NAME_TAKEN", `The name "${name}" is already taken. Please go back and choose a different name.`);
          try { ws.close(1008, "Name taken"); } catch {}
          return;
        }
      }

      // If same id already connected in this room, replace old socket (reconnect)
      const oldWs = room.wsById.get(id);
      if (oldWs && oldWs !== ws) {
        try {
          oldWs.close();
        } catch {}
        room.clients.delete(oldWs);
        wsMeta.delete(oldWs);
      }

      room.clients.set(ws, { id, name });
      room.wsById.set(id, ws);
      wsMeta.set(ws, { room: roomCode, id });

      const isNewJoin = !room.joinOrder.includes(id);
      if (isNewJoin) room.joinOrder.push(id);
      if (!room.hostId) room.hostId = id;

      if (isNewJoin) addLog(room, `${name} joined`);
      broadcastState(room);
      return;
    }

    // From here on, must know which room this ws belongs to
    const meta = wsMeta.get(ws);
    if (!meta) return;

    const room = rooms.get(meta.room);
    if (!room) return;

    const client = room.clients.get(ws);
    if (!client) return;

    // RENAME
    if (data.type === "rename") {
      const newName = sanitizeName(data.name);
      if (!newName) return;

      const nameTaken = [...room.clients.values()].some(c => c.id !== client.id && c.name.toLowerCase() === newName.toLowerCase());
      if (nameTaken) {
        sendError(ws, "NAME_TAKEN", `The name "${newName}" is already taken. Please choose a different name.`);
        return;
      }

      client.name = newName;
      room.clients.set(ws, client);

      // update engine seat name if seated
      if ((room.phase === "playing" || room.phase === "ended") && room.game) {
        const info = seatInfoForHuman(room, client.id);
        if (info) {
          const seatIndex = info.seatIndex;
          const pid = seatIdForIndex(seatIndex);
          const p = room.game.getPlayer?.(pid);
          if (p) p.name = seatDisplayName(room, seatIndex);
        }
      }

      broadcastState(room);
      return;
    }

    // SIT (pick seat + role) — lobby only
    if (data.type === "sit") {
      if (room.phase !== "lobby" || room.seatLock) return;

      const seatIndex = Number(data.seatIndex);
      const role = data.role === "advisor" ? "advisor" : "leader";

      if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= SEAT_COUNT) return;

      // move if already seated
      unseatHuman(room, client.id);

      const s = room.seats[seatIndex];

      // capacity checks
      if (role === "leader" && s.leaderId) return;
      if (role === "advisor" && s.advisorId) return;

// assign
if (role === "leader") {
  s.leaderId = client.id;
  const usedIcons = new Set(room.seats.map(seat => seat.icon).filter(Boolean));
  const available = ICONS.filter(ic => !usedIcons.has(ic));
  s.icon = available.length > 0 ? available[Math.floor(Math.random() * available.length)] : null;
} else {
  s.advisorId = client.id;
}

      room.seatByHumanId.set(client.id, { seatIndex, role });

      broadcastState(room);
      return;
    }

    // STAND (leave seat) — lobby only
    if (data.type === "stand") {
      if (room.phase !== "lobby" || room.seatLock) return;
      unseatHuman(room, client.id);
      broadcastState(room);
      return;
    }

    // LEAVE
    if (data.type === "leave") {
      removePlayer(room, ws);
      try {
        ws.close();
      } catch {}
      return;
    }

    // START GAME
    if (data.type === "startGame" || data.type === "start") {
      if (room.phase !== "lobby") return;
      if (client.id !== room.hostId) return;

      // start requires 2+ occupied seats (leaders)
      const occupied = room.seats.filter((s) => !!s.leaderId).length;
      if (occupied < 2) return;

      startGameFromSeats(room);
      return;
    }

    // REMATCH
    if (data.type === "rematch") {
      if (room.phase !== "ended") return;
      if (client.id !== room.hostId) return;

      // unlock seating for rematch lobby first (clear all seats)
      resetToLobby(room, null);

      // host can immediately start again once seats are chosen
      broadcastState(room);
      return;
    }

    if (data.type === "delegateHost") {
      if (client.id !== room.hostId) return;
      const targetId = (data.targetId || "").toString();
      if (!room.joinOrder.includes(targetId)) return;
      const oldName = client.name;
      const newName = playerNameByHumanId(room, targetId);
      room.hostId = targetId;
      addLog(room, `${oldName} made ${newName} the host`);
      broadcastState(room);
      return;
    }

// STOP GAME (host only, playing only)
if (data.type === "stopGame") {
  if (room.phase !== "playing") return;
  if (client.id !== room.hostId) return;
  addLog(room, `${client.name} stopped the game`);
  resetToLobby(room, `${client.name} stopped the game.`, true);
  return;
}

// RESET TEAMS (host only, lobby only)
if (data.type === "resetTeams") {
  if (room.phase !== "lobby" || room.seatLock) return;
  if (client.id !== room.hostId) return;
  room.seats = makeEmptySeats();
  room.seatByHumanId = new Map();
  for (const botId of room.botClients.keys()) {
    room.joinOrder = room.joinOrder.filter(id => id !== botId);
  }
  room.botClients = new Map();
  room.bots = new Map();
  addLog(room, `${client.name} reset all teams`);
  broadcastState(room);
  return;
}

// RANDOMISE TEAMS (host only, lobby only)
if (data.type === "randomiseTeams") {
  if (room.phase !== "lobby" || room.seatLock) return;
  if (client.id !== room.hostId) return;

  const humans = room.joinOrder.filter(id => !id.startsWith("bot-"));
  for (let i = humans.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [humans[i], humans[j]] = [humans[j], humans[i]];
  }

  const botSeatIndexes = new Set();
  for (let i = 0; i < SEAT_COUNT; i++) {
    if (room.seats[i].leaderId?.startsWith("bot-")) botSeatIndexes.add(i);
  }

  // Clear human assignments only
  for (const [humanId] of [...room.seatByHumanId.entries()]) {
    if (!humanId.startsWith("bot-")) room.seatByHumanId.delete(humanId);
  }
  for (let i = 0; i < SEAT_COUNT; i++) {
    if (!botSeatIndexes.has(i)) { room.seats[i].leaderId = null; room.seats[i].advisorId = null; }
    else { room.seats[i].advisorId = null; }
  }

  // Shuffle leader slots (non-bot seats only)
  const leaderSlots = [...Array(SEAT_COUNT).keys()].filter(i => !botSeatIndexes.has(i));
  for (let i = leaderSlots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [leaderSlots[i], leaderSlots[j]] = [leaderSlots[j], leaderSlots[i]];
  }

  // Shuffle advisor slots (all seats)
  const advisorSlots = [...Array(SEAT_COUNT).keys()];
  for (let i = advisorSlots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [advisorSlots[i], advisorSlots[j]] = [advisorSlots[j], advisorSlots[i]];
  }

  let hi = 0;
  for (const si of leaderSlots) {
    if (hi >= humans.length) break;
    room.seats[si].leaderId = humans[hi];
    room.seatByHumanId.set(humans[hi], { seatIndex: si, role: "leader" });
    hi++;
  }
  for (const si of advisorSlots) {
    if (hi >= humans.length) break;
    if (room.seats[si].advisorId) continue;
    room.seats[si].advisorId = humans[hi];
    room.seatByHumanId.set(humans[hi], { seatIndex: si, role: "advisor" });
    hi++;
  }

  assignRandomIcons(room);
  addLog(room, `${client.name} randomised teams`);
  broadcastState(room);
  return;
}

// KICK (host only, lobby + playing)
if (data.type === "kick") {
  if (client.id !== room.hostId) return;

  const targetId = data.targetId;
  const targetWs = room.wsById.get(targetId);
  if (!targetWs) return;

  const targetClient = room.clients.get(targetWs);
  const targetName = targetClient?.name || targetId;
  addLog(room, `${targetName} was kicked by ${client.name}`);
  sendError(targetWs, "KICKED", "You were kicked from the lobby.");

  removePlayer(room, targetWs);
  try { targetWs.close(); } catch {}

  return;
}

// SET TIMER (host only)
if (data.type === "setTimer") {
  if (client.id !== room.hostId) return;
  const ts = room.timerSettings;
  if (typeof data.enabled === "boolean") ts.enabled = data.enabled;
  if (typeof data.paused === "boolean") ts.paused = data.paused;
  if (typeof data.turnMs === "number" && data.turnMs >= 5000) ts.turnMs = Math.min(data.turnMs, 300000);
  if (typeof data.responseMs === "number" && data.responseMs >= 3000) ts.responseMs = Math.min(data.responseMs, 60000);
  if (!ts.enabled) clearRoomTimer(room);
  else if (ts.paused) clearRoomTimer(room, true); // save remaining
  broadcastState(room);
  if (ts.enabled && !ts.paused) { const _tc = syncTimer(room); if (_tc) broadcastState(room); }
  return;
}

// ADD BOT (host only, lobby only)
if (data.type === "addBot") {
  if (room.phase !== "lobby" || room.seatLock) return;
  if (client.id !== room.hostId) return;
  if (room.joinOrder.length >= MAX_LOBBY_PLAYERS) return;

  // Find a free leader slot
  const emptySlot = room.seats.findIndex((s) => !s.leaderId);
  if (emptySlot === -1) return; // all seats taken

  const usedNames = new Set([...room.botClients.values()].map(b => b.name));
  const availableNames = BOT_NAMES.filter(n => !usedNames.has(n));
  const botName = availableNames.length > 0
    ? availableNames[Math.floor(Math.random() * availableNames.length)]
    : `Bot${(room.botCount || 0) + 1}`;
  const botId = `bot-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  
  room.botCount = (room.botCount || 0) + 1;

  // Register as a fake human (no ws)
  room.joinOrder.push(botId);
  room.botClients.set(botId, { id: botId, name: botName });

  // Seat the bot as leader
  room.seats[emptySlot].leaderId = botId;
  room.seatByHumanId.set(botId, { seatIndex: emptySlot, role: "leader" });

  // Create bot brain (keyed by seatId, e.g. "S2")
  const seatId = seatIdForIndex(emptySlot);
  room.bots.set(seatId, new BotPlayer(seatId));

  broadcastState(room);
  return;
}

// REMOVE BOT (host only, lobby only)
if (data.type === "removeBot") {
  if (room.phase !== "lobby" || room.seatLock) return;
  if (client.id !== room.hostId) return;

  // If a specific botId is given, remove that one; otherwise remove last bot
  const targetBotId = data.botId || null;
  let removed = false;
  for (let i = SEAT_COUNT - 1; i >= 0; i--) {
    const leaderId = room.seats[i].leaderId;
    if (leaderId && leaderId.startsWith("bot-")) {
      if (targetBotId && leaderId !== targetBotId) continue;
      room.seats[i].leaderId = null;
      room.seatByHumanId.delete(leaderId);
      room.joinOrder = room.joinOrder.filter((id) => id !== leaderId);
      room.botClients.delete(leaderId);
      room.bots.delete(seatIdForIndex(i));
      removed = true;
      break;
    }
  }
  if (removed) broadcastState(room);
  return;
}

// TEAM PICK MESSAGES (lobby + playing)
// - advisor: teamSuggest
// - leader:  teamPreview (highlight) and teamConfirm (execute)
if (data.type === "teamSuggest" || data.type === "teamPreview" || data.type === "teamConfirm") {
  const info = seatInfoForHuman(room, client.id);
  if (!info) return; // spectators can't pick

  const { seatIndex, role } = info;
  const k = (data.k || "").toString();
  const v = (data.v || "").toString();

  // allow only known channels
  const okK = k === "action" || k === "target" || k === "response";
  if (!okK) return;

  // advisor suggestion
  if (data.type === "teamSuggest") {
    if (role !== "advisor") return;
    room.teamPicks[seatIndex].advisor = { k, v };
    broadcastState(room);
    return;
  }

  // leader highlight / confirm
  if (!isLeader(room, client.id)) return;

  if (data.type === "teamPreview") {
    room.teamPicks[seatIndex].leader = { k, v };
    broadcastState(room);
    return;
  }

  // teamConfirm: execute (only meaningful during playing)
  if (data.type === "teamConfirm") {
    // store the leader pick
    room.teamPicks[seatIndex].leader = { k, v };

    // If not in a running game, just broadcast highlight (no execute)
    if (room.phase !== "playing" || !room.game) {
      broadcastState(room);
      return;
    }

const seatId = seatIdForIndex(seatIndex);

// Clear advisor suggestion on confirm (optional but recommended)
room.teamPicks[seatIndex].advisor = null;

// Execute based on k
if (k === "action") {
  const current = room.game.currentPlayer();
  if (!current || current.id !== seatId) {
    broadcastState(room);
    return;
  }

  if (room.game.pendingAction) {
    broadcastState(room);
    return;
  }

  const result = resolveAction(room.game, {
    actorId: seatId,
    actionType: v,
    targetId: data.targetId || null,
  });

  const actorName = seatDisplayName(room, seatIndex);
  const targetName = data.targetId ? seatDisplayName(room, parseInt(data.targetId.replace("S","")) - 1) : null;
  const actionLabel = { income:"Income", foreign_aid:"Foreign Aid", tax:"Tax", steal:"Steal", assassinate:"Assassinate", exchange:"Exchange", coup:"Coup" }[v] || v;
  addGameLog(room, targetName ? `${actorName} → ${actionLabel} → ${targetName}` : `${actorName} → ${actionLabel}`);

  checkGameOver(room);
  if (room.phase !== "ended") {
    broadcastState(room);
    applyPrivates(room, result);
    botTick(room, makeBotFns(room));
    const _tc = syncTimer(room);
    if (_tc) broadcastState(room);
  }
  return;
}

if (k === "response") {
  let responseType = v;
  let payload = {};

          if (v.startsWith("block:")) {
            responseType = "block";
            payload = { role: v.split(":")[1] || "" };
          } else if (v === "loseInfluence") {
            payload = { cardIndex: typeof data.cardIndex === "number" ? data.cardIndex : null };
          } else if (v === "exchangeChoice") {
            payload = { keep: Array.isArray(data.keep) ? data.keep : [] };
          }

          const pending = room.game.pendingAction;
          if (!pending) {
            broadcastState(room);
            return;
          }

          // Some responses (loseInfluence, exchangeChoice) are "seat‑pure" and
          // don't use the generic responders map. Allow those directly.
          const isSeatPureLose =
            pending.type === "loseInfluence" &&
            v === "loseInfluence" &&
            pending.playerId === seatId;

          const isSeatPureExchange =
            pending.type === "exchange" &&
            pending.stage === "awaitingChoice" &&
            v === "exchangeChoice" &&
            pending.actorId === seatId;

          if (!isSeatPureLose && !isSeatPureExchange) {
            if (!pending.responders || !(seatId in pending.responders)) {
              broadcastState(room);
              return;
            }
          }

          const result = handleResponse(room.game, {
            playerId: seatId,
            responseType,
            payload,
          });

          const respActorName = seatDisplayName(room, parseInt(seatId.replace("S","")) - 1);
          const respLabel = responseType === "pass" ? "Pass" : responseType === "challenge" ? "Challenge" : responseType === "block" ? `Block (${payload.role || ""})` : responseType === "loseInfluence" ? "Lost influence" : responseType === "exchangeChoice" ? "Exchanged cards" : responseType;
          addGameLog(room, `${respActorName} → ${respLabel}`);

          checkGameOver(room);
          if (room.phase !== "ended") {
            broadcastState(room);
            applyPrivates(room, result);
            botTick(room, makeBotFns(room));
            const _tc = syncTimer(room);
            if (_tc) broadcastState(room);
          }
          return;
        }
        
            // k === "target" is UI-only for now
    broadcastState(room);
    return;
  }
}

// SWAP ROLES — request (lobby only, both slots must be filled)
if (data.type === "swapRoles") {
  if (room.phase !== "lobby" || room.seatLock) return;
  const info = seatInfoForHuman(room, client.id);
  if (!info) return;
  const { seatIndex } = info;
  const s = room.seats[seatIndex];
  if (!s.leaderId || !s.advisorId) return;

  // Cancel any existing request for this seat
  const existing = room.swapRequests.get(seatIndex);
  if (existing?.handle) clearTimeout(existing.handle);

// Find the other teammate
const otherId = info.role === "leader" ? s.advisorId : s.leaderId;

// If the other teammate is a bot, auto-accept the swap immediately
if (otherId?.startsWith("bot-")) {
  const oldLeader = s.leaderId;
  const oldAdvisor = s.advisorId;
  s.leaderId = oldAdvisor;
  s.advisorId = oldLeader;
  const leaderInfo = room.seatByHumanId.get(oldLeader);
  const advisorInfo = room.seatByHumanId.get(oldAdvisor);
  if (leaderInfo) leaderInfo.role = "advisor";
  if (advisorInfo) advisorInfo.role = "leader";
  addLog(room, `${playerNameByHumanId(room, s.leaderId)} and ${playerNameByHumanId(room, s.advisorId)} swapped roles`);
  broadcastState(room);
  return;
}

const otherWs = room.wsById.get(otherId);
if (!otherWs || otherWs.readyState !== 1) return;

  // Store request with 15s expiry
  const handle = setTimeout(() => {
    room.swapRequests.delete(seatIndex);
    // notify requester it expired
    const reqWs = room.wsById.get(client.id);
    if (reqWs?.readyState === 1) reqWs.send(JSON.stringify({ type: "swapExpired" }));
  }, 15000);

  room.swapRequests.set(seatIndex, { requesterId: client.id, handle });

  // Send request to other teammate only
  otherWs.send(JSON.stringify({
    type: "swapRequest",
    requesterName: client.name,
    seatIndex,
  }));
  return;
}

// SWAP ACCEPT
if (data.type === "swapAccept") {
  if (room.phase !== "lobby" || room.seatLock) return;
  const info = seatInfoForHuman(room, client.id);
  if (!info) return;
  const { seatIndex } = info;
  const req = room.swapRequests.get(seatIndex);
  if (!req) return;

  clearTimeout(req.handle);
  room.swapRequests.delete(seatIndex);

  const s = room.seats[seatIndex];
  if (!s.leaderId || !s.advisorId) return;

  const oldLeader = s.leaderId;
  const oldAdvisor = s.advisorId;
  s.leaderId = oldAdvisor;
  s.advisorId = oldLeader;

  const leaderInfo = room.seatByHumanId.get(oldLeader);
  const advisorInfo = room.seatByHumanId.get(oldAdvisor);
  if (leaderInfo) leaderInfo.role = "advisor";
  if (advisorInfo) advisorInfo.role = "leader";

  addLog(room, `${playerNameByHumanId(room, s.leaderId)} and ${playerNameByHumanId(room, s.advisorId)} swapped roles`);
  broadcastState(room);
  return;
}

// SWAP DECLINE
if (data.type === "swapDecline") {
  if (room.phase !== "lobby" || room.seatLock) return;
  const info = seatInfoForHuman(room, client.id);
  if (!info) return;
  const { seatIndex } = info;
  const req = room.swapRequests.get(seatIndex);
  if (!req) return;

  clearTimeout(req.handle);
  room.swapRequests.delete(seatIndex);

  // Notify requester
  const reqWs = room.wsById.get(req.requesterId);
  if (reqWs?.readyState === 1) {
    reqWs.send(JSON.stringify({ type: "swapDeclined", declinerName: client.name }));
  }
  return;
}

// CHAT (lobby + playing, seat members only)
const VALID_CHIPS = new Set(['bluffing', 'trust', 'block', 'target']);

if (data.type === "chat") {
  const info = seatInfoForHuman(room, client.id);
  if (!info) return;
  const chip = VALID_CHIPS.has(data.chip) ? data.chip : null;
  const text = chip ? '' : (data.text || "").toString().trim().slice(0, 200);
  if (!chip && !text) return;
  const { seatIndex } = info;
  const chipTarget = typeof data.chipTarget === 'string' ? data.chipTarget.slice(0, 20) : null;
  const entry = { humanId: client.id, name: client.name, text, chip, chipTarget, t: Date.now() };
  room.seatChats[seatIndex].push(entry);
  if (room.seatChats[seatIndex].length > 50) room.seatChats[seatIndex].shift();
  const seat = room.seats[seatIndex];
  for (const recipId of [seat.leaderId, seat.advisorId].filter(Boolean)) {
    const recipWs = room.wsById.get(recipId);
    if (recipWs && recipWs.readyState === 1) {
      recipWs.send(JSON.stringify({ type: "chatMsg", entry }));
    }
  }
  return;
}

// REACTION (seated players only, broadcast to all in room)
if (data.type === "reaction") {
  const info = seatInfoForHuman(room, client.id);
  if (!info) return;
  const seatId = seatIdForIndex(info.seatIndex);
  const allowed = ["😂","😮","😭","😏","🤥","😎"];
  const emoji = (data.emoji || "").toString().trim();
  if (!allowed.includes(emoji)) return;
  for (const [recipWs] of room.clients.entries()) {
    if (recipWs.readyState === 1) {
      recipWs.send(JSON.stringify({ type: "reaction", seatId, emoji }));
    }
  }
  return;
}

// --- game-only below ---
if (room.phase !== "playing" || !room.game) return;

    if (room.game.gameOver) {
      checkGameOver(room);
      return;
    }
  });

ws.on("close", () => {
  const meta = wsMeta.get(ws);
  if (!meta) return;

  const room = rooms.get(meta.room);
  if (!room) return;

  const client = room.clients.get(ws);
  if (!client) return;

  const humanId = client.id;

  console.log(`[${room.room}] ${humanId} temporarily disconnected.`);

  // Don't delete from room maps yet — allow 30s grace for reconnect.
// If they don't reconnect, the timeout will call removePlayer(room, ws).

  // Start grace timer
  setTimeout(() => {
    const stillConnected = room.wsById.get(humanId);

    // If reconnected → do nothing
    if (stillConnected) return;

    console.log(`[${room.room}] ${humanId} removed after timeout.`);

    // Fully remove player (this handles lobby/game reset properly)
    removePlayer(room, ws);
  }, DISCONNECT_GRACE_MS);
});
});

const PORT = 8080;

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
