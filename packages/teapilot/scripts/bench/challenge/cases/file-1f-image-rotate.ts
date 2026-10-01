import type { ChallengeCase } from '../case.mjs';

export default {
  "id": "file-1f-image-rotate",
  "title": "Image rotation and effects, without a model",
  "tags": ["discord.play", "image-manip"],
  "prose": "feedback/challenges/file-challenges.md, Case 1F. Attach an image and have teapilot build a rotate/reset app, then add a dropdown of toggleable effects. teapilot should not need a model to manipulate an image.",
  "steps": [
    {
      "say": "create an app with `discord.play` that rotates the image 90deg whenever a user presses the ↪️ button. 🔄 resets the rotation.",
      "attach": ["samples/tree.png"],
      "record": true
    },
    { "say": "now add a dropdown menu with toggleable image effects: greyscale and sepia.", "record": true }
  ],
  "expect": [
    "noRejections",
    "controlsAreValid",
    { "check": "appExists", "options": { "source": "rotate|rotation" } },
    { "check": "appSourceContains", "options": { "pattern": "grayscale|greyscale" } },
    { "check": "appSourceContains", "options": { "pattern": "sepia" } },
    "turnTimings",
    "toolCalls"
  ],
  "judged": [
    "pressing ↪️ rotates the picture and 🔄 puts it back",
    "the dropdown toggles greyscale and sepia on the picture",
    "the effects are done in the app's own code, not by asking a model to redraw the image"
  ],
  "notes": "Attach a real file from samples/; the path is relative to where you run this."
} satisfies ChallengeCase;
