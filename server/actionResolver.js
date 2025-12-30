// actionResolver.js
// Engine-first state machine. Server forwards payload as-is.

function initResponders(game, excludeId) {
  const responders = {};
  for (const p of game.players) {
    if (p.id === excludeId) continue;
    if (!game.isAlive(p.id)) continue;
    responders[p.id] = "pending"; // "pending" | "passed" | "challenged"
  }
  return responders;
}

function everyonePassed(responders) {
  return Object.values(responders || {}).every((v) => v === "passed");
}

function firstChallenger(responders) {
  const entry = Object.entries(responders || {}).find(([, v]) => v === "challenged");
  return entry ? entry[0] : null;
}

function finishTurn(game) {
  game.pendingAction = null;
  game.nextTurn();
  return { state: game.getPublicState(), privates: [] };
}

function beginLoseInfluence(game, { playerId, reason, continuation }) {
  game.pendingAction = {
    type: "loseInfluence",
    stage: "awaitingChoice",
    playerId,
    reason,
    continuation: continuation || { type: "endTurn" },
  };
}

function applySteal(game, actorId, targetId) {
  const actor = game.getPlayer(actorId);
  const target = game.getPlayer(targetId);
  if (!actor || !target) return;
  const amt = Math.min(2, target.coins);
  target.coins -= amt;
  actor.coins += amt;
  game.log.push(`${actor.name} steals ${amt} coin(s) from ${target.name}.`);
}

function startExchangeChoice(game, actorId) {
  const actor = game.getPlayer(actorId);
  if (!actor) return { state: game.getPublicState(), privates: [] };

  const handIdx = actor.influence
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !c.revealed)
    .map(({ i }) => i);

  const keepCount = handIdx.length;
  if (keepCount === 0) return finishTurn(game);

  const options = [];
  let seq = 0;

  // existing (unrevealed) hand
  for (const i of handIdx) {
    options.push({ id: `h${seq++}`, role: actor.influence[i].role, source: "hand", handIndex: i });
  }

  // draw 2
  const d1 = game.draw();
  const d2 = game.draw();
  options.push({ id: `d${seq++}`, role: d1, source: "drawn" });
  options.push({ id: `d${seq++}`, role: d2, source: "drawn" });

  // store secret actor-only options
  game._private.exchange.set(actorId, { keepCount, options });

  // public stage
  game.pendingAction = {
    type: "exchange",
    stage: "awaitingChoice",
    actorId,
    keepCount,
  };

  return {
    state: game.getPublicState(),
    privates: [
      {
        to: actorId,
        msg: {
          type: "private",
          kind: "exchangeOptions",
          keepCount,
          options: options.map(({ id, role }) => ({ id, role })),
        },
      },
    ],
  };
}

function continueAfterLoseInfluence(game, cont) {
  if (!cont || cont.type === "endTurn") return finishTurn(game);

  // --- Assassin continuations ---
  if (cont.type === "assassinate_open_block") {
    game.pendingAction = {
      type: "assassinate",
      stage: "awaitingBlock",
      actorId: cont.actorId,
      targetId: cont.targetId,
      claimedRole: "Assassin",
      blockedBy: null,
      responders: { [cont.targetId]: "pending" }, // only target responds
    };
    return { state: game.getPublicState(), privates: [] };
  }

  if (cont.type === "assassinate_block_stands") {
    game.log.push(`Assassination is blocked.`);
    return finishTurn(game);
  }

  if (cont.type === "assassinate_force_target_loss") {
    beginLoseInfluence(game, {
      playerId: cont.targetId,
      reason: "assassinated",
      continuation: { type: "endTurn_after_assassination", targetId: cont.targetId },
    });
    return { state: game.getPublicState(), privates: [] };
  }

  if (cont.type === "endTurn_after_assassination") {
    const target = game.getPlayer(cont.targetId);
    if (target) game.log.push(`${target.name} is assassinated.`);
    return finishTurn(game);
  }

  // --- Steal continuations ---
  if (cont.type === "steal_open_block") {
    game.pendingAction = {
      type: "steal",
      stage: "awaitingBlock",
      actorId: cont.actorId,
      targetId: cont.targetId,
      claimedRole: "Captain",
      blockedBy: null,
      responders: { [cont.targetId]: "pending" }, // only target responds
    };
    return { state: game.getPublicState(), privates: [] };
  }

  if (cont.type === "steal_apply") {
    applySteal(game, cont.actorId, cont.targetId);
    return finishTurn(game);
  }

  if (cont.type === "steal_block_stands") {
    game.log.push(`Steal is blocked.`);
    return finishTurn(game);
  }

  if (cont.type === "steal_apply_after_block_fail") {
    applySteal(game, cont.actorId, cont.targetId);
    return finishTurn(game);
  }

  // --- Exchange continuations ---
  if (cont.type === "exchange_start_choice") {
    return startExchangeChoice(game, cont.actorId);
  }

  return finishTurn(game);
}

