// server.js
import { WebSocketServer } from "ws";
import { GameEngine } from "./gameEngine.js";
import { resolveAction, handleResponse } from "./actionResolver.js";

const wss = new WebSocketServer({ port: 8080 });

const MAX_PLAYERS = 8;

// --- Rooms ---
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
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "error", code, message }));
    }
  } catch {}
}

function getOrCreateRoom(roomCode) {
  let r = rooms.get(roomCode);
  if (!r) {
    r = {
      room: roomCode,
      // Map ws -> {id,name}
      clients: new Map(),
      // Map id -> ws  (helps reconnect + prevents duplicate same-id)
      wsById: new Map(),
      joinOrder: [],
      hostId: null,
      phase: "lobby", // "lobby" | "playing" | "ended"
      game: null,
    };
    rooms.set(roomCode, r);
  }
  return r;
}

function ensureHost(room) {
  if (room.hostId && room.joinOrder.includes(room.hostId)) return;
  room.hostId = room.joinOrder[0] || null;
}

function lobbyStateFor(room, viewerId) {
  return {
    phase: "lobby",
    hostId: room.hostId,
    turnPlayerId: null,
    pendingAction: null,
    log: [`Lobby (${room.joinOrder.length}/${MAX_PLAYERS}) – host must start.`],
    players: room.joinOrder
      .map((id) => {
        // find by id from room.clients
        const entry = Array.from(room.clients.values()).find((c) => c.id === id);
        return entry
          ? {
              id: entry.id,
              name: entry.name,
              coins: 0,
              alive: true,
              influence: [
                { role: "?", revealed: false },
                { role: "?", revealed: false },
              ],
            }
          : null;
      })
      .filter(Boolean),
    youId: viewerId,
  };
}

function stateForClient(room, clientId) {
  if ((room.phase === "playing" || room.phase === "ended") && room.game) {
    const s = room.game.getStateFor(clientId);
    if (room.game.gameOver) room.phase = "ended";
    s.phase = room.phase;
    s.hostId = room.hostId;
    return s;
  }
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
  const ws = room.wsById.get(playerId);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msgObj));
  }
}

function applyPrivates(room, result) {
  const privates = result?.privates || [];
  for (const p of privates) sendToPlayer(room, p.to, p.msg);
}

function resetToLobby(room, reason) {
  room.phase = "lobby";
  room.game = null;
  if (reason) console.log(`[${room.room}] ${reason}`);
  ensureHost(room);
  broadcastState(room);
}

function removePlayer(room, ws) {
  const client = room.clients.get(ws);
  if (!client) return;

  room.clients.delete(ws);
  wsMeta.delete(ws);

  // Only delete wsById if it points to THIS ws
  const currentWs = room.wsById.get(client.id);
  if (currentWs === ws) room.wsById.delete(client.id);

  room.joinOrder = room.joinOrder.filter((id) => id !== client.id);
  ensureHost(room);

  if (room.phase === "playing" || room.phase === "ended") {
    resetToLobby(room, "A player left during the game. Returning to lobby.");
  } else {
    broadcastState(room);
  }

  // If room empty, clean it up
  if (room.joinOrder.length === 0 && room.clients.size === 0) {
    rooms.delete(room.room);
  }
}

function startGameFromJoinOrder(room) {
  const players = room.joinOrder
    .map((id) => Array.from(room.clients.values()).find((c) => c.id === id))
    .filter(Boolean)
    .map((c) => ({ id: c.id, name: c.name }));

  // Extra guard (should never happen now, but prevents crashes)
  if (players.length > MAX_PLAYERS) {
    console.log(`[${room.room}] Tried to start with ${players.length} players (max ${MAX_PLAYERS}).`);
    room.phase = "lobby";
    room.game = null;
    ensureHost(room);
    broadcastState(room);
    return;
  }

  try {
    room.game = new GameEngine(players);
    room.phase = "playing";
    broadcastState(room);
  } catch (err) {
    console.log(`[${room.room}] startGame failed:`, err?.message || err);

    // Reset cleanly to lobby instead of crashing the process
    room.phase = "lobby";
    room.game = null;
    ensureHost(room);

    // Optional: tell host what happened
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
        const isRejoin =
          existing.joinOrder.includes(id) || existing.wsById.has(id);

        if (!isRejoin && existing.joinOrder.length >= MAX_PLAYERS) {
          sendError(
            ws,
            "ROOM_FULL",
            `Lobby is full (${existing.joinOrder.length}/${MAX_PLAYERS}).`
          );
          try {
            ws.close(1008, "Room full");
          } catch {}
          return;
        }

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
        // defensive detach now:
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

      if ((room.phase === "playing" || room.phase === "ended") && room.game) {
        const p = room.game.getPlayer(client.id);
        if (p) p.name = newName;
      }

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
    if (data.type === "startGame") {
      if (room.phase !== "lobby") return;
      if (client.id !== room.hostId) return;
      if (room.joinOrder.length < 2) return;

      startGameFromJoinOrder(room);
      return;
    }

    // REMATCH
    if (data.type === "rematch") {
      if (room.phase !== "ended") return;
      if (client.id !== room.hostId) return;
      if (room.joinOrder.length < 2) return;

      startGameFromJoinOrder(room);
      return;
    }

    if (room.phase !== "playing" || !room.game) return;

    if (room.game.gameOver) {
      room.phase = "ended";
      broadcastState(room);
      return;
    }

    // ACTION
    if (data.type === "action") {
      const current = room.game.currentPlayer();
      if (!current || current.id !== client.id) return;
      if (room.game.pendingAction) return;

      const result = resolveAction(room.game, {
        actorId: client.id,
        actionType: data.actionType,
        targetId: data.targetId || null,
      });

      if (room.game.gameOver) room.phase = "ended";

      broadcastState(room);
      applyPrivates(room, result);
      return;
    }

    // RESPONSE
    if (data.type === "response") {
      const result = handleResponse(room.game, {
        playerId: client.id,
        responseType: data.responseType,
        payload: data.payload || {},
      });

      if (room.game.gameOver) room.phase = "ended";

      broadcastState(room);
      applyPrivates(room, result);
      return;
    }
  });

  ws.on("close", () => {
    const meta = wsMeta.get(ws);
    if (!meta) return;
    const room = rooms.get(meta.room);
    if (!room) return;
    removePlayer(room, ws);
  });
});

console.log("Coup server running on ws://127.0.0.1:8080");
