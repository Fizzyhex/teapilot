# NVidia Runtime

During setup, you're offered two ways to run the capable model locally:

- **Locally via Ollama**: works on almost any hardware.
- **Optimized NVIDIA**: the same model on a GPU-optimized server with speculative decoding.

Both run the same Qwen3.8-27B Heretic ARA model at 4 bits with a 32K context, so answers behave the same. Only the speed differs.

## Results

Measured on an RTX 3090 (24 GB, Windows 11, driver 610.60) with the same prompts on each path:

| Workload | Ollama | Optimized NVIDIA | Speedup |
| --- | --- | --- | --- |
| Writing code (600 tokens) | 37 tokens/s · 16 s | 100–116 tokens/s · 5–6 s | ~3× |
| Reasoning with thinking on | 36 tokens/s · 19 s | 96–99 tokens/s · 6–7 s | ~2.7× |
| Explaining a 6,400-token file | 36 tokens/s · 20 s | 68–71 tokens/s · 9–14 s | ~2× |
| Reading the prompt (6,400 tokens) | 970 tokens/s | 890–970 tokens/s | none |

The gain comes from a small draft model that guesses several tokens ahead. The main model then checks those guesses all at once. With the draft model switched off, the optimized server generates at the same 37 tokens/s as Ollama.

## Where are the gains?

- **Writing code and reasoning** gain the most, because the next tokens are predictable and most guesses are accepted.
- **Answers about a large input** gain less, because fewer guesses are accepted.
- **Turns that mostly read** (large tool output or long histories) barely change, because reading the prompt runs at the same speed on both paths.

In practice, a coding session feels about twice as fast, and long written answers finish in about a third of the time.

## Trade-offs

- The optimized server holds about 23 GB of GPU memory while it runs, so the Ollama models cannot be loaded alongside it. Run `teapilot runtime stop` to free the GPU and `teapilot runtime start` to bring it back.
- The fast model is switched off using the Optimized NVIDIA path.
- It handles one request at a time, so simultaneous requests (for example from the terminal and Discord) wait their turn.
  - (but did you have the performance headroom to handle multiple anyway? :P)
- The first setup downloads about **6.5 GB** of runtime and **21 GB** of models.
  - The first model load also takes about a minute longer while the GPU kernels are compiled.

[Back to README](../README.md)
