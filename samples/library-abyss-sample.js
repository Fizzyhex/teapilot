// rules:
// - infinite library: world generated on demand, 16x16 chunks, deterministic per chunk
// - floors 🟫 walkable; walls 🔳, bookshelves 📚, chairs 🪑 block movement
// - drops ⬛ span multiple tiles (2x2 or 3x3 holes); banisters ◻️ ring the drop edge and block movement
// - player 🟡 starts at (0,0); moves one tile per button press; can walk forever
// - view shows 9x9 around player; footer shows coords + steps + sector
// - sectors: 8x8 rooms with edge walls 🔳; gaps ⬛ in the walls lead to new sectors
// - walking into a gap teleports the player to the corresponding gap in the next sector

import { app, embed, row, button, grid, colors } from "@teapilot/discord-play";

const CHUNK = 16;
const VIEW = 9;
const ROOM = 8;

function hash(x, y) {
  let h = 2166136261;
  const s = x + "," + y;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

function chunkSeed(cx, cy) {
  let h = 2166136261;
  const s = "c" + cx + "," + cy;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

// sector: 8x8 room with edge walls; gaps in walls lead to new sectors
function sectorOf(x, y) {
  return { sx: Math.floor(x / ROOM), sy: Math.floor(y / ROOM) };
}

// gap positions per sector edge (deterministic)
function gapPos(sx, sy, edge) {
  // edge: 0=top, 1=right, 2=bottom, 3=left
  const h = hash(sx * 31 + edge, sy * 47 + edge);
  return 1 + Math.floor(h * (ROOM - 2)); // 1..6
}

// tile types: 0 floor, 1 wall, 2 bookshelf, 3 chair, 4 drop, 5 banister, 6 gap
function tileAt(x, y) {
  const { sx, sy } = sectorOf(x, y);
  const lx = ((x % ROOM) + ROOM) % ROOM, ly = ((y % ROOM) + ROOM) % ROOM;
  // edge walls with gaps
  if (ly === 0) {
    if (lx === gapPos(sx, sy, 0)) return 6;
    return 1;
  }
  if (ly === ROOM - 1) {
    if (lx === gapPos(sx, sy, 2)) return 6;
    return 1;
  }
  if (lx === 0) {
    if (ly === gapPos(sx, sy, 3)) return 6;
    return 1;
  }
  if (lx === ROOM - 1) {
    if (ly === gapPos(sx, sy, 1)) return 6;
    return 1;
  }
  // interior: drops, bookshelves, chairs
  const seed = chunkSeed(sx, sy);
  const dropX = 2 + Math.floor(seed * 4);
  const dropY = 2 + Math.floor(hash(sx, sy) * 4);
  const dropSize = seed > 0.5 ? 2 : 1;
  if (lx >= dropX && lx < dropX + dropSize && ly >= dropY && ly < dropY + dropSize) return 4;
  if (lx >= dropX - 1 && lx < dropX + dropSize + 1 && ly >= dropY - 1 && ly < dropY + dropSize + 1) return 5;
  if (hash(sx * 7 + lx, sy * 13 + ly) > 0.90) return 2;
  if (hash(sx * 11 + lx, sy * 17 + ly) > 0.87) return 3;
  return 0;
}

// what sector does a gap lead to, and where?
function gapTarget(x, y) {
  const { sx, sy } = sectorOf(x, y);
  const lx = ((x % ROOM) + ROOM) % ROOM, ly = ((y % ROOM) + ROOM) % ROOM;
  if (ly === 0) {
    // top gap -> sector above, bottom gap
    const ty = (sy - 1) * ROOM + gapPos(sx, sy - 1, 2);
    return { tx: sx * ROOM + lx, ty };
  }
  if (ly === ROOM - 1) {
    // bottom gap -> sector below, top gap
    const ty = (sy + 1) * ROOM + gapPos(sx, sy + 1, 0);
    return { tx: sx * ROOM + lx, ty };
  }
  if (lx === 0) {
    // left gap -> sector left, right gap
    const tx = (sx - 1) * ROOM + gapPos(sx - 1, sy, 1);
    return { tx, ty: sy * ROOM + ly };
  }
  if (lx === ROOM - 1) {
    // right gap -> sector right, left gap
    const tx = (sx + 1) * ROOM + gapPos(sx + 1, sy, 3);
    return { tx, ty: sy * ROOM + ly };
  }
  return null;
}

function blocked(x, y) {
  const t = tileAt(x, y);
  return t === 1 || t === 2 || t === 3 || t === 5;
}

function tileEmoji(x, y) {
  const t = tileAt(x, y);
  if (t === 1) return "🔳";
  if (t === 2) return "📚";
  if (t === 3) return "🪑";
  if (t === 4) return "⬛";
  if (t === 5) return "◻️";
  if (t === 6) return "⬛";
  return "🟫";
}

function makeView(state) {
  const px = state.px, py = state.py;
  const half = Math.floor(VIEW / 2);
  const rows = [];
  for (let dy = -half; dy <= half; dy++) {
    const r = [];
    for (let dx = -half; dx <= half; dx++) {
      const x = px + dx, y = py + dy;
      if (dx === 0 && dy === 0) { r.push("🟡"); continue; }
      r.push(tileEmoji(x, y));
    }
    rows.push(r);
  }
  return {
    embeds: [embed({
      title: "📖 infinite library abyss",
      description: grid(rows, colors),
      color: colors.gold,
      footer: `🟡 at (${px}, ${py}) · sector (${Math.floor(px / ROOM)}, ${Math.floor(py / ROOM)}) · ${state.steps} steps · walk forever`
    })],
    rows: [
      row(button("up", "⬆️", { style: "secondary" })),
      row(button("left", "⬅️", { style: "secondary" }), button("down", "⬇️", { style: "secondary" }), button("right", "➡️", { style: "secondary" }))
    ]
  };
}

export default app({
  init() {
    return { px: 0, py: 0, steps: 0 };
  },
  update(state, action) {
    if (action.kind !== "button") return state;
    const dx = { up: 0, down: 0, left: -1, right: 1 }[action.id] ?? 0;
    const dy = { up: -1, down: 1, left: 0, right: 0 }[action.id] ?? 0;
    const nx = state.px + dx, ny = state.py + dy;
    if (blocked(nx, ny)) return state;
    const t = tileAt(nx, ny);
    if (t === 6) {
      // gap: teleport to next sector
      const target = gapTarget(nx, ny);
      if (target) return { px: target.tx, py: target.ty, steps: state.steps + 1 };
    }
    return { px: nx, py: ny, steps: state.steps + 1 };
  },
  view(state) {
    return makeView(state);
  }
});