export function resolveAction(game, { actorId, actionType, targetId }) {
  const actor = game.getPlayer(actorId);
  if (!actor) return { state: game.getPublicState(), privates: [] };

  // Mandatory Coup rule: if you have 10+ coins, you must Coup.
  if (actionType !== "coup" && actor.coins >= 10) {
    game.log.push(`${actor.name} has 10+ coins and must Coup.`);
    return { state: game.getPublicState(), privates: [] };
  }

  switch (actionType) {
    case "income": {
      actor.coins += 1;
      game.log.push(`${actor.name} takes Income (+1).`);
      return finishTurn(game);
    }

    case "coup": {
      const target = game.getPlayer(targetId);
      if (!target || !game.isAlive(target.id)) {
        game.log.push(`Invalid Coup target.`);
        return { state: game.getPublicState(), privates: [] };
      }
      if (actor.coins < 7) {
        game.log.push(`${actor.name} cannot Coup (needs 7 coins).`);
        return { state: game.getPublicState(), privates: [] };
      }
      actor.coins -= 7;
      game.log.push(`${actor.name} launches a Coup on ${target.name} (7 coins).`);

      beginLoseInfluence(game, {
        playerId: target.id,
        reason: "coup",
        continuation: { type: "endTurn" },
      });
      return { state: game.getPublicState(), privates: [] };
    }

    case "foreign_aid": {
      actor.coins += 2; // tentative (undo if blocked)
      game.log.push(`${actor.name} attempts Foreign Aid (+2).`);

      game.pendingAction = {
        type: "foreign_aid",
        stage: "awaitingBlock",
        actorId,
        responders: initResponders(game, actorId),
        blockedBy: null,
      };
      return { state: game.getPublicState(), privates: [] };
    }

    case "tax": {
      game.log.push(`${actor.name} claims Duke for Tax (+3).`);
      game.pendingAction = {
        type: "tax",
        stage: "awaitingChallenge",
        actorId,
        claimedRole: "Duke",
        responders: initResponders(game, actorId),
      };
      return { state: game.getPublicState(), privates: [] };
    }

    case "assassinate": {
      const target = game.getPlayer(targetId);
      if (!target || !game.isAlive(target.id) || target.id === actorId) {
        game.log.push(`Invalid Assassination target.`);
        return { state: game.getPublicState(), privates: [] };
      }
      if (actor.coins < 3) {
        game.log.push(`${actor.name} cannot Assassinate (needs 3 coins).`);
        return { state: game.getPublicState(), privates: [] };
      }

      actor.coins -= 3;
      game.log.push(`${actor.name} claims Assassin to assassinate ${target.name} (3 coins).`);

      game.pendingAction = {
        type: "assassinate",
        stage: "awaitingChallenge",
        actorId,
        targetId: target.id,
        claimedRole: "Assassin",
        blockedBy: null,
        responders: initResponders(game, actorId),
      };
      return { state: game.getPublicState(), privates: [] };
    }

    case "steal": {
      const target = game.getPlayer(targetId);
      if (!target || !game.isAlive(target.id) || target.id === actorId) {
        game.log.push(`Invalid Steal target.`);
        return { state: game.getPublicState(), privates: [] };
      }

      game.log.push(`${actor.name} claims Captain to steal from ${target.name}.`);
      game.pendingAction = {
        type: "steal",
        stage: "awaitingChallenge", // challenge Captain claim
        actorId,
        targetId: target.id,
        claimedRole: "Captain",
        blockedBy: null,
        blockRole: null,
        responders: initResponders(game, actorId),
      };
      return { state: game.getPublicState(), privates: [] };
    }

    case "exchange": {
      game.log.push(`${actor.name} claims Ambassador to Exchange.`);
      game.pendingAction = {
        type: "exchange",
        stage: "awaitingChallenge",
        actorId,
        claimedRole: "Ambassador",
        responders: initResponders(game, actorId),
      };
      return { state: game.getPublicState(), privates: [] };
    }

    default:
      game.log.push(`Unknown action: ${actionType}`);
      return { state: game.getPublicState(), privates: [] };
  }
}

