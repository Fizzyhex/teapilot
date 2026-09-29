import { afterEach, expect, it, vi } from 'vitest';
import type { AccessStore } from '../src/discord/access-store.js';
import { Conversation, TurnQueue, type ConversationOptions, type DiscordTransport } from '../src/discord/bridge.js';
import { approvePrompt, changePrompt, extractPlan, juniorsPrompt, PLAN_COLOUR, planMessages, type PlanControls, type PlanEmbed } from '../src/discord/plan.js';
import type { HostResult } from '../src/host.js';

const plan = '# Tea timer\n\n## Goal\n\nBrew on time.\n\n## Steps\n\n- boil water';
const answer = (text: string): HostResult => ({ requestId: 'req', success: true, status: 'completed', text, spentUsd: 0, receipts: [], attempts: 1 });

it('finds the plan in a reply and keeps the text around it', () => {
  expect(extractPlan(`Here you go.\n<plan>\n${plan}\n</plan>\nThoughts?`)).toEqual({ before: 'Here you go.', plan, after: 'Thoughts?' });
  expect(extractPlan('<plan>never closed')).toBeUndefined();
  expect(extractPlan('no plan here')).toBeUndefined();
});

it('shows a plan as one accent-coloured embed titled by its heading, with the footer on it', () => {
  expect(planMessages(plan, '✅ Approved by op')).toEqual([[{ title: 'Tea timer', description: '## Goal\n\nBrew on time.\n\n## Steps\n\n- boil water', color: PLAN_COLOUR, footer: { text: '✅ Approved by op' } }]]);
  expect(PLAN_COLOUR).toBe(0xbabbf1);
});

