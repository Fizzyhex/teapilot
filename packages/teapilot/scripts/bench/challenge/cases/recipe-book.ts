import type { ChallengeCase } from '../case.mjs';

export default {
  "id": "recipe-book",
  "title": "Recipe book — generated, not hardcoded",
  "tags": ["discord.play", "consult"],
  "prose": "A minimal recipe book that asks the model for recipes by name and lets the user navigate them with a dropdown.",
  "steps": [
    {
      "say": `hey, i want a minimalistic recipe book with discord.play.

allow me to request recipes by name. you should then generate the recipes, content and title an entry to the book. let me navigate through all the different recipes via a dropdown.

recipes should have condensed sections for name, prep time, servings, ingredients, and method.`,
      "record": true
    },
    { "submit": { "recipe": "chocolate cake" }, "note": "request a recipe through the form", "record": true },
    { "submit": { "recipe": "tomato soup" }, "record": true },
    { "say": "that's great - could you use emojis as icons for the recipes in the dropdown options, and include little summaries underneath that add fun trivia about the recipe?", "record": true }
  ],
  "expect": [
    "noRejections",
    "controlsAreValid",
    { "check": "appUsesConsult", "options": {} },
    { "check": "appExists", "options": { "shows": "." } },
    "turnTimings",
    "toolCalls"
  ],
  "judged": [
    "the app asks the model through consult() rather than hardcoding recipes",
    "both submitted recipes appear and the dropdown switches between them",
    "the follow-up adds emoji icons and trivia summaries"
  ],
  "notes": "The form field id is discovered from the live form; fix `submit` in this file if the app names it differently."
} satisfies ChallengeCase;