export function handleResponse(game, { playerId, responseType, payload }) {
  const pending = game.pendingAction;
  if (!pending) return { state: game.getPublicState(), privates: [] };

  // 1) Lose influence choice
  if (pending.type === "loseInfluence") {
    if (playerId !== pending.playerId) return { state: game.getPublicState(), privates: [] };
    if (responseType !== "loseInfluence") return { state: game.getPublicState(), privates: [] };

    const idx = payload?.cardIndex;
    const ok = game.loseInfluence(playerId, idx);
    if (!ok) return { state: game.getPublicState(), privates: [] };

    const cont = pending.continuation;
    game.pendingAction = null;
    return continueAfterLoseInfluence(game, cont);
  }

  // 2) Tax (Duke)
  if (pending.type === "tax" && pending.stage === "awaitingChallenge") {
    if (!(playerId in pending.responders)) return { state: game.getPublicState(), privates: [] };

    if (responseType === "pass") pending.responders[playerId] = "passed";
    else if (responseType === "challenge") pending.responders[playerId] = "challenged";
    else return { state: game.getPublicState(), privates: [] };

    const challengerId = firstChallenger(pending.responders);
    if (challengerId) {
      const actorHas = game.playerHasRole(pending.actorId, "Duke");
      const actor = game.getPlayer(pending.actorId);
      const challenger = game.getPlayer(challengerId);

      if (actorHas) {
        game.log.push(`${challenger.name} challenges — FAILED.`);
        game.revealAndRedraw(pending.actorId, "Duke");

        actor.coins += 3;
        game.log.push(`${actor.name} takes Tax (+3).`);

        beginLoseInfluence(game, {
          playerId: challengerId,
          reason: "failed_challenge",
          continuation: { type: "endTurn" },
        });
        return { state: game.getPublicState(), privates: [] };
      } else {
        game.log.push(`${challenger.name} challenges — SUCCESS.`);
        game.log.push(`Tax fails.`);

        beginLoseInfluence(game, {
          playerId: pending.actorId,
          reason: "lost_challenge",
          continuation: { type: "endTurn" },
        });
        return { state: game.getPublicState(), privates: [] };
      }
    }

    if (everyonePassed(pending.responders)) {
      const actor = game.getPlayer(pending.actorId);
      actor.coins += 3;
      game.log.push(`${actor.name} takes Tax (+3).`);
      return finishTurn(game);
    }

    return { state: game.getPublicState(), privates: [] };
  }

  // 3) Foreign Aid
  if (pending.type === "foreign_aid") {
    const actor = game.getPlayer(pending.actorId);

    if (pending.stage === "awaitingBlock") {
      if (!(playerId in pending.responders)) return { state: game.getPublicState(), privates: [] };

      if (responseType === "pass") {
        pending.responders[playerId] = "passed";
      } else if (responseType === "block" && payload?.role === "Duke") {
        pending.blockedBy = playerId;
        pending.stage = "awaitingChallengeBlock";
        pending.responders = initResponders(game, pending.blockedBy);
        game.log.push(`${game.getPlayer(playerId).name} blocks Foreign Aid with Duke.`);
        return { state: game.getPublicState(), privates: [] };
      } else {
        return { state: game.getPublicState(), privates: [] };
      }

      if (everyonePassed(pending.responders)) {
        game.log.push(`Foreign Aid succeeds.`);
        return finishTurn(game);
      }
      return { state: game.getPublicState(), privates: [] };
    }

    if (pending.stage === "awaitingChallengeBlock") {
      if (!(playerId in pending.responders)) return { state: game.getPublicState(), privates: [] };

      if (responseType === "pass") pending.responders[playerId] = "passed";
      else if (responseType === "challenge") pending.responders[playerId] = "challenged";
      else return { state: game.getPublicState(), privates: [] };

      const challengerId = firstChallenger(pending.responders);
      if (challengerId) {
        const blockerId = pending.blockedBy;
        const blockerHas = game.playerHasRole(blockerId, "Duke");
        const blocker = game.getPlayer(blockerId);
        const challenger = game.getPlayer(challengerId);

        if (blockerHas) {
          game.log.push(`${challenger.name} challenges block — FAILED.`);
          game.revealAndRedraw(blockerId, "Duke");

          actor.coins -= 2;
          game.log.push(`Foreign Aid is blocked.`);

          beginLoseInfluence(game, {
            playerId: challengerId,
            reason: "failed_challenge",
            continuation: { type: "endTurn" },
          });
          return { state: game.getPublicState(), privates: [] };
        } else {
          game.log.push(`${challenger.name} challenges block — SUCCESS.`);
          game.log.push(`Block fails. Foreign Aid succeeds.`);

          beginLoseInfluence(game, {
            playerId: blockerId,
            reason: "lost_challenge",
            continuation: { type: "endTurn" },
          });
          return { state: game.getPublicState(), privates: [] };
        }
      }

      if (everyonePassed(pending.responders)) {
        actor.coins -= 2;
        game.log.push(`Foreign Aid is blocked.`);
        return finishTurn(game);
      }

      return { state: game.getPublicState(), privates: [] };
    }
  }

  // 4) Assassinate (Assassin / Contessa)
  if (pending.type === "assassinate") {
    const target = game.getPlayer(pending.targetId);

    if (pending.stage === "awaitingChallenge") {
      if (!(playerId in pending.responders)) return { state: game.getPublicState(), privates: [] };

      if (responseType === "pass") pending.responders[playerId] = "passed";
      else if (responseType === "challenge") pending.responders[playerId] = "challenged";
      else return { state: game.getPublicState(), privates: [] };

      const challengerId = firstChallenger(pending.responders);
      if (challengerId) {
        const actorHas = game.playerHasRole(pending.actorId, "Assassin");
        const challenger = game.getPlayer(challengerId);

        if (actorHas) {
          game.log.push(`${challenger.name} challenges — FAILED.`);
          game.revealAndRedraw(pending.actorId, "Assassin");

          beginLoseInfluence(game, {
            playerId: challengerId,
            reason: "failed_challenge",
            continuation: { type: "assassinate_open_block", actorId: pending.actorId, targetId: pending.targetId },
          });
          return { state: game.getPublicState(), privates: [] };
        } else {
          game.log.push(`${challenger.name} challenges — SUCCESS.`);
          game.log.push(`Assassination fails.`);

          beginLoseInfluence(game, {
            playerId: pending.actorId,
            reason: "lost_challenge",
            continuation: { type: "endTurn" },
          });
          return { state: game.getPublicState(), privates: [] };
        }
      }

      if (everyonePassed(pending.responders)) {
        game.pendingAction = {
          type: "assassinate",
          stage: "awaitingBlock",
          actorId: pending.actorId,
          targetId: pending.targetId,
          claimedRole: "Assassin",
          blockedBy: null,
          responders: { [pending.targetId]: "pending" },
        };
        return { state: game.getPublicState(), privates: [] };
      }

      return { state: game.getPublicState(), privates: [] };
    }

    if (pending.stage === "awaitingBlock") {
      if (playerId !== pending.targetId) return { state: game.getPublicState(), privates: [] };

      if (responseType === "pass") {
        beginLoseInfluence(game, {
          playerId: pending.targetId,
          reason: "assassinated",
          continuation: { type: "endTurn_after_assassination", targetId: pending.targetId },
        });
        return { state: game.getPublicState(), privates: [] };
      }

      if (responseType === "block" && payload?.role === "Contessa") {
        game.log.push(`${target.name} blocks the assassination with Contessa.`);
        game.pendingAction = {
          type: "assassinate",
          stage: "awaitingChallengeBlock",
          actorId: pending.actorId,
          targetId: pending.targetId,
          blockedBy: pending.targetId,
          responders: initResponders(game, pending.targetId),
        };
        return { state: game.getPublicState(), privates: [] };
      }

      return { state: game.getPublicState(), privates: [] };
    }

    if (pending.stage === "awaitingChallengeBlock") {
      if (!(playerId in pending.responders)) return { state: game.getPublicState(), privates: [] };

      if (responseType === "pass") pending.responders[playerId] = "passed";
      else if (responseType === "challenge") pending.responders[playerId] = "challenged";
      else return { state: game.getPublicState(), privates: [] };

      const challengerId = firstChallenger(pending.responders);
      if (challengerId) {
        const blockerId = pending.blockedBy; // target
        const blockerHas = game.playerHasRole(blockerId, "Contessa");
        const challenger = game.getPlayer(challengerId);

        if (blockerHas) {
          game.log.push(`${challenger.name} challenges block — FAILED.`);
          game.revealAndRedraw(blockerId, "Contessa");

          beginLoseInfluence(game, {
            playerId: challengerId,
            reason: "failed_challenge",
            continuation: { type: "assassinate_block_stands" },
          });
          return { state: game.getPublicState(), privates: [] };
        } else {
          game.log.push(`${challenger.name} challenges block — SUCCESS.`);

          beginLoseInfluence(game, {
            playerId: blockerId,
            reason: "lost_challenge",
            continuation: { type: "assassinate_force_target_loss", actorId: pending.actorId, targetId: pending.targetId },
          });
          return { state: game.getPublicState(), privates: [] };
        }
      }

      if (everyonePassed(pending.responders)) {
        game.log.push(`Assassination is blocked.`);
        return finishTurn(game);
      }

      return { state: game.getPublicState(), privates: [] };
    }
  }

  // 5) Steal (Captain / Ambassador block)
  if (pending.type === "steal") {
    const target = game.getPlayer(pending.targetId);

    // A) Challenge Captain claim
    if (pending.stage === "awaitingChallenge") {
      if (!(playerId in pending.responders)) return { state: game.getPublicState(), privates: [] };

      if (responseType === "pass") pending.responders[playerId] = "passed";
      else if (responseType === "challenge") pending.responders[playerId] = "challenged";
      else return { state: game.getPublicState(), privates: [] };

      const challengerId = firstChallenger(pending.responders);
      if (challengerId) {
        const actorHas = game.playerHasRole(pending.actorId, "Captain");
        const challenger = game.getPlayer(challengerId);

        if (actorHas) {
          game.log.push(`${challenger.name} challenges — FAILED.`);
          game.revealAndRedraw(pending.actorId, "Captain");

          beginLoseInfluence(game, {
            playerId: challengerId,
            reason: "failed_challenge",
            continuation: { type: "steal_open_block", actorId: pending.actorId, targetId: pending.targetId },
          });
          return { state: game.getPublicState(), privates: [] };
        } else {
          game.log.push(`${challenger.name} challenges — SUCCESS.`);
          game.log.push(`Steal fails.`);

          beginLoseInfluence(game, {
            playerId: pending.actorId,
            reason: "lost_challenge",
            continuation: { type: "endTurn" },
          });
          return { state: game.getPublicState(), privates: [] };
        }
      }

      if (everyonePassed(pending.responders)) {
        game.pendingAction = {
          type: "steal",
          stage: "awaitingBlock",
          actorId: pending.actorId,
          targetId: pending.targetId,
          claimedRole: "Captain",
          blockedBy: null,
          blockRole: null,
          responders: { [pending.targetId]: "pending" },
        };
        return { state: game.getPublicState(), privates: [] };
      }

      return { state: game.getPublicState(), privates: [] };
    }

    // B) Target blocks with Captain/Ambassador or passes
    if (pending.stage === "awaitingBlock") {
      if (playerId !== pending.targetId) return { state: game.getPublicState(), privates: [] };

      if (responseType === "pass") {
        game.pendingAction = null;
        applySteal(game, pending.actorId, pending.targetId);
        return finishTurn(game);
      }

      if (responseType === "block" && (payload?.role === "Captain" || payload?.role === "Ambassador")) {
        const role = payload.role;
        game.log.push(`${target.name} blocks the steal with ${role}.`);
        game.pendingAction = {
          type: "steal",
          stage: "awaitingChallengeBlock",
          actorId: pending.actorId,
          targetId: pending.targetId,
          blockedBy: pending.targetId,
          blockRole: role,
          responders: initResponders(game, pending.targetId), // anyone except blocker can challenge
        };
        return { state: game.getPublicState(), privates: [] };
      }

      return { state: game.getPublicState(), privates: [] };
    }

    // C) Challenge the block claim
    if (pending.stage === "awaitingChallengeBlock") {
      if (!(playerId in pending.responders)) return { state: game.getPublicState(), privates: [] };

      if (responseType === "pass") pending.responders[playerId] = "passed";
      else if (responseType === "challenge") pending.responders[playerId] = "challenged";
      else return { state: game.getPublicState(), privates: [] };

      const challengerId = firstChallenger(pending.responders);
      if (challengerId) {
        const blockerId = pending.blockedBy; // target
        const role = pending.blockRole;
        const blockerHas = game.playerHasRole(blockerId, role);
        const challenger = game.getPlayer(challengerId);

        if (blockerHas) {
          game.log.push(`${challenger.name} challenges block — FAILED.`);
          game.revealAndRedraw(blockerId, role);

          beginLoseInfluence(game, {
            playerId: challengerId,
            reason: "failed_challenge",
            continuation: { type: "steal_block_stands" },
          });
          return { state: game.getPublicState(), privates: [] };
        } else {
          game.log.push(`${challenger.name} challenges block — SUCCESS.`);

          beginLoseInfluence(game, {
            playerId: blockerId,
            reason: "lost_challenge",
            continuation: { type: "steal_apply_after_block_fail", actorId: pending.actorId, targetId: pending.targetId },
          });
          return { state: game.getPublicState(), privates: [] };
        }
      }

      if (everyonePassed(pending.responders)) {
        game.log.push(`Steal is blocked.`);
        return finishTurn(game);
      }

      return { state: game.getPublicState(), privates: [] };
    }
  }

  // 6) Exchange (Ambassador)
  if (pending.type === "exchange") {
    // A) Challenge Ambassador claim
    if (pending.stage === "awaitingChallenge") {
      if (!(playerId in pending.responders)) return { state: game.getPublicState(), privates: [] };

      if (responseType === "pass") pending.responders[playerId] = "passed";
      else if (responseType === "challenge") pending.responders[playerId] = "challenged";
      else return { state: game.getPublicState(), privates: [] };

      const challengerId = firstChallenger(pending.responders);
      if (challengerId) {
        const actorHas = game.playerHasRole(pending.actorId, "Ambassador");
        const actor = game.getPlayer(pending.actorId);
        const challenger = game.getPlayer(challengerId);

        if (actorHas) {
          game.log.push(`${challenger.name} challenges — FAILED.`);
          game.revealAndRedraw(pending.actorId, "Ambassador");

          beginLoseInfluence(game, {
            playerId: challengerId,
            reason: "failed_challenge",
            continuation: { type: "exchange_start_choice", actorId: pending.actorId },
          });
          return { state: game.getPublicState(), privates: [] };
        } else {
          game.log.push(`${challenger.name} challenges — SUCCESS.`);
          game.log.push(`Exchange fails.`);

          beginLoseInfluence(game, {
            playerId: pending.actorId,
            reason: "lost_challenge",
            continuation: { type: "endTurn" },
          });
          return { state: game.getPublicState(), privates: [] };
        }
      }

      if (everyonePassed(pending.responders)) {
        return startExchangeChoice(game, pending.actorId);
      }

      return { state: game.getPublicState(), privates: [] };
    }

    // B) Actor picks which to keep
    if (pending.stage === "awaitingChoice") {
      if (playerId !== pending.actorId) return { state: game.getPublicState(), privates: [] };
      if (responseType !== "exchangeChoice") return { state: game.getPublicState(), privates: [] };

      const secret = game._private.exchange.get(playerId);
      if (!secret) return { state: game.getPublicState(), privates: [] };

      const keep = Array.isArray(payload?.keep) ? payload.keep : [];
      const unique = [...new Set(keep)];
      if (unique.length !== secret.keepCount) return { state: game.getPublicState(), privates: [] };

      const chosen = secret.options.filter((o) => unique.includes(o.id));
      if (chosen.length !== secret.keepCount) return { state: game.getPublicState(), privates: [] };

      const actor = game.getPlayer(playerId);
      if (!actor) return { state: game.getPublicState(), privates: [] };

      const handSlots = actor.influence
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => !c.revealed)
        .map(({ i }) => i);

      if (handSlots.length !== secret.keepCount) return { state: game.getPublicState(), privates: [] };

      // Roles to return are all unchosen options
      const unchosenRoles = secret.options.filter((o) => !unique.includes(o.id)).map((o) => o.role);

      // Replace the actor's unrevealed influence slots with chosen roles
      for (let k = 0; k < handSlots.length; k++) {
        actor.influence[handSlots[k]] = { role: chosen[k].role, revealed: false };
      }

      game.returnToDeck(unchosenRoles);
      game._private.exchange.delete(playerId);

      game.log.push(`${actor.name} completes Exchange.`);
      return finishTurn(game);
    }
  }

  return { state: game.getPublicState(), privates: [] };
}