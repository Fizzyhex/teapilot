import { expect, it } from 'vitest';
import { chunk, IS_COMPONENTS_V2, layout, type Resolved } from '../src/index.js';

const data = Buffer.from('x');
const files: Record<string, Resolved> = {
  'chart.png': { name: 'chart.png', data, image: true },
  'dir/chart.png': { name: 'chart.png', data, image: true },
  'script.py': { name: 'script.py', data, image: false },
};
const resolve = (ref: string) => files[ref];

it('sends plain text exactly as chunk splits it', async () => {
  const text = `Title\n---\n${'word '.repeat(900)}\n\`\`\`\n| a |\n|---|\n\`\`\``;
  expect(await layout(text, { resolve })).toEqual(chunk(text).map(content => ({ content, source: content })));
});

it('posts each table as an embed of its own, between plain messages', async () => {
  const messages = await layout('before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter', { resolve, viewSourcePrefix: 'x:' });
  expect(messages).toEqual([
    { content: 'before', source: 'before' },
    { embeds: [{ fields: [{ name: 'a', value: '1', inline: true }, { name: 'b', value: '2', inline: true }] }], components: [{ type: 1, components: [{ type: 2, style: 2, label: 'view source', custom_id: 'x:columns' }] }], source: '| a | b |\n|---|---|\n| 1 | 2 |' },
    { content: 'after', source: 'after' },
  ]);
});

it('puts a table Discord would cut short in a code block', async () => {
  const rows = Array.from({ length: 30 }, (_, row) => `| ${'x'.repeat(50)} ${row} | y |`).join('\n');
  const [message, ...rest] = await layout(`| a | b |\n|---|---|\n${rows}`);
  expect(rest).toEqual([]);
  expect(message!.content).toMatch(/^```\na +\| b\n/);
});

it('lays dividers, a thumbnail, a gallery and a file out as components', async () => {
  const messages = await layout('first\n\nnext to the picture\n![a chart](chart.png)\n\n---\n\n![one](chart.png)\n![two](dir/chart.png)\n![script.py]\n\n![missing](nope.png)', { resolve });
  expect(messages).toEqual([{
    flags: IS_COMPONENTS_V2,
    components: [
      { type: 10, content: 'first' },
      { type: 9, components: [{ type: 10, content: 'next to the picture' }], accessory: { type: 11, media: { url: 'attachment://chart.png' }, description: 'a chart' } },
      { type: 14, divider: true, spacing: 1 },
      { type: 12, items: [{ media: { url: 'attachment://chart.png' }, description: 'one' }, { media: { url: 'attachment://chart-2.png' }, description: 'two' }] },
      { type: 13, file: { url: 'attachment://script.py' } },
      { type: 10, content: '![missing](nope.png)' },
    ],
    files: [{ name: 'chart.png', data }, { name: 'chart-2.png', data }, { name: 'script.py', data }],
    source: 'first\n\nnext to the picture\n![a chart](chart.png)\n\n---\n\n![one](chart.png)\n![two](dir/chart.png)\n\n![script.py]\n\n![missing](nope.png)',
  }]);
});

it('shows a lone picture and image links in galleries, and splits galleries at ten', async () => {
  const urls = Array.from({ length: 12 }, (_, index) => `![](https://example.com/${index}.png)`).join('\n');
  const [message] = await layout(`---\n${urls}\n![page](https://example.com/page)`);
  expect(message!.components).toEqual([
    { type: 14, divider: true, spacing: 1 },
    { type: 12, items: Array.from({ length: 10 }, (_, index) => ({ media: { url: `https://example.com/${index}.png` } })) },
    { type: 12, items: [10, 11].map(index => ({ media: { url: `https://example.com/${index}.png` } })) },
    { type: 10, content: '![page](https://example.com/page)' },
  ]);
});

it('starts a new message when one is out of components, text or attachments', async () => {
  const dividers = await layout(Array.from({ length: 45 }, () => 'x').join('\n\n---\n\n'));
  expect(dividers.map(message => message.components!.length)).toEqual([40, 40, 9]);
  const long = await layout(`${'a'.repeat(3000)}\n\n---\n\n${'b'.repeat(3000)}`);
  expect(long.map(message => message.components!.length)).toEqual([2, 1]);
  const many: Record<string, Resolved> = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`f${index}.txt`, { name: `f${index}.txt`, data, image: false }]));
  const attached = await layout(Object.keys(many).map(name => `![${name}]`).join('\n'), { resolve: ref => many[ref] });
  expect(attached.map(message => message.files!.length)).toEqual([10, 2]);
  for (const message of [...dividers, ...long, ...attached]) {
    const text = message.components!.reduce((sum, component) => sum + String(component.content ?? '').length, 0);
    expect(text).toBeLessThanOrEqual(4000);
  }
});
