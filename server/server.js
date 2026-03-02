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
    broadcastState: (r) => broadcastState(r),
    applyPrivates:  (r, result) => applyPrivates(r, result),
  };
}

const MAX_LOBBY_PLAYERS = 8;
const SEAT_COUNT = 4;
const DISCONNECT_GRACE_MS = 30000; // 30 seconds

const app = express();
app.use(express.static("../"));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// rooms: roomCode -> roomState
const rooms = new Map();

// wsMeta: ws -> { room, id }
const wsMeta = new Map();

function sanitizeName(name) {
  return (name || "").toString().trim().slice(0, 24);
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

// optional debug/log
log: [],

// bots: Map seatId -> BotPlayer  (e.g. "S1" -> BotPlayer)
bots: new Map(),
// botClients: Map botHumanId -> { id, name }  (name lookup, no ws)
botClients: new Map(),
// track how many bots have been added (for names)
botCount: 0,
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
    return c ? { id: c.id, name: c.name } : null;
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
    log: [`Lobby (${room.joinOrder.length}/${MAX_LOBBY_PLAYERS}) – host must start.`],
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
  };
}

function stateForClient(room, clientId) {
  // playing/ended
  if ((room.phase === "playing" || room.phase === "ended") && room.game) {
    const youSeatId = seatIdForHuman(room, clientId); // S1..S4 or null if spectator

    // spectator view: use a non-existent id (engine should hide all private info)
    const viewerKey = youSeatId || "SPECTATOR";

    const s = room.game.getStateFor(viewerKey);

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

    if (room.game.gameOver) room.phase = "ended";
    s.phase = room.phase;
    s.hostId = room.hostId;

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

function resetToLobby(room, reason) {
  room.phase = "lobby";
  room.game = null;

  // unlock seating, keep 4 seats but clear occupants
  room.seatLock = false;
  room.seats = room.seats?.length === SEAT_COUNT ? room.seats : makeEmptySeats();
  for (const s of room.seats) {
    s.leaderId = null;
    s.advisorId = null;
  }
  room.seatByHumanId = new Map();

  if (reason) console.log(`[${room.room}] ${reason}`);
  ensureHost(room);
  broadcastState(room);
}

function removePlayer(room, ws) {
  const client = room.clients.get(ws);
  if (!client) return;

  // unseat them if seated
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
    resetToLobby(room, "A player left during the game. Returning to lobby.");
  } else {
    broadcastState(room);
  }

  // If room empty, clean it up
  if (room.joinOrder.length === 0 && room.clients.size === 0) rooms.delete(room.room);
}

function startGameFromSeats(room) {
  // Must have at least 2 occupied seats (by leader) to start
  const occupiedSeatIndexes = [];
  for (let i = 0; i < SEAT_COUNT; i++) {
    if (room.seats[i].leaderId) occupiedSeatIndexes.push(i);
  }
  if (occupiedSeatIndexes.length < 2) return;

  // lock seating
  room.seatLock = true;

  // Build <=4 engine players (seats are the players)
  const seatPlayers = occupiedSeatIndexes.map((seatIndex) => ({
    id: seatIdForIndex(seatIndex), // S1..S4
    name: seatDisplayName(room, seatIndex),
  }));

  console.log("ENGINE PLAYERS:", seatPlayers);

  try {
    room.game = new GameEngine(seatPlayers);
    room.phase = "playing";
    broadcastState(room);
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
      const room = existing || getOrCreateRoom(roomCode);

      const name = sanitizeName(data.name) || "Player";

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

      if (!room.joinOrder.includes(id)) room.joinOrder.push(id);
      if (!room.hostId) room.hostId = id;

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
      if (role === "leader") s.leaderId = client.id;
      else s.advisorId = client.id;

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

    // KICK (host only, lobby + playing)
if (data.type === "kick") {
  if (client.id !== room.hostId) return;

  const targetId = data.targetId;
  const targetWs = room.wsById.get(targetId);
  if (!targetWs) return;

  console.log(`[${room.room}] ${targetId} kicked by host.`);

  removePlayer(room, targetWs);
  try { targetWs.close(); } catch {}

  return;
}

// ADD BOT (host only, lobby only)
if (data.type === "addBot") {
  if (room.phase !== "lobby" || room.seatLock) return;
  if (client.id !== room.hostId) return;

  // Find a free leader slot
  const emptySlot = room.seats.findIndex((s) => !s.leaderId);
  if (emptySlot === -1) return; // all seats taken

  const botCount = (room.botCount || 0);
  const botName = BOT_NAMES[botCount % BOT_NAMES.length];
  const botId   = `bot-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

  room.botCount = botCount + 1;

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

  // Remove the last added bot
  let removed = false;
  for (let i = SEAT_COUNT - 1; i >= 0; i--) {
    const leaderId = room.seats[i].leaderId;
    if (leaderId && leaderId.startsWith("bot-")) {
      room.seats[i].leaderId = null;
      room.seatByHumanId.delete(leaderId);
      room.joinOrder = room.joinOrder.filter((id) => id !== leaderId);
      room.botClients.delete(leaderId);
      const seatId = seatIdForIndex(i);
      room.bots.delete(seatId);
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

  if (room.game.gameOver) room.phase = "ended";
  broadcastState(room);
  applyPrivates(room, result);
  botTick(room, makeBotFns(room));
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

  if (room.game.gameOver) room.phase = "ended";
  broadcastState(room);
  applyPrivates(room, result);
  botTick(room, makeBotFns(room));
  return;
}

    // k === "target" is UI-only for now
    broadcastState(room);
    return;
  }
}

    // --- game-only below ---
    if (room.phase !== "playing" || !room.game) return;

    if (room.game.gameOver) {
      room.phase = "ended";
      broadcastState(room);
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