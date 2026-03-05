// bot.js
// Algorithmic Coup bot with belief tracking and probability-based decisions.
// Bots are pure server-side — no WebSocket, no client.

// ─── Constants ────────────────────────────────────────────────────────────────

const ROLES = ["Duke", "Assassin", "Captain", "Ambassador", "Contessa"];
const CARDS_PER_ROLE = 4; // standard deck: 4 of each = 20 total

// How much the bot values each role when deciding which card to sacrifice
// Higher = keep it longer
const ROLE_VALUE = {
  Duke:       9,  // tax engine, blocks foreign aid
  Captain:    7,  // steal + block steal
  Assassin:   8,  // kill for 3 coins
  Ambassador: 5,  // exchange + block steal
  Contessa:   6,  // blocks assassination (pure defense)
};

// Bot personality names
export const BOT_NAMES = ["Zayn", "Rumi", "Ayla", "Znlepsn"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomDelay(min = 900, max = 2800) {
  return min + Math.floor(Math.random() * (max - min));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ─── BotPlayer ────────────────────────────────────────────────────────────────

export class BotPlayer {
  constructor(seatId) {
    this.seatId = seatId;

    // Belief system: tracks every role claim made by each player
    // claims[seatId] = [{ role, claimType: "action"|"block", resolved: bool }]
    this.claims = {};

    // Cards we know opponents definitely do NOT have (revealed and lost)
    // revealedBy[seatId] = [role, ...]
    this.revealedBy = {};
  }

  // ── Belief helpers ──────────────────────────────────────────────────────────

  recordClaim(seatId, role, claimType = "action") {
    if (!this.claims[seatId]) this.claims[seatId] = [];
    // Don't double-record the same claim in the same stage
    const existing = this.claims[seatId].find(
      (c) => c.role === role && c.claimType === claimType
    );
    if (!existing) {
      this.claims[seatId].push({ role, claimType });
    }
  }

  updateBeliefs(state) {
    // Sync revealed cards from public state
    for (const p of state.players) {
      this.revealedBy[p.id] = p.influence
        .filter((c) => c.revealed)
        .map((c) => c.role);
    }
  }

  // Probability that `targetId` holds at least one copy of `role`
  // Uses hypergeometric approximation over unknown cards.
  probHasRole(state, targetId, role) {
    if (targetId === this.seatId) return 0; // irrelevant for self

    const myPlayer = state.players.find((p) => p.id === this.seatId);
    const myCards = myPlayer
      ? myPlayer.influence.filter((c) => !c.revealed).map((c) => c.role)
      : [];

    // Copies accounted for: in my hand + revealed by anyone
    let accountedFor = myCards.filter((r) => r === role).length;
    for (const p of state.players) {
      accountedFor += p.influence.filter((c) => c.revealed && c.role === role).length;
    }

    const remainingCopies = Math.max(0, CARDS_PER_ROLE - accountedFor);
    if (remainingCopies === 0) return 0; // impossible

    // Total unknown cards (not mine, not revealed)
    const totalCards = CARDS_PER_ROLE * ROLES.length; // 20
    const totalRevealed = state.players.reduce(
      (sum, p) => sum + p.influence.filter((c) => c.revealed).length,
      0
    );
    const allUnknown = totalCards - totalRevealed - myCards.length;
    if (allUnknown <= 0) return 0;

    const target = state.players.find((p) => p.id === targetId);
    if (!target) return 0;
    const targetUnknown = target.influence.filter((c) => !c.revealed).length;
    if (targetUnknown === 0) return 0;

    // P(at least one of targetUnknown cards is `role`) via hypergeometric
    // P(none) = product of (allUnknown - remainingCopies - k) / (allUnknown - k)
    // for k = 0..targetUnknown-1
    const notRole = allUnknown - remainingCopies;
    let pNone = 1;
    for (let k = 0; k < targetUnknown; k++) {
      const num = notRole - k;
      const den = allUnknown - k;
      if (den <= 0 || num < 0) { pNone = 0; break; }
      pNone *= num / den;
    }

    return clamp(1 - pNone, 0, 1);
  }

  // Should the bot challenge this role claim?
  // More conservative at 1 influence (can't afford to be wrong).
  shouldChallenge(state, claimantId, role) {
    if (claimantId === this.seatId) return false;

    const prob = this.probHasRole(state, claimantId, role);

    // How many influence does the bot have left?
    const myPlayer = state.players.find((p) => p.id === this.seatId);
    const myInf = myPlayer
      ? myPlayer.influence.filter((c) => !c.revealed).length
      : 0;

    // Stricter threshold when we only have 1 card left
    const threshold = myInf <= 1 ? 0.18 : 0.32;

    return prob < threshold;
  }

  // ── State helpers ───────────────────────────────────────────────────────────

  myCards(state) {
    const me = state.players.find((p) => p.id === this.seatId);
    if (!me) return [];
    return me.influence.filter((c) => !c.revealed).map((c) => c.role);
  }

  myInfluenceCount(state) {
    const me = state.players.find((p) => p.id === this.seatId);
    if (!me) return 0;
    return me.influence.filter((c) => !c.revealed).length;
  }

  // ── Target selection ────────────────────────────────────────────────────────

  bestTarget(state, action) {
    const alive = state.players.filter(
      (p) =>
        p.id !== this.seatId && p.influence.some((c) => !c.revealed)
    );
    if (alive.length === 0) return null;

    if (action === "coup" || action === "assassinate") {
      // Prefer players with 1 influence left (cheapest to eliminate)
      // Tiebreak: most coins = most dangerous
      return alive.sort((a, b) => {
        const aInf = a.influence.filter((c) => !c.revealed).length;
        const bInf = b.influence.filter((c) => !c.revealed).length;
        if (aInf !== bInf) return aInf - bInf;
        return b.coins - a.coins;
      })[0].id;
    }

    if (action === "steal") {
      // Richest target that isn't likely to block effectively
      return alive
        .filter((p) => p.coins > 0)
        .sort((a, b) => {
          const aBlockProb =
            this.probHasRole(state, a.id, "Captain") +
            this.probHasRole(state, a.id, "Ambassador");
          const bBlockProb =
            this.probHasRole(state, b.id, "Captain") +
            this.probHasRole(state, b.id, "Ambassador");
          // Penalise likely blockers, reward coin count
          return b.coins - aBlockProb * 4 - (a.coins - bBlockProb * 4);
        })[0]?.id || alive[0].id;
    }

    return alive[0].id;
  }

  // ── Core decisions ──────────────────────────────────────────────────────────

  decideAction(state) {
    const me = state.players.find((p) => p.id === this.seatId);
    if (!me) return { actionType: "income" };

    const cards = this.myCards(state);
    const coins = me.coins;
    const myInf = this.myInfluenceCount(state);
    const alive = state.players.filter((p) =>
      p.id !== this.seatId && p.influence.some((c) => !c.revealed)
    );

    // ── 1. Mandatory coup ──
    if (coins >= 10) {
      return { actionType: "coup", targetId: this.bestTarget(state, "coup") };
    }

    // ── 2. Coup when ready and a 1-card target exists ──
    if (coins >= 7) {
      const target = this.bestTarget(state, "coup");
      const targetPlayer = state.players.find((p) => p.id === target);
      const targetInf = targetPlayer
        ? targetPlayer.influence.filter((c) => !c.revealed).length
        : 2;

      // Always coup a single-influence player
      if (targetInf === 1) {
        return { actionType: "coup", targetId: target };
      }

      // Coup at 8+ coins if we're in a strong position
      if (coins >= 8 && myInf === 2) {
        return { actionType: "coup", targetId: target };
      }
    }

    // ── 3. Assassinate ──
    if (cards.includes("Assassin") && coins >= 3) {
      const target = this.bestTarget(state, "assassinate");
      if (target) return { actionType: "assassinate", targetId: target };
    }

    // ── 4. Tax with Duke (real card) ──
    if (cards.includes("Duke")) {
      return { actionType: "tax" };
    }

    // ── 5. Steal with Captain ──
    if (cards.includes("Captain")) {
      const target = this.bestTarget(state, "steal");
      const targetPlayer = state.players.find((p) => p.id === target);
      if (targetPlayer && targetPlayer.coins >= 2) {
        return { actionType: "steal", targetId: target };
      }
    }

    // ── 6. Exchange with Ambassador when hand is weak ──
    if (cards.includes("Ambassador")) {
      const handValue = cards.reduce((s, r) => s + (ROLE_VALUE[r] || 0), 0);
      if (handValue < 9) return { actionType: "exchange" };
    }

    // ── 7. Bluff Tax if coins are low and it's risky to foreign aid ──
    if (coins <= 3) {
      const dukeRisk = alive.some(
        (p) => this.probHasRole(state, p.id, "Duke") > 0.45
      );
      if (!dukeRisk && Math.random() < 0.35) {
        return { actionType: "tax" }; // bluff Duke
      }
    }

    // ── 8. Bluff Steal occasionally ──
    if (coins <= 4 && alive.length > 0 && Math.random() < 0.25) {
      const richest = [...alive].sort((a, b) => b.coins - a.coins)[0];
      if (richest && richest.coins >= 2) {
        return { actionType: "steal", targetId: richest.id };
      }
    }

    // ── 9. Foreign Aid if Duke presence is low ──
    const highDukePresence = alive.some(
      (p) => this.probHasRole(state, p.id, "Duke") > 0.5
    );
    if (!highDukePresence && coins < 7) {
      return { actionType: "foreign_aid" };
    }

    // ── 10. Safe fallback ──
    return { actionType: "income" };
  }

  decideResponse(state, pending) {
    const myCards = this.myCards(state);
    const myInf = this.myInfluenceCount(state);
    const me = state.players.find((p) => p.id === this.seatId);
    const myCoins = me ? me.coins : 0;

    // ── awaitingChallenge ─────────────────────────────────────────────────────
    if (pending.stage === "awaitingChallenge") {
      const role = pending.claimedRole;
      this.recordClaim(pending.actorId, role, "action");

      if (this.shouldChallenge(state, pending.actorId, role)) {
        return { responseType: "challenge" };
      }
      return { responseType: "pass" };
    }

    // ── awaitingBlock ─────────────────────────────────────────────────────────
    if (pending.stage === "awaitingBlock") {
      // Foreign Aid — anyone can block with Duke
      if (pending.type === "foreign_aid") {
        if (myCards.includes("Duke")) {
          return { responseType: "block", payload: { role: "Duke" } };
        }
        // Bluff Duke block: only if 2 influence and coins don't matter much
        if (myInf >= 2 && Math.random() < 0.18) {
          return { responseType: "block", payload: { role: "Duke" } };
        }
        return { responseType: "pass" };
      }

      // Assassination — only the target responds
      if (pending.type === "assassinate" && pending.targetId === this.seatId) {
        if (myCards.includes("Contessa")) {
          return { responseType: "block", payload: { role: "Contessa" } };
        }
        // Bluff Contessa: more likely at 2 influence, very unlikely at 1
        const bluffChance = myInf >= 2 ? 0.4 : 0.12;
        if (Math.random() < bluffChance) {
          return { responseType: "block", payload: { role: "Contessa" } };
        }
        return { responseType: "pass" };
      }

      // Steal — only the target responds
      if (pending.type === "steal" && pending.targetId === this.seatId) {
        if (myCards.includes("Captain")) {
          return { responseType: "block", payload: { role: "Captain" } };
        }
        if (myCards.includes("Ambassador")) {
          return { responseType: "block", payload: { role: "Ambassador" } };
        }
        // Bluff block if we have enough coins to make it worthwhile
        if (myCoins >= 3 && myInf >= 2 && Math.random() < 0.28) {
          const bluffRole = Math.random() < 0.5 ? "Captain" : "Ambassador";
          return { responseType: "block", payload: { role: bluffRole } };
        }
        return { responseType: "pass" };
      }

      return { responseType: "pass" };
    }

    // ── awaitingChallengeBlock ────────────────────────────────────────────────
    if (pending.stage === "awaitingChallengeBlock") {
      // Determine what role is being claimed for the block
      let blockRole = "Duke"; // default for foreign aid
      if (pending.type === "assassinate") blockRole = "Contessa";
      if (pending.type === "steal") blockRole = pending.blockRole || "Captain";

      this.recordClaim(pending.blockedBy, blockRole, "block");

      // Check if we have proof the blocker is lying
      // (we know their revealed cards, and we know our own cards)
      const myHasRole = myCards.includes(blockRole);
      const myCards_count = myCards.filter((r) => r === blockRole).length;

      // If I hold copies of that role myself, blocker is more likely lying
      let effectiveProb = this.probHasRole(state, pending.blockedBy, blockRole);

      // Adjust: if I personally hold 2 copies, blockers chance drops significantly
      if (myCards_count >= 2) effectiveProb *= 0.4;
      else if (myCards_count === 1) effectiveProb *= 0.75;

      const myInf2 = this.myInfluenceCount(state);
      const threshold = myInf2 <= 1 ? 0.15 : 0.3;

      if (effectiveProb < threshold) {
        return { responseType: "challenge" };
      }
      return { responseType: "pass" };
    }

    return { responseType: "pass" };
  }

  decideLoseInfluence(state) {
    const me = state.players.find((p) => p.id === this.seatId);
    if (!me) return { cardIndex: 0 };

    const aliveCards = me.influence
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !c.revealed);

    if (aliveCards.length === 0) return { cardIndex: 0 };
    if (aliveCards.length === 1) return { cardIndex: aliveCards[0].i };

    // Lose the lowest-value card
    aliveCards.sort(
      (a, b) => (ROLE_VALUE[a.c.role] || 0) - (ROLE_VALUE[b.c.role] || 0)
    );
    return { cardIndex: aliveCards[0].i };
  }

  decideExchange(options, keepCount) {
    // Keep the highest-value roles
    const sorted = [...options].sort(
      (a, b) => (ROLE_VALUE[b.role] || 0) - (ROLE_VALUE[a.role] || 0)
    );
    return sorted.slice(0, keepCount).map((o) => o.id);
  }
}

// ─── Bot tick (called from server after every state change) ───────────────────

export function botTick(room, { resolveAction, handleResponse, broadcastState, applyPrivates }) {
  if (room.phase !== "playing" || !room.game) return;
  if (room.game.gameOver) return;
  if (!room.bots || room.bots.size === 0) return;

  const game = room.game;
  const pending = game.pendingAction;

  // ── No pending action: is it a bot's turn? ───────────────────────────────
  if (!pending) {
    const current = game.currentPlayer();
    if (!current) return;

    const bot = room.bots.get(current.id);
    if (!bot) return;

    setTimeout(() => {
      if (room.phase !== "playing" || !room.game) return;
      if (room.game.pendingAction) return;
      if (room.game.currentPlayer()?.id !== current.id) return;

      const state = room.game.getStateFor(bot.seatId);
      bot.updateBeliefs(state);
      const decision = bot.decideAction(state);

      const result = resolveAction(room.game, {
        actorId: bot.seatId,
        actionType: decision.actionType,
        targetId: decision.targetId || null,
      });

      broadcastState(room);
      applyPrivates(room, result);
      botTick(room, { resolveAction, handleResponse, broadcastState, applyPrivates });
    }, randomDelay(1400, 3600));
    return;
  }

  // ── Lose influence: is the affected seat a bot? ──────────────────────────
  if (pending.type === "loseInfluence") {
    const bot = room.bots.get(pending.playerId);
    if (!bot) return;

    const snapType = pending.type;
    const snapPlayer = pending.playerId;
    setTimeout(() => {
      if (room.phase !== "playing" || !room.game) return;
      const p = room.game.pendingAction;
      if (!p || p.type !== snapType || p.playerId !== snapPlayer) return;

      const state = room.game.getStateFor(bot.seatId);
      const decision = bot.decideLoseInfluence(state);

      const result = handleResponse(room.game, {
        playerId: bot.seatId,
        responseType: "loseInfluence",
        payload: { cardIndex: decision.cardIndex },
      });

      broadcastState(room);
      applyPrivates(room, result);
      botTick(room, { resolveAction, handleResponse, broadcastState, applyPrivates });
    }, randomDelay());
    return;
  }

  // ── Exchange choice: is the actor a bot? ─────────────────────────────────
  if (pending.type === "exchange" && pending.stage === "awaitingChoice") {
    const bot = room.bots.get(pending.actorId);
    if (!bot) return;

    const snapActor = pending.actorId;
    setTimeout(() => {
      if (room.phase !== "playing" || !room.game) return;
      const p = room.game.pendingAction;
      if (!p || p.type !== "exchange" || p.stage !== "awaitingChoice") return;
      if (p.actorId !== snapActor) return;

      const secret = room.game._private.exchange.get(bot.seatId);
      if (!secret) return;

      const keep = bot.decideExchange(secret.options, secret.keepCount);

      const result = handleResponse(room.game, {
        playerId: bot.seatId,
        responseType: "exchangeChoice",
        payload: { keep },
      });

      broadcastState(room);
      applyPrivates(room, result);
      botTick(room, { resolveAction, handleResponse, broadcastState, applyPrivates });
    }, randomDelay());
    return;
  }

  // ── Responders: schedule each pending bot responder ──────────────────────
  if (pending.responders) {
    for (const [seatId, status] of Object.entries(pending.responders)) {
      if (status !== "pending") continue;

      const bot = room.bots.get(seatId);
      if (!bot) continue;

      scheduleBotResponse(room, bot, pending, {
        resolveAction,
        handleResponse,
        broadcastState,
        applyPrivates,
      });
    }
  }
}

function scheduleBotResponse(room, bot, pendingSnapshot, fns) {
  const { resolveAction, handleResponse, broadcastState, applyPrivates } = fns;

  const snapType = pendingSnapshot.type;
  const snapStage = pendingSnapshot.stage;
  const snapActorId = pendingSnapshot.actorId;

  // Base delay for all bot reactions
  let delay = randomDelay();

  // For challenge windows, give humans extra time before bots react.
  // Only add the extra delay if there is at least one human responder.
  if (snapStage === "awaitingChallenge" || snapStage === "awaitingChallengeBlock") {
    const responders = pendingSnapshot.responders || {};
    const hasHumanResponder = Object.keys(responders).some(
      (seatId) => !room.bots?.has(seatId)
    );
    if (hasHumanResponder) {
      delay += 10000; // extra 10s window for humans
    }
  }

  setTimeout(() => {
    if (room.phase !== "playing" || !room.game) return;

    const pending = room.game.pendingAction;
    if (!pending) return;

    // Make sure the same action is still active
    if (pending.type !== snapType || pending.stage !== snapStage) return;
    if (pending.actorId !== snapActorId) return;

    // Make sure this bot is still a pending responder
    if (!pending.responders || !(bot.seatId in pending.responders)) return;
    if (pending.responders[bot.seatId] !== "pending") return;

    const state = room.game.getStateFor(bot.seatId);
    bot.updateBeliefs(state);
    const decision = bot.decideResponse(state, pending);

    const result = handleResponse(room.game, {
      playerId: bot.seatId,
      responseType: decision.responseType,
      payload: decision.payload || {},
    });

    broadcastState(room);
    applyPrivates(room, result);
    botTick(room, { resolveAction, handleResponse, broadcastState, applyPrivates });
  }, delay);
}
