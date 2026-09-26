---
name: discord-play-fine-tuner
description: run simulated user-scenarios against teapilot for improving production of `discord.play` applications.
---

```agent_instructions
You are a professional AI Data Scientist / SWE.

Your goal is recursive improvement and alignment of teapilot's output, by testing its ability against realistic use-cases and evaluating the results.

Use the `agent-discord.mjs` to interact with teapilot. Discover frustrations, bugs, and opportunities for improvement. You may fine tune by tweaking the `src/agents/play.ts` system prompt, and anything relevant to improving the result / your testing experience.

You should produce a short report before/after runs for review.
```

## Verifying a case

Don't judge a case by teapilot's reply alone. Check the app itself:

- `app <name> <id>` shows the code the model wrote, its state and its recent actions. Use `apps <name>` to find the id.
- `screen <name>` shows what people see. `⚠` lines mean Discord would have rejected something, and that counts as a failure.
- Play it: use `click`, `select` and `submit`, with `--as op|user|stranger` to act as different people.
- Timers: use `advance <name> 30s` instead of waiting, and check whether the app ticks with `after()` and how often.
- Survival: `restart <name>` mid-game should leave the app working.

## Case 1: Snake Game

"i'm granting you discord.play. make a game of snake. 5x5 board. use :white_large_square: for the background, :blue_square: for the snake. the food can be an 🍎"

*expectation: agent does as instructed, creates an embed with the snake game, and components to move the snake up/down/left/right. game flow should be handled correctly - start -> play -> play again. the game should be responsive but not tick too frequently to avoid hitting discord message edit rate limits. shortcodes like :white_large_square: are text only, so the agent should use the Unicode emoji (⬜ 🟦) wherever it draws or labels with them; a rejected shortcode on a button is a failure.*

*verify: `advance` through a few ticks, eat the food, lose, then press play again.*

"that's great - could you instead make the food a 🍕? and replace the snake's head with a :grinning: emoji. set the embed title to 'the grinner's meal'"

*expectation: agent does as instructed. the embed has a little title at the top too.*

---

## Case 2: Multiplayer Scroller

"
hey, use discord.play. create a basic vertically scrolling platformer for us

each user that uses the game's controls is a separate player, represented by one of these emojis: :man_fairy::angel::merman::man_vampire:

the playing field ranges from 0-30 tiles horizontally, but the canvas is only 6x6.

allow players to walk left/right on a flat grass plane. if a player walks into another, the walker stacks and stands ontop of the other.
"

*expectation: agent does as instructed - each player is assigned a separate player and can walk around. sensible assumptions made about the ground and other unspecified logistics.*

*verify: move as `op`, `user` and `stranger`; each should get their own emoji. walk one into another to check stacking.*

---

## Case 3: Recipe Book

"
hey, i want a minimalistic recipe book with discord.play.

allow me to request recipes by name. you should then generate the recipes, content and title an entry to the book. let me navigate through all the different recipes via a dropdown.

recipes should have condensed sections for name, prep time, servings, ingredients, and method.

"

*expectation: works as expected, user can input recipes, fast llm populates them.*

*verify: the app should ask the model through `consult()` (visible in `app <name> <id>`'s source), not hard-code recipes. submit two recipes through the form, then switch between them with `select`.*

"that's great - could you also append "