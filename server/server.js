import { WebSocketServer } from "ws";
import { GameEngine } from "./gameEngine.js";
import { resolveAction, handleResponse } from "./actionResolver.js";

const wss = new WebSocketServer({ port: 8080 });

const clients = new Map(); // ws -> {id,name}
let joinOrder = []; // playerId[] (lobby order)
let hostId = null;

let phase = "lobby"; // "lobby" | "playing"
let game = null;

function sanitizeName(name) {
  return (name || "").toString().trim().slice(0, 24);
}

function lobbyStateFor(viewerId) {
  return {
    phase: "lobby",
    hostId,
    turnPlayerId: null,
    pendingAction: null,
    log: ["Lobby: host must start the game."],
    players: joinOrder
      .map((id) => {
        const entry = Array.from(clients.values()).find((c) => c.id === id);
        return entry ? { id: entry.id, name: entry.name } : null;
      })
      .filter(Boolean)
      .map((p) => ({
        id: p.id,
        name: p.name,
        coins: 0,
        alive: true,
        influence: [{ role: "?", revealed: false }, { role: "?", revealed: false }],
      })),
    youId: viewerId,
  };
}

function stateForClient(clientId) {
  if (phase === "playing" && game) {
    const s = game.getStateFor(clientId);
    s.phase = "playing";
    s.hostId = hostId;
    return s;
  }
  return lobbyStateFor(clientId);
}

function broadcastState() {
  for (const [ws, c] of clients.entries()) {
    if (ws.readyState !== 1) continue;
    ws.send(JSON.stringify({ type: "state", state: stateForClient(c.id) }));
  }
}

function sendToPlayer(playerId, msgObj) {
  const msg = JSON.stringify(msgObj);
  for (const [ws, c] of clients.entries()) {
    if (c.id === playerId && ws.readyState === 1) ws.send(msg);
  }
}

function applyPrivates(result) {
  const privates = result?.privates || [];
  for (const p of privates) sendToPlayer(p.to, p.msg);
}

function ensureHost() {
  if (hostId && joinOrder.includes(hostId)) return;
  hostId = joinOrder[0] || null;
}

function resetToLobby(reason) {
  phase = "lobby";
  game = null;
  if (reason) {
    // optional: could stash a lobby message later; keeping simple.
    console.log(reason);
  }
  ensureHost();
  broadcastState();
}

function removePlayerByWs(ws) {
  const client = clients.get(ws);
  if (!client) return;

  clients.delete(ws);
  joinOrder = joinOrder.filter((id) => id !== client.id);
  ensureHost();

  // If someone leaves mid-game, simplest dev behavior: end and return to lobby.
  if (phase === "playing") {
    resetToLobby("A player left during the game. Returning to lobby.");
  } else {
    broadcastState();
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

    // JOIN
    if (data.type === "join") {
      const id = data.id;
      const name = sanitizeName(data.name) || "Player";

      clients.set(ws, { id, name });

      if (!joinOrder.includes(id)) joinOrder.push(id);
      if (!hostId) hostId = id;

      broadcastState();
      return;
    }

    const client = clients.get(ws);
    if (!client) return;

    // RENAME (allowed anytime)
    if (data.type === "rename") {
      const newName = sanitizeName(data.name);
      if (!newName) return;

      client.name = newName;
      clients.set(ws, client);

      if (phase === "playing" && game) {
        const p = game.getPlayer(client.id);
        if (p) p.name = newName;
      }

      broadcastState();
      return;
    }

    // LEAVE (explicit)
    if (data.type === "leave") {
      removePlayerByWs(ws);
      try { ws.close(); } catch {}
      return;
    }

    // START GAME (host only, lobby only)
    if (data.type === "startGame") {
      if (phase !== "lobby") return;
      if (client.id !== hostId) return;
      if (joinOrder.length < 2) return;

      const players = joinOrder
        .map((id) => Array.from(clients.values()).find((c) => c.id === id))
        .filter(Boolean)
        .map((c) => ({ id: c.id, name: c.name }));

      game = new GameEngine(players);
      phase = "playing";
      broadcastState();
      return;
    }

    if (phase !== "playing" || !game) return;

    // ACTION
    if (data.type === "action") {
      const current = game.currentPlayer();
      if (!current || current.id !== client.id) return;
      if (game.pendingAction) return;

      const result = resolveAction(game, {
        actorId: client.id,
        actionType: data.actionType,
        targetId: data.targetId || null,
      });

      broadcastState();
      applyPrivates(result);
      return;
    }

    // RESPONSE
    if (data.type === "response") {
      const result = handleResponse(game, {
        playerId: client.id,
        responseType: data.responseType,
        payload: data.payload || {},
      });

      broadcastState();
      applyPrivates(result);
      return;
    }
  });

  ws.on("close", () => {
    removePlayerByWs(ws);
  });
});

console.log("Coup server running on ws://127.0.0.1:8080");