it('splits a long plan across embeds and messages within the limits, footer on the last embed only', () => {
  const long = `# Big\n\n${Array.from({ length: 400 }, (_, index) => `- step ${index} ${'x'.repeat(60)}`).join('\n')}`;
  const messages = planMessages(long, 'note');
  expect(messages.length).toBeGreaterThan(1);
  const embeds = messages.flat();
  for (const message of messages) {
    expect(message.length).toBeLessThanOrEqual(10);
    expect(message.reduce((total, embed) => total + (embed.title?.length ?? 0) + embed.description.length + (embed.footer?.text.length ?? 0), 0)).toBeLessThanOrEqual(6000);
  }
  expect(embeds.every(embed => embed.description.length <= 4096 && embed.color === PLAN_COLOUR)).toBe(true);
  expect(embeds.filter(embed => embed.title)).toHaveLength(1);
  expect(embeds.filter(embed => embed.footer)).toEqual([embeds.at(-1)]);
  expect(embeds.map(embed => embed.description).join('\n')).toContain('step 399');
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const access = { roleOf: (id: string) => id === 'op' ? 'operator' : undefined, adminFor: () => undefined, callerFor: () => () => ({ permissions: [] }) } as unknown as AccessStore;

function plans() {
  const sent: string[] = [];
  /** Every painting of a plan, newest last. */
  const paints: Array<{ messages: PlanEmbed[][]; controls: PlanControls; ids?: string[] }> = [];
  let counter = 0;
  const transport: DiscordTransport = {
    send: vi.fn(async (text: string) => { sent.push(text); return `s${sent.length}`; }),
    edit: vi.fn(async () => undefined),
    card: vi.fn(async () => 'card'),
    typing: vi.fn(),
    askApproval: vi.fn(async () => true),
    plan: vi.fn(async (messages: PlanEmbed[][], controls: PlanControls, ids?: string[]) => { paints.push({ messages, controls, ids }); return messages.map((_, index) => ids?.[index] ?? `p${++counter}`); }),
  };
  const controller = new AbortController();
  const replies: string[] = [];
  const prompts: string[] = [];
  const run = vi.fn<ConversationOptions['run']>(async request => { prompts.push(request.prompt); return answer(replies.shift() ?? 'ok'); });
  const chat = new Conversation({ key: 'dm:test', queue: new TurnQueue(), maxPromptChars: 20_000, log: vi.fn(), cardDelayMs: 0, redact: text => text, access,
    request: { prompt: '', cwd: '.', mode: 'ask', signal: controller.signal }, run, transport });
  cleanups.push(async () => { controller.abort(); await chat.done; });
  return { chat, sent, paints, prompts, replies };
}
const user = { id: 'op', name: 'op' };

it('posts a plan as an embed with all three buttons, and the text around it as messages', async () => {
  const { chat, sent, paints, replies } = plans();
  replies.push(`Ready.\n<plan>\n${plan}\n</plan>`);
  chat.push('/plan a tea timer', { sender: 'op' });
  await vi.waitFor(() => expect(paints).toHaveLength(1));
  expect(sent).toContain('Ready.');
  expect(paints[0]!.controls.actions).toEqual(['approve', 'juniors', 'change']);
  expect(paints[0]!.messages[0]![0]!.title).toBe('Tea timer');
});

it('sends each button\'s prompt for the user and refines the same embed instead of posting the plan again', async () => {
  const { chat, sent, paints, prompts, replies } = plans();
  replies.push(`<plan>\n${plan}\n</plan>`);
  chat.push('/plan a tea timer', { sender: 'op' });
  await vi.waitFor(() => expect(paints).toHaveLength(1));

  replies.push('<plan>\n# Tea timer v1.1\n\nchunked\n</plan>');
  expect(paints[0]!.controls.press('juniors', user)).toBeUndefined();
  await vi.waitFor(() => expect(prompts).toHaveLength(2));
  expect(prompts[1]).toBe(juniorsPrompt);
  // The buttons go away, with a note, while the turn runs; the refined plan then lands on the same message.
  await vi.waitFor(() => expect(paints.at(-1)!.messages[0]![0]!.title).toBe('Tea timer v1.1'));
  expect(paints.at(-1)!.controls.actions).toEqual(['approve', 'juniors', 'change']);
  expect(paints.some(paint => paint.messages[0]![0]!.footer?.text === '♟️ Assigning juniors…' && paint.controls.actions.length === 0)).toBe(true);
  expect(paints.every(paint => paint.messages[0]![0]!.color === PLAN_COLOUR)).toBe(true);
  expect(paints.at(-1)!.ids).toEqual(['p1']);

  replies.push('<plan>\n# Tea timer v2\n\nbetter\n</plan>');
  expect(paints.at(-1)!.controls.press('change', user, 'add a kettle step')).toBeUndefined();
  await vi.waitFor(() => expect(prompts).toHaveLength(3));
  expect(prompts[2]).toBe(changePrompt('add a kettle step'));
  await vi.waitFor(() => expect(paints.at(-1)!.messages[0]![0]!.title).toBe('Tea timer v2'));
  expect(paints.at(-1)!.ids).toEqual(['p1']);
  expect(sent).toEqual([]);
});

it('restores the buttons when a refinement comes back without a plan, and settles the plan on approve', async () => {
  const { chat, paints, prompts, replies } = plans();
  replies.push(`<plan>\n${plan}\n</plan>`, 'Done thinking, nothing to change.');
  chat.push('/plan a tea timer', { sender: 'op' });
  await vi.waitFor(() => expect(paints).toHaveLength(1));
  paints[0]!.controls.press('change', user, 'tweak');
  await vi.waitFor(() => expect(prompts).toHaveLength(2));
  await vi.waitFor(() => expect(paints.at(-1)!.controls.actions).toHaveLength(3));
  expect(paints.at(-1)!.messages[0]![0]!.footer).toBeUndefined();

  expect(paints.at(-1)!.controls.press('approve', user)).toBeUndefined();
  await vi.waitFor(() => expect(prompts).toHaveLength(3));
  expect(prompts[2]).toBe(approvePrompt);
  await vi.waitFor(() => expect(paints.at(-1)!.controls.actions).toEqual([]));
  expect(paints.at(-1)!.messages[0]![0]!.footer?.text).toBe('✅ Approved by op');
});

it('refuses people teapilot does not know, and the buttons of a replaced plan', async () => {
  const { chat, paints, replies } = plans();
  replies.push(`<plan>\n${plan}\n</plan>`, '<plan>\n# Another\n\nx\n</plan>');
  chat.push('/plan one', { sender: 'op' });
  await vi.waitFor(() => expect(paints).toHaveLength(1));
  const first = paints[0]!.controls;
  expect(first.press('approve', { id: 'mallory', name: 'mallory' })).toMatch(/not allowed/);
  chat.push('/plan two', { sender: 'op' });
  await vi.waitFor(() => expect(paints.at(-1)!.messages[0]![0]!.title).toBe('Another'));
  expect(paints.some(paint => paint.messages[0]![0]!.footer?.text === 'superseded by a newer plan')).toBe(true);
  expect(first.press('approve', user)).toMatch(/replaced or settled/);
});
