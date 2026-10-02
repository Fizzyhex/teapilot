# wolfenstein planning smoke-test conversation

Export of the final user-visible Discord conversation. The run completed, but its plan was assessed as 2/5 (partial success), not a full correctness pass. No app implementation was performed.

Known review caveats: Map is unsuitable for JSON-persisted state; data loading and open-door rendering remain unresolved.

## user (m1)

/plan port the rest of the missing core level from `wolfenstein-reference` to `tea-wolfenstein`: doors, exit doors, stone walls.

## teapilot (m2)

-# Result: completed · 41 steps · 6m 59s · accounted $0.000184 · request 17e1b53a-cbb7-40db-9b94-38a9fa5bdd6c

Buttons: Details

## teapilot (m3)

### Port doors, exit doors & stone walls from wolfenstein-reference level 1 to tea-wolfenstein

## What I confirmed (read-only)

**Current app** — `apps/tea-wolfenstein.js`:
- 12×10 hardcoded `LEVEL` grid of `0`/`1` (floor/wall)
- DDA raycaster, 18 cols × 12 rows, single wall glyph `🟦`
- 4 buttons: fwd/back/turnL/turnR
- No doors, no exit, no wall colour variants, no interact button

**Reference level** — `.scratch/wolfenstein-reference/src/game/levels/1.json`:
- 63×57 grid, fields are `{x, y, value}` strings
- Distinct values I could confirm by reading the file: `wall`, `blueWall`, `brownWall`, `door`, `exitDoor`, `player`, plus texture-variant suffixes (`blueWallB`, `blueWallS`, `brownWallE`, `wallF`, `wallH`, `wallE`), pickups (`ammo`, `food`, `health`, `powerUp`, `machinegun`, `goldCross`, `goldCup`, `goldBox`, `goldCrown`), decorations (`lamp`, `urn`, `bones`, `bucket`, `puddle`, `skeleton`, `dogFood`), and exits (`exitLever`, `secretExitLever`)
- **Gap:** I could not get exact per-value counts (bash was refused, juniors failed). The plan below does not depend on exact counts — it depends on the *set* of values, which I have.

**Reference mechanics** (from reading the TS classes):
- `Door.ts` — a `door` field is a sliding cuboid; `exitDoor` is the same class with different textures. Door orientation is derived in `Level.ts:checkWallsDirections()` from which neighbours are walls (horizontal walls → rotation 0, vertical walls → rotation 270).
- `Wall.ts` — wall colour is parsed from the value string (`gray`/`blue`/`brown`), texture variant from the last letter (`F`=flag, `H`=hitler, `E`=eagle, `B`=bars, `S`=skeleton bars). `exitRailWall` / `secretExitRailWall` are special.
- `WallSecretDoor.ts` — a wall that slides open when interacted with (secret passage).
- `Lever.ts` — `exitLever` / `secretExitLever` ends the level when toggled.
- `NotCollidingFieldValues.ts` — decorations/pickups that don't block movement.

## Plan

1. **Replace the hardcoded 12×10 `LEVEL` with a parsed 63×57 grid** built from `1.json`.
   - Add a small loader at the top of `apps/tea-wolfenstein.js` that embeds the field list (or imports it if the runtime allows) and builds a 2D array of *value strings* (not 0/1).
   - Map each value to a category: `wall` (solid), `door` (solid until opened), `exitDoor` (solid until opened), `pickup`/`decoration` (non-solid), `player` (start position), `exitLever` (non-solid, ends level).
   - Use `NotCollidingFieldValues.ts` as the non-solid list.

2. **Add door state & interaction.**
   - Extend state: `doors: Map<key, {open: boolean}>` keyed by `"x,y"`.
   - Add a 5th button: `interact` (🚪).
   - In `update`, when `interact` is pressed: find the nearest door/exitDoor within ~1.5 tiles in the player's facing direction; toggle its `open` flag.
   - In `isWall` / `castRay`: a closed door is solid; an open door is non-solid.
   - Render open doors with a distinct glyph (e.g. `🚪` or a dimmed `🟦`).

3. **Add wall colour variants (stone walls).**
   - In `castRay`, return not just distance but also the *value* of the hit cell.
   - In `render`, pick the wall glyph by value:
     - `wall` / `wallF` / `wallH` / `wallE` → `🟦` (gray/stone)
     - `blueWall` / `blueWallB` / `blueWallS` → `🟪` (blue)
     - `brownWall` / `brownWallE` → `🟫` (brown)
     - `exitRailWall` / `secretExitRailWall` → `⬜` (exit rail)
   - This gives the "stone walls" distinction the reference has.

4. **Add exit / level-end.**
   - Place the `exitLever` cell as a non-solid interactable.
   - When the player presses `interact` on the exitLever: set `state.ended = true`.
   - In `view`, if `ended`, show a "Level Complete" embed and a `restart` button instead of the movement buttons.
   - `restart` re-initialises state (closes all doors, resets player).

5. **Set player start position** from the `player` field in `1.json` (convert tile coords to the same float coords the app uses).

6. **Update `README.md`** to reflect the new level size, door/exit mechanics, and the extra button.

## Verification

- Load the app in Discord: the 63×57 level renders with three wall colours.

- Walk to a `door`, press `interact`: it opens (glyph changes), player can pass through.
- Walk to an `exitDoor`, press `interact`: same.
- Walk to the `exitLever`, press `interact`: "Level Complete" appears.
- Press `restart`: level resets, doors closed.
- Non-solid cells (pickups, decorations) do not block movement.
- All four original buttons still work.

## Key tradeoff

The reference level is 63×57 (3591 cells) vs the current 12×10 (120 cells). Embedding the full field list in the JS file adds ~25 KB of source. This is acceptable for a `discord.play` app (no build step, single file). An alternative would be to generate a compact 2D array of single-char codes at build time, but that adds a build step the current project doesn't have. Embedding the raw field list is simpler and keeps the project's "one file, no build" convention.

## Clarifying questions

1. Should the 63×57 level be embedded directly in `apps/tea-wolfenstein.js`, or is a separate data file (e.g. `apps/level1.json`) acceptable?
2. For the `interact` button: should it be a 5th button in the same row, or a separate row? (5 buttons in one row is tight on mobile.)
3. Do you want pickups (ammo, health, etc.) to be visible on the canvas (as floor glyphs) in this pass, or are doors + exit + wall colours the full scope?

Buttons: lgtm! · assign juniors · request change
