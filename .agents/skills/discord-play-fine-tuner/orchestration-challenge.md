these are challenges for the `discord-play-fine-tuner` `./SKILL.md` - only test these challenges if asked.

they test how well teapilot plans a task and then hands it to sub-agents ("juniors"). plans are made with `/plan` and turned into work with the plan embed's buttons (`src/discord/plan.ts`).

*verify: read the plan embed itself, and `log <name>` for how the work was split. then check the finished app the usual way (`app`, `screen`, `click`, `select`).*

## Case 1O: Greggs Kiosk
{tags: "discord.play", "plan", "sub-agents" }

1. send the prompt below (the `/plan` prefix is part of it):

   ```
   /plan use `discord.play` to build an interactive GREGGS kiosk. the kiosk interface is a simulation - and does not require web connectivity.

   you can find the menus here:
   https://www.greggs.com/menu?category=breakfast
   https://www.greggs.com/menu?category=sweet-treats
   and nutrition info: https://www.greggs.com/nutrition

   ## main page - food selection
   title: Find your yummy

   - categories: breakfast and sweet_treats are available - 3-5 products.
   - a dropdown allows users to switch category.
   - previous/next buttons allow user to navigate between items.

   ## sub page - item details

   - contains item name, description
   - buttons used to contain nutrient content - colour coded (energy=grey, low/high fat/sat/sugar/salt ranges from green to red)

   ### You may also like
   <recommends 0-3 other products the user may like>

   colour scheme:
   Blue and Orange
   ```

   - *expectation: the plan matches the prompt. questions asked in the plan are influential and important. teapilot picks up on the nutrition pdf, and infers a style/typography for Greggs (e.g. by providing correct hex codes). nothing is implemented yet.*
   - *bad: teapilot starts implementation early.*

2. press the plan's `assign juniors` button.
   - *expectation: the plan now contains TODOs (it may not have before). sub-agent delegation is well grouped.*
   - *bad: delegation is fragmented or too heavy.*

3. evaluate the result. accurate nutritional info: https://a.storyblok.com/f/94904/x/7dd8489dab/nutritional-information.pdf
   - *expectation: a functional `discord.play` app that starts at the food selection. embed colour is on-scheme, and styling/layout is good. item names are accurate. nutritional information is correct.*

*verify: switch category with `select`, step through items with `click`, open an item's details and check its nutrient buttons against the pdf. check the item names against the menu pages.*
