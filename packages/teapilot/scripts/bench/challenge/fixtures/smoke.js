// A discord.play app the challenge cases can drive without a model, for testing the tooling itself:
// it shows an embed with a title and two controls, counts presses and ticks, and keeps its timer above
// the runtime's 2000 ms floor. Deliberately ordinary, so a check that passes against it is testing the
// check rather than the app.
import { after, button, embed, row, step } from '@teapilot/discord-play';

export default app({
  init: () => step({ pressed: 0, ticks: 0 }, after(2500, 'tick')),
  update: (state, action) => {
    if (action.kind === 'timer') return step({ ...state, ticks: state.ticks + 1 }, after(2500, 'tick'));
    if (action.kind === 'button') return { ...state, pressed: state.pressed + 1 };
    return state;
  },
  view: state => ({
    embeds: [embed({ title: 'the grinner’s meal', description: `pressed ${state.pressed}, ticked ${state.ticks}` })],
    rows: [row(button('left', '⬜ left'), button('right', '⬜ right'))],
  }),
});