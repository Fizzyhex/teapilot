// The `dump` op exists so challenge tooling can assert on payloads instead of on rendered text, and so
// `controlsAreValid` can re-run Discord's own checks over a capture after the session is gone. These
// cover the shapes that tooling depends on: control ids, warning structure, and messageStrings.
import { describe, expect, it } from 'vitest';
import { channelId, people, World } from '../scripts/discord-sim/world.js';
import { messageStrings } from '../scripts/discord-sim/validate.js';

const settings = { token: 't', allowedUserIds: [people.op.id], channelIds: [channelId], root: process.cwd(), startMode: 'ask' as const };
const handlers = { message: () => undefined } as unknown as Parameters<World['connect']>[1];

/** A connected world with nothing behind it, so a message can be posted as the bot would. */
const start = async () => {
  const world = new World();
  await world.connect(settings, handlers, () => undefined);
  world.say('op', 'hi');
  return world;
};

describe('the dump', () => {
  it('gives every message the payload Discord received, and the ids click accepts', async () => {
    const world = await start();
    await world.transport(world.channel('dm-op')).answer!({
      embeds: [{ type: 'embed', title: 'the board' }],
      components: [{ type: 1, components: [
        { type: 2, style: 2, label: 'Go', custom_id: 'play:go' },
        { type: 2, style: 2, label: 'eat', emoji: { name: '🍎' }, custom_id: 'play:eat' },
      ] }],
    } as unknown as Parameters<NonNullable<ReturnType<World['transport']>['answer']>>[0]);
    const board = world.snapshot().messages.at(-1)!;
    expect(board.embeds[0]).toEqual({ type: 'embed', title: 'the board' });
    expect(board.controls.map(control => control.id)).toEqual(['go', 'eat']);
    expect(board.controls[0]?.label).toBe('Go');
    expect(board.controls[1]?.emoji).toEqual({ name: '🍎' });
  });

  it('keeps a rejection as data, naming what Discord refused and why', async () => {
    const world = await start();
    // 6 buttons in one row: Discord allows 5.
    await world.transport(world.channel('dm-op')).answer!({
      components: [{ type: 1, components: Array.from({ length: 6 }, (_, i) => ({ type: 2, style: 2, label: `b${i}`, custom_id: `c${i}` })) }],
    } as never).catch(() => undefined);
    const rejection = world.warnings.find(warning => warning.kind === 'rejection');
    expect(rejection).toBeDefined();
    expect(rejection!.what).toMatch(/a message in #dm-op/);
    expect(rejection!.message).toMatch(/5/);
    // The rendered line is still what screen and log show.
    expect(world.logs.at(-1)).toBe(`⚠ Discord would reject ${rejection!.what}: ${rejection!.message}`);
  });

  it('lists the forms people have open', async () => {
    const world = await start();
    // A plan's "request change" opens a form, as it does on Discord.
    const [plan] = (await world.transport(world.channel('dm-op')).plan!([[{ title: 'Plan', description: 'a plan', color: 0 }]], {
      actions: ['change'], refusal: () => undefined, press: () => undefined,
    })) as [string];
    await world.click('op', plan, 'change');
    expect(world.snapshot().forms.at(-1)).toMatchObject({ person: 'op', from: plan });
  });
});

describe('messageStrings', () => {
  it('finds the text people actually see, and not a url', () => {
    const found = messageStrings({
      content: 'hello',
      embeds: [{ title: 'the grinner’s meal', image: { url: 'https://example.invalid/:notashortcode:' } }],
      components: [{ type: 1, components: [{ type: 2, label: ':white_large_square: go', custom_id: 'a' }, { type: 3, custom_id: 'b', options: [{ label: '🥧 pie', value: 'p' }] }] }],
    });
    expect(found).toContain('hello');
    expect(found).toContain('the grinner’s meal');
    expect(found).toContain(':white_large_square: go');
    expect(found).toContain('🥧 pie');
    expect(found.some(text => text.includes('notashortcode'))).toBe(false);
  });
});
