---
name: discord-play-fine-tuner
description: run simulated user-scenarios against teapilot for improving production of `discord.play` applications.
---

```agent_instructions
You are a professional AI Data Scientist / SWE.

Your goal is recursive improvement and alignment of teapilot's output (response time, accuracy, successful completions), by testing its ability against realistic use-cases and evaluating the results.

Use the `agent-discord.mjs` to interact with teapilot. Discover frustrations, bugs, and opportunities for improvement. You may fine tune by:

- Tweaking the `src/agents/play.ts` system prompt, and anything relevant to improving the result / your testing experience.
- Iterating on, adding, and improving agent tooling.

---

Approve permissions `teapilot` and juniors within reason - they land into a sandbox. Allow reputable package installs, and web fetches that are related the agent's task.  

You should produce a short report before/after runs for review - and score output for comparison at the end.

Tweaks to system prompts should be generalised - and not 'cheat' by optimising for specific case-by-case scenarios.

teapilot has a minimalist philosophy for system prompts - much like `pi.dev`.

At the end, write your report to `feedback/finetuning-reports/yyyy-mm-dd-finetune-<index>.md`

YOU ARE ALLOWED TO IMPROVE TEAPILOT IN GENERIC WAYS, AND ARE ENCOURAGED TO DO SO AFTER EACH RUN. THIS MAY INCLUDE INTRODUCING NEW SKILLS, FINE TUNING OR EXPANDING CAPABILITIES.
```

## Verifying a case

Don't judge a case by teapilot's reply alone. Check the app itself:

- `app <name> <id>` shows the code the model wrote, its state and its recent actions. Use `apps <name>` to find the id.
- `screen <name>` shows what people see. `⚠` lines mean Discord would have rejected something, and that counts as a failure.
- Play it: use `click`, `select` and `submit`, with `--as op|user|stranger` to act as different people.
- Timers: use `advance <name> 30s` instead of waiting, and check whether the app ticks with `after()` and how often.
- Rejections: `screen` only lists tool names. `log <name>` shows what each `play_*` tool returned (e.g. why a `play_start` was rejected), so check it when a turn retries or hits the context limit.
- Survival: `restart <name>` mid-game should leave the app working.
- Files: attach with `say <name> "..." --attach path`. Open the path on each `📎` line to check what teapilot sent or an app shows (images can be viewed directly), not only its name.

## Typed cases and smoke tests

Use `packages/teapilot/scripts/bench/challenge/cases/*.ts` as guidelines for your own smoke tests. Read the chosen case's prompt, `steps`, `judged` and `notes`, then adapt it loosely to the task and the app teapilot actually produces. The migrated play examples are `snake`, `multiplayer-scroller` and `recipe-book`.

Agent evaluation is up to your interpretation, backed by observed behaviour. Don't copy assertions blindly or treat passing mechanical checks as proof that teapilot fulfilled the request correctly. `expect` only checks a mechanical slice; even `judged` is a starting point, not an exhaustive rubric. Decide what the user needs, play through it, and explain your verdict with evidence. Distinguish an app failure from a probe that used the wrong control or lacked evidence; `unscored` is not a pass.

Examples to adapt:

- **snake:** vary the board or skin; inspect the live controls, steer to food, lose and replay, then request a cosmetic change. Check that movement, growth, collision and the follow-up actually work. Emoji in source and valid buttons alone don't prove a playable game.
- **multiplayer scroller:** move as `op`, `user` and `stranger`, using the controls the app exposes. Check distinct avatars, walking into another player and stacking, then explore the edge of the world and camera movement. Adapt positions and timing rather than assuming a fixed button sequence or spawn layout.
- **recipe book:** discover the form's actual field ids, request two recipes of your choice, switch between them using the live dropdown values, and ask for icons and trivia. Check the generated content, navigation and follow-up, not just whether the source mentions `consult()`.

## Benchmark tooling

Read `packages/teapilot/scripts/bench/challenge/README.md` for the runner, evidence and reporting options. Discover and inspect cases without spending a model:

```sh
node packages/teapilot/scripts/bench/challenge/case.mjs list
node packages/teapilot/scripts/bench/challenge/case.mjs show snake --json
node packages/teapilot/scripts/bench/challenge/case.mjs run snake --name snake-dry --out feedback/bench-runs/snake-dry --dry-run
```

Use `agent-discord.mjs` for exploratory smoke tests; use `case.mjs run` when the declarative steps fit the test you want. A runner example (real models, real cost):

```sh
node packages/teapilot/scripts/bench/challenge/case.mjs run snake --name snake-before --out feedback/bench-runs/snake-before --label before
```

The runner captures evidence before stopping its session. For a session you drive yourself, capture before `stop` deletes the session and its attachments:

```sh
node packages/teapilot/scripts/bench/challenge/evidence.mjs capture --name smoke --out feedback/bench-runs/smoke
node packages/teapilot/scripts/agent-discord.mjs stop smoke
node packages/teapilot/scripts/bench/challenge/report.mjs score --dir feedback/bench-runs/smoke
```

Always stop sessions you start, and read approvals before answering them. Inspect live controls and forms rather than forcing the case's labels or field ids onto a different app. A blocked runner is not a completed evaluation; investigate it and continue with an appropriate probe if needed.

For before/after comparisons, keep a comparable prompt, model, case set and test scope, record adaptations, and retain evidence for both runs. Use `report.mjs batch`, `compare` and `cheat-check` where useful, but supplement their results with your own judgement of correctness, usability and responsiveness. Report mechanical verdicts, missing evidence and qualitative findings separately; don't turn a check count into a claim of request fulfillment.

## Special challenge cases

When specifically asked for a challenge family, use the corresponding typed cases as starting points. Their prose supplies the intent; adapt probes without weakening that intent.

"challenge name" : "files under `packages/teapilot/scripts/bench/challenge/cases`"
- `convo switching` -> `conversation-1c-casual.ts` or `conversation-2c-banter.ts`
- `ultra challenges` -> `ultra-1u-kessel.ts`, `ultra-2u-library-abyss.ts`
- `file challenges` -> `file-1f-image-rotate.ts`, `file-2f-mod-my-game.ts`
- `conversation challenges` -> `conversation-1c-casual.ts`, `conversation-2c-banter.ts`
- `scratchpad benchmark` (ScratchBench) -> `scratchbench-1-import-audit.ts`
- `orchestration challenge` -> `orchestration-1o-greggs.ts`
- `git benchmark` (GitBench) -> `gitbench-1-offline-kiosk.ts`

## `discord.play`

Reward context-aware adaptations. For game ports, teapilot suggesting that games are adapted to use control schema that fits limitations of Discord components and emojis for display is good.