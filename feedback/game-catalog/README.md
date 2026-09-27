# Game catalog

`discord.play` apps teapilot wrote during fine-tuning runs, kept as written: bugs included, so they can be replayed, compared or used as test fixtures. Each file is a complete app: start it with `play_start` (put the file in a repository and pass `path`), or paste it into a code block. Scores and the prompts behind each run are in [the fine-tuning report](../finetuning-reports/2026-09-27-finetune-2.md).

All were written by the local Qwen 27B on 2026-09-27.

| File | Challenge | Score | Known problems |
|---|---|---|---|
| [library-abyss-run-1.js](library-abyss-run-1.js) | 2U library abyss, after the sector-gap follow-up | 8.5/10 | Walls are random scatter inside sectors. Gaps teleport from the pre-step position, so every gap leads to the sector below and lands on its wall. |
| [library-abyss-run-2.js](library-abyss-run-2.js) | 2U library abyss, after the sector-gap follow-up | 8/10 | The best gap logic: each side leads to the right neighbour. Drops show as single ⬛ tiles, not 2×2, and some gaps are blocked from inside by a shelf or chair. |
| [library-abyss-run-3.js](library-abyss-run-3.js) | 2U library abyss, after the sector-gap follow-up | 7/10 | The neatest 2×2 drops with banister rings. A new game starts in a sector's corner wall with no way out, and every gap leads to the sector above. |
| [library-abyss-iteration.js](library-abyss-iteration.js) | 2U library abyss, tuning run | not scored | Chairs and banisters can seal the player into a small pocket, and the gap teleport lands in the wrong place. |
| [kessel-sabacc-run-3.js](kessel-sabacc-run-3.js) | 1U Kessel Sabacc | 3/10 | No Impostor or Sylop cards, hands shown to everyone, and the turn counter never advances, so a round never reaches the reveal. |

## Not recoverable

The co-op farm games (3U) and the other Kessel builds were lost: the simulator deletes a session's apps when the session stops. The farm from final run 2 (7.5/10, all five turns completed) is the one worth rebuilding; its prompts are in the report.
