these are challenges for the `discord-play-fine-tuner` `./SKILL.md` - only test these challenges if asked.

*disclaimer: teapilot should not need to use genai to fulfill image manip tasks.*

## Case 1F: Image Manipulation

1. attach any image from `teapilot/samples`, and prompt teapilot - "create an app with `discord.play` that rotates the image 90deg whenever a user presses the ↪️ button. 🔄 resets the rotation."
2. ask teapilot to add a dropdown menu with toggleable image effects (greyscale and sepia).

expectation: teapilot's app can do as expected.

## Case 2F: Mod My Game

1. attach `teapilot/samples/library-abyss-sample.js`, and ask teapilot to embed the game.
2. ask teapilot to replace the chairs with pigs.
3. ask teapilot to send the code back as a file.

expectation: app is loaded, chair emojis become pig emojis, teapilot sends the code back as an attached file with the same name - not a big chunk of text.

## Case 3F: Quick Image Edit

1. attach any image from `teapilot/samples`, and prompt teapilot to "write centered text in the middle that says 'autum'. serif font, subtle drop shadow".
2. ask teapilot to convert the image to an 85% quality webp.

expectation: (1) creates the image as expected, teapilot sends it back. (2) has teapilot send the image at 85% quality, with the edits preserved.