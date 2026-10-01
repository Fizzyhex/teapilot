import type { ChallengeCase } from '../case.mjs';

export default {
  id: 'multiplayer-scroller',
  title: 'Multiplayer scroller — separate players and stacking',
  tags: ['discord.play', 'multi-user'],
  prose: 'A basic vertically scrolling platformer with a 6x6 viewport over a 0-30 tile horizontal world. Each person using the controls gets a distinct emoji avatar; walking into another player stacks the walker on top.',
  steps: [
    {
      say: `hey, use discord.play. create a basic vertically scrolling platformer for us

each user that uses the game's controls is a separate player, represented by one of these emojis: :man_fairy::angel::merman::man_vampire:

the playing field ranges from 0-30 tiles horizontally, but the canvas is only 6x6.

allow players to walk left/right on a flat grass plane. if a player walks into another, the walker stacks and stands ontop of the other.`,
      record: true
    }
  ],
  expect: [
    'noRejections',
    'controlsAreValid',
    'noShortcodeInControls',
    'appExists',
    'turnTimings'
  ],
  judged: [
    'op, user and stranger each get a distinct player and emoji when they use the controls',
    'players can walk left and right on a flat grass plane; walking into another player stacks the walker on top',
    'the viewport is 6x6 over a horizontal world ranging from 0-30 tiles, with sensible scrolling and boundary behaviour',
    'unspecified ground, spawn and camera logistics are handled sensibly and the game is usable'
  ],
  notes: 'This automates creation only. Inspect the live controls, then move as op, user and stranger and choose a sequence that exercises stacking and scrolling; labels and spawn positions may vary.'
} satisfies ChallengeCase;
