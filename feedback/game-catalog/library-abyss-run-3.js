// rules:
// - infinite world: tiles generated on demand, keyed "x,y", never stored beyond the visible window
// - floors 🟫 walkable; walls 🔳, bookshelves 📚, chairs 🪑 block movement
// - big drops ⬛ span 2x2 tiles (anchored at even x,y); banisters ◻️ ring the drop and block movement
// - player 🟡 starts at 0,0 on a floor and can walk forever; blocked moves just don't happen
// - view shows a 7x7 window centred on the player; d-pad moves the player
// - sectors: the world is a grid of 16x16 sectors; each sector's outer ring is edge wall 🔳
//   with a gap ⬛ in the middle of each side; walking into a gap teleports you to the
//   matching gap of the neighbouring sector (a new sector, new layout)
import { app, embed, row, button, grid, colors } from "@teapilot/discord-play";

const W = 7;
const S = 16; // sector size in tiles

function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = (h * 1274126177) | 0;
  return (h ^ (h >> 16)) >>> 0;
}

// deterministic tile at x,y. drops anchored at even coords, 2x2.
// sectors: 16x16 blocks; the outer ring is edge wall with a gap in the middle of each side.
function tileAt(x, y) {
  if (x === 8 && y === 8) return "floor";
  const sx = Math.floor(x / S), sy = Math.floor(y / S);
  const lx = ((x % S) + S) % S, ly = ((y % S) + S) % S;
  const mid = S / 2; // 8
  if (lx === 0 && ly === mid) return "gap"; // west edge gap
  if (lx === S - 1 && ly === mid) return "gap"; // east edge gap
  if (ly === 0 && lx === mid) return "gap"; // north edge gap
  if (ly === S - 1 && lx === mid) return "gap"; // south edge gap
  if (lx === 0 || lx === S - 1 || ly === 0 || ly === S - 1) return "wall"; // edge wall
  const ax = x % 2 === 0 ? x : x - 1;
  const ay = y % 2 === 0 ? y : y - 1;
  const r = hash(ax, ay);
  if (r % 100 < 4) return "drop"; // 2x2 drop
  const t = hash(x, y);
  if (t % 100 < 6) return "wall";
  if (t % 100 < 11) return "shelf";
  if (t % 100 < 15) return "chair";
  return "floor";
}

function isBlocked(x, y) {
  const t = tileAt(x, y);
  if (t === "wall" || t === "shelf" || t === "chair" || t === "gap") return true;
  // banister: floor tile directly bordering a drop tile
  if (t === "floor") {
    const n = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of n) if (tileAt(x + dx, y + dy) === "drop") return true;
  }
  return false;
}

function glyph(x, y) {
  const t = tileAt(x, y);
  if (t === "gap") return "⬛";
  if (t === "drop") return "⬛";
  if (t === "wall") return "🔳";
  if (t === "shelf") return "📚";
  if (t === "chair") return "🪑";
  if (isBlocked(x, y)) return "◻️";
  return "🟫";
}

function view(state, ctx) {
  const { px, py } = state;
  const rows = [];
  for (let dy = -3; dy <= 3; dy++) {
    const line = [];
    for (let dx = -3; dx <= 3; dx++) {
      const x = px + dx, y = py + dy;
      line.push(dx === 0 && dy === 0 ? "🟡" : glyph(x, y));
    }
    rows.push(line);
  }
  const board = grid(rows, colors);
  const desc = [
    board,
    "",
    `📍 x:${px} y:${py} · sector ${Math.floor(px / S)},${Math.floor(py / S)} · steps:${state.steps}`,
    "🟫 floor · 🔳 wall · 📚 shelf · 🪑 chair",
    "⬛ drop (2x2) / edge gap · ◻️ banister · 🟡 you",
  ].join("\n");
  return {
    embeds: [embed({ title: "📖 infinite library abyss", description: desc, color: colors.gold })],
    rows: [
      row(button("up", "▲", { style: "secondary", emoji: "⬆️" })),
      row(button("left", "◀", { style: "secondary", emoji: "⬅️" }), button("down", "▼", { style: "secondary", emoji: "⬇️" }), button("right", "▶", { style: "secondary", emoji: "➡️" })),
    ],
  };
}

// walking into an edge gap teleports to the matching gap of the neighbouring sector
function move(state, dx, dy) {
  const nx = state.px + dx, ny = state.py + dy;
  if (tileAt(nx, ny) === "gap") {
    const sx = Math.floor(state.px / S), sy = Math.floor(state.py / S);
    const lx = ((state.px % S) + S) % S, ly = ((state.py % S) + S) % S;
    const mid = S / 2;
    let tx, ty;
    if (lx === 0 && ly === mid) { tx = (sx + 1) * S + mid; ty = sy * S + mid; } // west gap -> east gap of next sector
    else if (lx === S - 1 && ly === mid) { tx = (sx - 1) * S + mid; ty = sy * S + mid; }
    else if (ly === 0 && lx === mid) { tx = sx * S + mid; ty = (sy + 1) * S + mid; }
    else { tx = sx * S + mid; ty = (sy - 1) * S + mid; }
    return { ...state, px: tx, py: ty, steps: state.steps + 1 };
  }
  if (isBlocked(nx, ny)) return state;
  return { ...state, px: nx, py: ny, steps: state.steps + 1 };
}

export default app({
  init() {
    return { px: 8, py: 8, steps: 0 };
  },
  update(state, action) {
    if (action.kind !== "button") return state;
    const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[action.id];
    if (!d) return state;
    return move(state, d[0], d[1]);
  },
  view,
});
