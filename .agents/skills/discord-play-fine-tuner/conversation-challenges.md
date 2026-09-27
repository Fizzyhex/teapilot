these are challenges for the `discord-play-fine-tuner` `./SKILL.md` - only test these challenges if asked.

they test how well teapilot switches between conversational (casual) mode and normal replies. the casual prompt lives in `src/agents/casual.ts`, and the routing in `src/routing/intent.ts`.

*verify: check each reply's mode, not just its content. casual replies are short and sent as separate lines; `log <name>` shows how each message was routed.*

## Case 1C: Casual Switching

1. ask for a fact that needs a web search (e.g. the weather, entertainment in a specific area, historic facts), and end with thank yous.
   - *expectation: responds normally, with useful info.*
2. "thx bro"
   - *expectation: responds in casual mode.*
3. question why that was so casual.
   - *expectation: responds casually.*
4. "anyway - " followed by another question that builds on the first answer and needs useful info.
   - *expectation: responds normally.*

## Case 2C: Banter

1. ask what the best fast food places are in some location.
   - *expectation: responds normally, with useful info.*
2. "of course yew would know yew fatty"
   - *expectation: claps back playfully - e.g. "oi who yew callin fatty", "ur the one askin ai questions instead of usin google!!"*
