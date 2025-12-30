// gameEngine.js
// Minimal Coup engine: state + helpers. Resolver drives the action state machine.

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeDeck() {
  // 3 of each role (standard Coup)
  const roles = ["Duke", "Assassin", "Captain", "Ambassador", "Contessa"];
  const deck = [];
  for (const r of roles) for (let i = 0; i < 3; i++) deck.push(r);
  return shuffle(deck);
}

export class GameEngine {
  constructor(players) {
    // players: [{id,name}]
    this.players = players.map((p) => ({
      id: p.id,
      name: p.name,
      coins: 2,
      influence: [], // [{ role, revealed:false }]
    }));

    this.deck = makeDeck();
    this.log = [];
    this.turnIndex = 0;
    this.pendingAction = null; // actionResolver sets this

    // game end
    this.gameOver = false;
    this.winnerId = null;

    // server-only hidden state bucket (never included in public state)
    this._private = {
      exchange: new Map(), // actorId -> { keepCount, options:[{id,role,source,handIndex?}] }
    };

    // deal 2 influence
    for (const p of this.players) {
      p.influence.push({ role: this.draw(), revealed: false });
      p.influence.push({ role: this.draw(), revealed: false });
    }

    this.log.push("Game started. Each player has 2 influence and 2 coins.");
    const cp = this.currentPlayer();
    if (cp) this.log.push(`It is now ${cp.name}'s turn.`);
  }

  draw() {
    if (this.deck.length === 0) {
      this.deck = makeDeck();
    }
    return this.deck.pop();
  }

  returnToDeck(roles) {
    for (const r of roles) this.deck.unshift(r);
    shuffle(this.deck);
  }

  getPlayer(id) {
    return this.players.find((p) => p.id === id);
  }

  isAlive(id) {
    const p = this.getPlayer(id);
    if (!p) return false;
    return p.influence.some((c) => !c.revealed);
  }

  alivePlayers() {
    return this.players.filter((p) => this.isAlive(p.id));
  }

  currentPlayer() {
    if (this.gameOver) return null;

    const alive = this.alivePlayers();
    if (alive.length === 0) return null;

    for (let guard = 0; guard < this.players.length; guard++) {
      const p = this.players[this.turnIndex % this.players.length];
      if (this.isAlive(p.id)) return p;
      this.turnIndex = (this.turnIndex + 1) % this.players.length;
    }
    return this.getPlayer(this.players[0].id);
  }

  nextTurn() {
    this.checkWin();
    if (this.gameOver) return;

    for (let guard = 0; guard < this.players.length; guard++) {
      this.turnIndex = (this.turnIndex + 1) % this.players.length;
      const p = this.players[this.turnIndex];
      if (this.isAlive(p.id)) break;
    }

    const cp = this.currentPlayer();
    if (cp) this.log.push(`It is now ${cp.name}'s turn.`);
  }

  checkWin() {
    if (this.gameOver) return;

    const alive = this.alivePlayers();
    if (alive.length === 1) {
      this.gameOver = true;
      this.winnerId = alive[0].id;
      this.log.push(`${alive[0].name} wins!`);
    }
  }

  playerHasRole(playerId, role) {
    const p = this.getPlayer(playerId);
    if (!p) return false;
    return p.influence.some((c) => !c.revealed && c.role === role);
  }

  revealAndRedraw(playerId, role) {
    const p = this.getPlayer(playerId);
    if (!p) return false;

    const idx = p.influence.findIndex((c) => !c.revealed && c.role === role);
    if (idx === -1) return false;

    p.influence[idx].revealed = true;
    this.log.push(`${p.name} reveals ${role}.`);

    this.returnToDeck([role]);
    p.influence[idx] = { role: this.draw(), revealed: false };
    this.log.push(`${p.name} draws a replacement influence.`);
    return true;
  }

  loseInfluence(playerId, cardIndex) {
    const p = this.getPlayer(playerId);
    if (!p) return false;

    const aliveCards = p.influence
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !c.revealed);

    const pick = aliveCards.find(({ i }) => i === cardIndex);
    if (!pick) return false;

    p.influence[pick.i].revealed = true;
    this.log.push(`${p.name} loses influence (${p.influence[pick.i].role} revealed).`);
    this.checkWin();
    return true;
  }

  // ✅ Per-viewer state (real Coup secrecy):
  // - Viewer sees their own unrevealed roles
  // - Others' unrevealed roles are hidden as "?"
  getStateFor(viewerId) {
    return {
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        coins: p.coins,
        alive: this.isAlive(p.id),
        influence: p.influence.map((c) => {
          if (c.revealed) return { role: c.role, revealed: true };
          if (p.id === viewerId) return { role: c.role, revealed: false };
          return { role: "?", revealed: false };
        }),
      })),
      log: this.log.slice(-80),
      pendingAction: this.pendingAction,
      turnPlayerId: this.currentPlayer()?.id ?? null,
      gameOver: this.gameOver,
      winnerId: this.winnerId,
    };
  }

  // kept for any internal uses
  getPublicState() {
    return this.getStateFor(null);
  }
}