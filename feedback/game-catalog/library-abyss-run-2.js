// rules:
// 1. infinite world: tiles generated on demand by (x,y) hash; player walks forever
// 2. floors 🟫 walkable; walls 🔳, bookshelves 📚, chairs 🪑 block movement
// 3. big drops ⬛ span 2x2 tiles (anchored at even x,y); banisters ◻️ ring the drop and block
// 4. sectors: 16x16 rooms; edge walls 🔳 ring each sector with a 2-tile gap ⬛ per side
// 5. walking into a gap teleports the player to the matching gap of the adjacent sector
// 6. player 🟡 starts on a guaranteed floor, never sealed in
// 7. view shows 7x7 around player; d-pad moves one tile per press
import { app, embed, row, button, grid, colors } from "@teapilot/discord-play";

const FLOOR = "🟫", WALL = "🔳", SHELF = "📚", CHAIR = "🪑", DROP = "⬛", BAN = "◻️", PLAYER = "🟡";
const BLOCK = new Set([WALL, SHELF, CHAIR, BAN]);
const ROOM = 16;

function h(x, y, s) {
  let n = (x * 374761393 + y * 668265263 + s * 1274126177) | 0;
  n = (n ^ (n >> 13)) | 0; n = (n * 1274126177) | 0; n = (n ^ (n >> 16)) >>> 0;
  return n;
}
function gapPos(side, sx, sy) {
  const g = h(sx * 4 + side, sy, 5) % (ROOM - 2);
  if (side === 0) return { x: sx * ROOM + 1 + g, y: sy * ROOM };
  if (side === 1) return { x: sx * ROOM + 1 + g, y: (sy + 1) * ROOM - 1 };
  if (side === 2) return { x: sx * ROOM, y: sy * ROOM + 1 + g };
  return { x: (sx + 1) * ROOM - 1, y: sy * ROOM + 1 + g };
}
function tileAt(x, y) {
  const sx = Math.floor(x / ROOM), sy = Math.floor(y / ROOM);
  const lx = x - sx * ROOM, ly = y - sy * ROOM;
  if (lx === 0 || lx === ROOM - 1 || ly === 0 || ly === ROOM - 1) {
    const side = lx === 0 ? 2 : lx === ROOM - 1 ? 3 : ly === 0 ? 0 : 1;
    const gp = gapPos(side, sx, sy);
    if (x === gp.x && y === gp.y) return DROP;
    return WALL;
  }
  const ax = x - (x % 2), ay = y - (y % 2);
  if (h(ax, ay, 1) % 100 < 6) {
    const inDrop = (x === ax || x === ax + 1) && (y === ay || y === ay + 1);
    if (inDrop) return DROP;
    const ring = (x === ax - 1 || x === ax + 2) && (y === ay || y === ay + 1)
      || (y === ay - 1 || y === ay + 2) && (x === ax || x === ax + 1);
    if (ring) return BAN;
  }
  const r = h(x, y, 2) % 100;
  if (r < 78) return FLOOR;
  if (r < 86) return WALL;
  if (r < 93) return SHELF;
  return CHAIR;
}
function findStart() {
  for (let d = 0; d < 200; d++) {
    const x = (h(d, 7, 3) % 400) - 200, y = (h(d, 13, 4) % 400) - 200;
    if (tileAt(x, y) === FLOOR) return { x, y };
  }
  return { x: 8, y: 8 };
}
function view(state) {
  const rows = [];
  for (let dy = -3; dy <= 3; dy++) {
    const line = [];
    for (let dx = -3; dx <= 3; dx++) {
      const x = state.px + dx, y = state.py + dy;
      line.push(x === state.px && y === state.py ? PLAYER : tileAt(x, y));
    }
    rows.push(line);
  }
  const desc = grid(rows, colors);
  const legend = "🟫 floor · 🔳 wall · 📚 shelf · 🪑 chair · ⬛ drop (2x2) · ◻️ banister · ⬛ edge gap → new sector · 🟡 you";
  const e = embed({
    title: "📖 the infinite library abyss",
    description: desc + "\n" + legend,
    color: colors.gold,
    footer: { text: `sector ${Math.floor(state.px / ROOM)}, ${Math.floor(state.py / ROOM)} · pos ${state.px}, ${state.py} · steps ${state.steps}` },
  });
  if (!state.started) {
    return { embeds: [e], rows: [row(button("start", "start walking", { style: "primary" }))] };
  }
  return {
    embeds: [e],
    rows: [
      row(button("up", "▲", { style: "secondary", emoji: "⬆️" })),
      row(button("left", "◀", { style: "secondary", emoji: "⬅️" }), button("down", "▼", { style: "secondary", emoji: "⬇️" }), button("right", "▶", { style: "secondary", emoji: "➡️" })),
    ],
  };
}
export default app({
  init() {
    const s = findStart();
    return { started: false, px: s.x, py: s.y, steps: 0 };
  },
  update(state, action) {
    if (action.kind !== "button") return state;
    if (!state.started) {
      if (action.id === "start") return { ...state, started: true };
      return state;
    }
    const dir = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[action.id];
    if (!dir) return state;
    const nx = state.px + dir[0], ny = state.py + dir[1];
    const sx = Math.floor(nx / ROOM), sy = Math.floor(ny / ROOM);
    const lx = nx - sx * ROOM, ly = ny - sy * ROOM;
    if (lx === 0 || lx === ROOM - 1 || ly === 0 || ly === ROOM - 1) {
      const side = lx === 0 ? 2 : lx === ROOM - 1 ? 3 : ly === 0 ? 0 : 1;
      const gp = gapPos(side, sx, sy);
      if (nx === gp.x && ny === gp.y) {
        const nsx = sx + (side === 3 ? 1 : side === 2 ? -1 : 0);
        const nsy = sy + (side === 1 ? 1 : side === 0 ? -1 : 0);
        const nside = side === 0 ? 1 : side === 1 ? 0 : side === 2 ? 3 : 2;
        const ng = gapPos(nside, nsx, nsy);
        return { ...state, px: ng.x, py: ng.y, steps: state.steps + 1 };
      }
      return state; // edge wall: blocked
    }
    if (BLOCK.has(tileAt(nx, ny))) return state; // blocked: stay put
    return { ...state, px: nx, py: ny, steps: state.steps + 1 };
  },
  view,
});
