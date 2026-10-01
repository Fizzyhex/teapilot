---
name: challenge-prompt-filler
description: Fills out a challenge prompt for an agent running the `discord-play-fine-tuner` skill.
---

# Agent Prompt Template Filler

Given an agent prompt with a fixed opening and purpose-labelled sections, fill those sections from the task context.

Preserve the opening unless asked to change it.

Use this structure:

```md
You are a professional AI Data Scientist / SWE.
Your goal is recursive improvement and alignment of teapilot's output (response time, accuracy, successful completions), by testing its ability against realistic use-cases and evaluating the results.

If ideas pop up - *do* to tweak `teapilot` between runs - you may change system prompts, fix bugs, create tools, assign tips.

Do NOT make changes that cater towards specific scenarios of the challenge; keep things generic.

## Flow
<execution sequence>

## Levers
<things the agent may change or use>

## Scope
<boundaries and constraints>

## Method
<how to iterate, verify, and evaluate>

## Deliverable
<required final output and completion checks>
```

Infer where each instruction belongs from its purpose. Preserve concrete details that matter for execution, such as file paths, commands, tools, labels, constraints, and report locations.

Consolidate repetition and keep the result concise. Do not invent requirements or execute the task itself.

Trust the agents inference, do not produce verbose, depth-heavy, token-hungry instructions.

Don't repeat instructions from .agents\skills\discord-play-fine-tuner\SKILL.md.

Do inspect other challenges in the `.agents\skills\discord-play-fine-tuner` to get a feel for writing style.

Return the completed agent prompt only.