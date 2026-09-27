// rules:
// - infinite library abyss, topdown grid, player walks forever
// - floors 🟫 walkable; walls 🔳, bookshelves 📚, chairs 🪑 block movement
// - big drops ⬛ span multiple tiles (2x2), with a ◻️ banister ring around them
// - banisters ◻️ block movement (you can't walk off the edge)
// - world generated procedurally per sector, seeded, so it's stable as you roam
// - sectors: 32x32 rooms with edge walls; gaps ⬛ in the walls lead to new sectors
// - walking into a gap teleports you to the adjacent sector at the matching spot
// - player 🟡 starts on a floor, never sealed in
// - view shows a 9x9 window around the player
import { app, embed, row, button, text } from "@teapilot/discord-play";

const W = 9, H = 9;
const SECTOR = 32;

// hash for seeded random per tile
function hash(x, y, seed) {
  let h = seed ^ (x * 374761393) ^ (y * 668265263);
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return (h >>> 0) / 4294967296;
}

// sector seed from global sector coords
function sectorSeed(sx, sy) {
  return Math.floor(hash(sx, sy, 42) * 100000);
}

// get tile type at local coords within a sector
function tileAtLocal(lx, ly, seed) {
  // edge walls
  if (lx === 0 || ly === 0 || lx === SECTOR - 1 || ly === SECTOR - 1) {
    // gaps in walls: 2-wide openings at hashed positions
    if (lx === 0) {
      const gapY = Math.floor(hash(0, 99, seed + 1) * (SECTOR - 4)) + 2;
      if (ly === gapY || ly === gapY + 1) return "gap";
      return "wall";
    }
    if (lx === SECTOR - 1) {
      const gapY = Math.floor(hash(SECTOR - 1, 99, seed + 2) * (SECTOR - 4)) + 2;
      if (ly === gapY || ly === gapY + 1) return "gap";
      return "wall";
    }
    if (ly === 0) {
      const gapX = Math.floor(hash(99, 0, seed + 3) * (SECTOR - 4)) + 2;
      if (lx === gapX || lx === gapX + 1) return "gap";
      return "wall";
    }
    if (ly === SECTOR - 1) {
      const gapX = Math.floor(hash(99, SECTOR - 1, seed + 4) * (SECTOR - 4)) + 2;
      if (lx === gapX || lx === gapX + 1) return "gap";
      return "wall";
    }
  }
  // drops: 2x2 blocks where both coords mod 8 are 0-1, and hash says drop
  const mx = ((lx % 8) + 8) % 8, my = ((ly % 8) + 8) % 8;
  if (mx <= 1 && my <= 1) {
    const bx = Math.floor(lx / 8), by = Math.floor(ly / 8);
    if (hash(bx, by, seed + 7) < 0.35) return "drop";
  }
  // banister: tiles adjacent to a drop tile
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  for (const [dx, dy] of dirs) {
    const nx = lx + dx, ny = ly + dy;
    const nmx = ((nx % 8) + 8) % 8, nmy = ((ny % 8) + 8) % 8;
    if (nmx <= 1 && nmy <= 1) {
      const nbx = Math.floor(nx / 8), nby = Math.floor(ny / 8);
      if (hash(nbx, nby, seed + 7) < 0.35) return "banister";
    }
  }
  // obstacles
  const r = hash(lx, ly, seed);
  if (r < 0.08) return "wall";
  if (r < 0.14) return "shelf";
  if (r < 0.18) return "chair";
  return "floor";
}

// resolve a world coord to sector + local
function resolve(wx, wy) {
  const sx = Math.floor(wx / SECTOR), sy = Math.floor(wy / SECTOR);
  const lx = ((wx % SECTOR) + SECTOR) % SECTOR, ly = ((wy % SECTOR) + SECTOR) % SECTOR;
  return { sx, sy, lx, ly, seed: sectorSeed(sx, sy) };
}

// get tile at world coords
function tileAtWorld(wx, wy) {
  const { lx, ly, seed } = resolve(wx, wy);
  return tileAtLocal(lx, ly, seed);
}

