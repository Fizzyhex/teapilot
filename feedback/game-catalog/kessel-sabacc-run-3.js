import { app, embed, row, button, ephemeral, after, text } from "@teapilot/discord-play";

// kessel sabacc
// - 2 players, each holds 1 sand + 1 blood card
// - 3 turns per round: stand (free) or draw 1 chip (from either deck or top of either discard), then discard 1 card of the same family
// - after 3 turns: reveal. best hand wins.
// - hand: pair (sabacc) beats non-pair. among pairs, lower value wins (1+1 best). among non-pairs, smallest difference wins.
// - winner gets back chips spent that round. everyone else loses chips spent + penalty (1 if they had a sabacc, else difference).
// - out at 0 chips. last player with chips wins the game.

function makeDeck() {
  const cards = [];
  for (let v = 1; v <= 6; v++) {
    for (let i = 0; i < 3; i++) {
      cards.push({ family: "sand", value: v });
      cards.push({ family: "blood", value: v });
    }
  }
  return cards;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cardLabel(c) {
  return `${c.family === "sand" ? "🏜️" : "🩸"} ${c.value}`;
}

function handLabel(h) {
  return `${cardLabel(h.sand)} + ${cardLabel(h.blood)}`;
}

function scoreHand(h) {
  const s = h.sand.value, b = h.blood.value;
  const isPair = s === b;
  const diff = Math.abs(s - b);
  return { isPair, pairValue: isPair ? s : null, diff };
}

function compareHands(a, b) {
  const sa = scoreHand(a), sb = scoreHand(b);
  if (sa.isPair && !sb.isPair) return -1;
  if (!sa.isPair && sb.isPair) return 1;
  if (sa.isPair && sb.isPair) return sa.pairValue - sb.pairValue;
  return sa.diff - sb.diff;
}

function drawCard(state, player, source) {
  // source: "sandDeck", "bloodDeck", "sandDiscard", "bloodDiscard"
  let card = null;
  if (source === "sandDeck") {
    card = state.sandDeck.pop();
  } else if (source === "bloodDeck") {
    card = state.bloodDeck.pop();
  } else if (source === "sandDiscard") {
    card = state.sandDiscard.pop();
  } else if (source === "bloodDiscard") {
    card = state.bloodDiscard.pop();
  }
  if (!card) return null;
  return card;
}

function init() {
  const sandDeck = shuffle(makeDeck().filter(c => c.family === "sand"));
  const bloodDeck = shuffle(makeDeck().filter(c => c.family === "blood"));
  const players = {
    "100000000000000001": { chips: 20, hand: { sand: sandDeck.pop(), blood: bloodDeck.pop() }, spent: 0, out: false },
    "100000000000000002": { chips: 20, hand: { sand: sandDeck.pop(), blood: bloodDeck.pop() }, spent: 0, out: false }
  };
  return {
    phase: "playing",
    turn: 1,
    currentPlayer: "100000000000000001",
    players,
    sandDeck,
    bloodDeck,
    sandDiscard: [],
    bloodDiscard: [],
    roundLog: [],
    gameOver: false,
    winner: null,
    roundResult: null
  };
}

function update(state, action, ctx) {
  if (state.gameOver) return state;

  if (action.kind === "button") {
    const uid = action.user.id;
    const p = state.players[uid];
    if (!p || p.out) return state;

    if (action.id === "stand") {
      if (state.currentPlayer !== uid) return state;
      // advance turn
      const nextPlayer = uid === "100000000000000001" ? "100000000000000002" : "100000000000000001";
      const nextP = state.players[nextPlayer];
      if (nextP.out) {
        // other player is out, end round
        return endRound(state);
      }
      state.currentPlayer = nextPlayer;
      return state;
    }

    if (action.id === "drawSandDeck" || action.id === "drawBloodDeck" || action.id === "drawSandDiscard" || action.id === "drawBloodDiscard") {
      if (state.currentPlayer !== uid) return state;
      if (p.chips < 1) return state;

      const sourceMap = {
        drawSandDeck: "sandDeck",
        drawBloodDeck: "bloodDeck",
        drawSandDiscard: "sandDiscard",
        drawBloodDiscard: "bloodDiscard"
      };
      const source = sourceMap[action.id];
      const card = drawCard(state, uid, source);
      if (!card) return state;

      p.chips -= 1;
      p.spent += 1;

      // add drawn card to hand temporarily, then discard one of same family
      const family = card.family;
      const oldCard = p.hand[family];
      p.hand[family] = card;
      // discard old card
      if (family === "sand") state.sandDiscard.push(oldCard);
      else state.bloodDiscard.push(oldCard);

      // advance turn
      const nextPlayer = uid === "100000000000000001" ? "100000000000000002" : "100000000000000001";
      const nextP = state.players[nextPlayer];
      if (nextP.out) {
        return endRound(state);
      }
      state.currentPlayer = nextPlayer;
      return state;
    }
  }
  return state;
}

function endRound(state) {
  const p1 = state.players["100000000000000001"];
  const p2 = state.players["100000000000000002"];

  // determine winner
  let winnerId, loserId;
  const cmp = compareHands(p1.hand, p2.hand);
  if (cmp < 0) { winnerId = "100000000000000001"; loserId = "100000000000000002"; }
  else if (cmp > 0) { winnerId = "100000000000000002"; loserId = "100000000000000001"; }
  else { winnerId = "100000000000000001"; loserId = "100000000000000002"; } // tie goes to p1

  const winner = state.players[winnerId];
  const loser = state.players[loserId];

  // winner gets back chips spent
  winner.chips += winner.spent;

  // loser loses chips spent + penalty
  const loserScore = scoreHand(loser.hand);
  const penalty = loserScore.isPair ? 1 : loserScore.diff;
  loser.chips -= (loser.spent + penalty);

  // check if loser is out
  if (loser.chips <= 0) {
    loser.chips = 0;
    loser.out = true;
    state.gameOver = true;
    state.winner = winnerId;
  }

  // store round result for display
  state.roundResult = {
    winnerId,
    loserId,
    winnerHand: { ...winner.hand },
    loserHand: { ...loser.hand },
    winnerSpent: winner.spent,
    loserSpent: loser.spent,
    penalty
  };

  // reset for next round
  state.turn = 1;
  state.currentPlayer = "100000000000000001";
  state.players["100000000000000001"].spent = 0;
  state.players["100000000000000002"].spent = 0;

  // new hands
  if (!state.gameOver) {
    const p1 = state.players["100000000000000001"];
    const p2 = state.players["100000000000000002"];
    p1.hand = { sand: state.sandDeck.pop(), blood: state.bloodDeck.pop() };
    p2.hand = { sand: state.sandDeck.pop(), blood: state.bloodDeck.pop() };
  }

  return state;
}

function view(state, ctx) {
  if (state.gameOver) {
    const winnerName = state.winner === "100000000000000001" ? "player 1" : "player 2";
    return {
      embeds: [embed({
        title: "🏆 game over",
        description: `${winnerName} wins with ${state.players[state.winner].chips} chips!`,
        color: 0x2ecc71
      })],
      rows: []
    };
  }

  const p1 = state.players["100000000000000001"];
  const p2 = state.players["100000000000000002"];
  const currentName = state.currentPlayer === "100000000000000001" ? "player 1" : "player 2";

  const fields = [
    { name: "🎮 turn", value: `turn ${state.turn} of 3 — ${currentName}'s turn`, inline: true },
    { name: "🏜️ sand deck", value: `${state.sandDeck.length} cards`, inline: true },
    { name: "🩸 blood deck", value: `${state.bloodDeck.length} cards`, inline: true },
    { name: "🏜️ sand discard", value: `${state.sandDiscard.length} cards`, inline: true },
    { name: "🩸 blood discard", value: `${state.bloodDiscard.length} cards`, inline: true },
    { name: "👤 player 1", value: `${p1.out ? "❌ out" : `💰 ${p1.chips} chips | ${handLabel(p1.hand)}`}`, inline: false },
    { name: "👤 player 2", value: `${p2.out ? "❌ out" : `💰 ${p2.chips} chips | ${handLabel(p2.hand)}`}`, inline: false }
  ];

  // show round result if available
  if (state.roundResult) {
    const rr = state.roundResult;
    const winnerName = rr.winnerId === "100000000000000001" ? "player 1" : "player 2";
    const loserName = rr.loserId === "100000000000000001" ? "player 1" : "player 2";
    fields.push({
      name: "📊 last round",
      value: `${winnerName} wins with ${handLabel(rr.winnerHand)} (got back ${rr.winnerSpent} chips). ${loserName} loses ${rr.loserSpent} + ${rr.penalty} penalty.`,
      inline: false
    });
  }

  const rows = [];
  if (state.currentPlayer === "100000000000000001" && !p1.out) {
    rows.push(row(
      button("stand", "🛑 stand (free)"),
      button("drawSandDeck", "🏜️ draw sand deck (1 chip)"),
      button("drawBloodDeck", "🩸 draw blood deck (1 chip)"),
      button("drawSandDiscard", "🏜️ draw sand discard (1 chip)"),
      button("drawBloodDiscard", "🩸 draw blood discard (1 chip)")
    ));
  } else if (state.currentPlayer === "100000000000000002" && !p2.out) {
    rows.push(row(
      button("stand", "🛑 stand (free)"),
      button("drawSandDeck", "🏜️ draw sand deck (1 chip)"),
      button("drawBloodDeck", "🩸 draw blood deck (1 chip)"),
      button("drawSandDiscard", "🏜️ draw sand discard (1 chip)"),
      button("drawBloodDiscard", "🩸 draw blood discard (1 chip)")
    ));
  }

  return {
    embeds: [embed({
      title: "🎴 kessel sabacc",
      description: "build the best hand over 3 turns. pairs beat non-pairs. lower pairs win. smallest difference wins among non-pairs.",
      color: 0x3498db,
      fields
    })],
    rows
  };
}

export default app({ init, update, view });