// find the gap position on a given edge of a sector
function gapPos(sx, sy, edge) {
  const seed = sectorSeed(sx, sy);
  if (edge === "left") return Math.floor(hash(0, 99, seed + 1) * (SECTOR - 4)) + 2;
  if (edge === "right") return Math.floor(hash(SECTOR - 1, 99, seed + 2) * (SECTOR - 4)) + 2;
  if (edge === "top") return Math.floor(hash(99, 0, seed + 3) * (SECTOR - 4)) + 2;
  if (edge === "bottom") return Math.floor(hash(99, SECTOR - 1, seed + 4) * (SECTOR - 4)) + 2;
}

const EMOJI = {
  floor: "🟫", wall: "🔳", shelf: "📚", chair: "🪑",
  drop: "⬛", banister: "◻️", gap: "⬛", player: "🟡"
};

function buildView(state) {
  const rows = [];
  for (let dy = -Math.floor(H/2); dy <= Math.floor(H/2); dy++) {
    const row = [];
    for (let dx = -Math.floor(W/2); dx <= Math.floor(W/2); dx++) {
      const wx = state.px + dx, wy = state.py + dy;
      if (dx === 0 && dy === 0) { row.push(EMOJI.player); continue; }
      row.push(EMOJI[tileAtWorld(wx, wy)]);
    }
    rows.push(row);
  }
  const map = rows.map(r => r.join("")).join("\n");
  const { sx, sy } = resolve(state.px, state.py);
  const desc = text(
    `\`\`\`
${map}
\`\`\``,
    `📍 sector [${sx},${sy}]  pos [${state.px},${state.py}]  steps:${state.steps}`,
    `⬛ drops/gaps  ◻️ banisters  🔳 walls  📚 shelves  🪑 chairs`
  );
  return {
    embeds: [embed({ title: "📖 infinite library abyss", description: desc, color: 0x8b6914, footer: { text: "walk through ⬛ gaps in the walls to new sectors" } })],
    rows: [
      row(button("up", "⬆️", { style: "secondary" }), button("left", "⬅️", { style: "secondary" }), button("down", "⬇️", { style: "secondary" }), button("right", "➡️", { style: "secondary" }))
    ]
  };
}

export default app({
  init(ctx) {
    // start in sector [0,0] at a safe floor
    const seed = sectorSeed(0, 0);
    let px = 16, py = 16;
    for (let i = 0; i < 200; i++) {
      const x = Math.floor(ctx.random() * (SECTOR - 4)) + 2;
      const y = Math.floor(ctx.random() * (SECTOR - 4)) + 2;
      if (tileAtLocal(x, y, seed) === "floor") { px = x; py = y; break; }
    }
    return { px, py, steps: 0, sectors: 1 };
  },
  update(state, action) {
    if (action.kind !== "button") return state;
    const moves = { up: [0,-1], down: [0,1], left: [-1,0], right: [1,0] };
    const m = moves[action.id];
    if (!m) return state;
    const nx = state.px + m[0], ny = state.py + m[1];
    const t = tileAtWorld(nx, ny);
    if (t === "wall" || t === "shelf" || t === "chair" || t === "drop" || t === "banister") {
      return state; // blocked
    }
    if (t === "gap") {
      // teleport to adjacent sector at the matching gap
      const { sx, sy, lx, ly } = resolve(state.px, state.py);
      let nsx = sx, nsy = sy, nlx, nly;
      if (lx === 0) { nsx = sx - 1; nlx = SECTOR - 1; nly = ly; }
      else if (lx === SECTOR - 1) { nsx = sx + 1; nlx = 0; nly = ly; }
      else if (ly === 0) { nsy = sy - 1; nly = SECTOR - 1; nlx = lx; }
      else { nsy = sy + 1; nly = 0; nlx = lx; }
      const npx = nsx * SECTOR + nlx, npy = nsy * SECTOR + nly;
      const visited = state.sectors + 1;
      return { ...state, px: npx, py: npy, steps: state.steps + 1, sectors: visited };
    }
    return { ...state, px: nx, py: ny, steps: state.steps + 1 };
  },
  view(state) {
    return buildView(state);
  }
});
