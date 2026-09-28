import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runAttempt } from '../src/agents/run.js';
import { workspace, type ConversationWorkspace } from '../src/agents/workspace.js';
import { pictures } from '../src/discord/files.js';
import { canvasLibrary, imageInfo } from '../src/discord/images.js';
import type { MessagePayload } from '../src/discord/play/render.js';
import { PlayRuntime, type PlayInteraction, type PlaySurface } from '../src/discord/play/runtime.js';
import { PlayStore } from '../src/discord/play/store.js';
import type { Approval } from '../src/execution/policy.js';
import { SpendGovernor } from '../src/inference/budget.js';
import { Telemetry } from '../src/telemetry/outcome.js';
import type { RunOptions, WorkspaceSandbox } from '../src/workspace/sandbox.js';
import { fileLimits, WorkspaceStore } from '../src/workspace/store.js';
import { TerminalWorkspace } from '../src/workspace/terminal.js';
import { completion, fixture, mockServer } from './helpers.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const owner = { id: '111111111111111111', name: 'owner' };

async function directory(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
/** A small PNG: red on the left half, blue on the right. */
async function png(width = 40, height = 20): Promise<Buffer> {
  const { createCanvas } = await canvasLibrary();
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ff0000'; context.fillRect(0, 0, width / 2, height);
  context.fillStyle = '#0000ff'; context.fillRect(width / 2, 0, width / 2, height);
  return canvas.encode('png');
}
async function pixel(data: Buffer, x: number, y: number): Promise<number[]> {
  const { createCanvas, loadImage } = await canvasLibrary();
  const image = await loadImage(data);
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return [...canvas.getContext('2d').getImageData(x, y, 1, 1).data];
}

/** A sandbox that runs nothing: `handler` plays the command's part against the workspace folder. */
function fakeSandbox(handler: (folder: string, command: string, options: RunOptions) => Promise<string | void> = async () => undefined, available = true): WorkspaceSandbox & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    status: async () => available ? { available, shell: 'bash', tools: [{ name: 'magick', kind: 'imagemagick', version: '7.1.2' }, { name: 'python3', kind: 'python', version: '3.12.3' }] } : { available, reason: 'the sandbox is not installed', shell: 'bash', tools: [] },
    run: async (folder, command, options) => { commands.push(command); return { exitCode: 0, output: await handler(folder, command, options) ?? '', timedOut: false, cancelled: false }; },
  };
}

it('keeps files per conversation by safe names, with image sizes, replacing a file saved under the same name', async () => {
  const store = WorkspaceStore.at(await directory('teapilot-workspace-'));
  const saved = await store.save('dm:1', '../evil/tree photo.png', await png(), 'op', 'image/png');
  expect(saved).toMatchObject({ name: 'tree_photo.png', type: 'image/png', width: 40, height: 20, from: 'op' });
  await store.save('dm:1', 'notes.txt', Buffer.from('hello'), 'op');
  expect(store.list('dm:2')).toEqual([]);
  expect(store.list('dm:1').map(file => file.name)).toEqual(['tree_photo.png', 'notes.txt']);
  await store.save('dm:1', 'notes.txt', Buffer.from('hello again'), 'teapilot');
  expect(store.read('dm:1', 'notes.txt')?.data.toString()).toBe('hello again');
  expect(store.list('dm:1')).toHaveLength(2);
  expect(await imageInfo(Buffer.from('not an image'))).toBeUndefined();
});

it('records what a command made, changed and removed, leaving packages and caches unlisted', async () => {
  const store = WorkspaceStore.at(await directory('teapilot-workspace-'));
  await store.save('dm:1', 'tree.png', await png(), 'op');
  await store.save('dm:1', 'old.txt', Buffer.from('old'), 'op');
  const folder = store.folder('dm:1');
  const before = await store.snapshot('dm:1');
  await writeFile(join(folder, 'turned.png'), await png(20, 40));
  await mkdir(join(folder, 'frames'), { recursive: true });
  await writeFile(join(folder, 'frames', 'one.txt'), 'frame');
  await mkdir(join(folder, '.packages', 'lib'), { recursive: true });
  await writeFile(join(folder, '.packages', 'lib', 'six.py'), '# six');
  await mkdir(join(folder, 'node_modules', 'left-pad'), { recursive: true });
  await writeFile(join(folder, 'node_modules', 'left-pad', 'index.js'), '');
  await writeFile(join(folder, 'tree.png'), await png(10, 10));
  await rm(join(folder, 'old.txt'));
  const changes = await store.reconcile('dm:1', before);
  expect(changes.added.map(file => file.name).sort()).toEqual(['frames/one.txt', 'turned.png']);
  expect(changes.added.find(file => file.name === 'turned.png')).toMatchObject({ from: 'teapilot', width: 20, height: 40 });
  expect(changes.changed).toEqual([expect.objectContaining({ name: 'tree.png', width: 10, from: 'teapilot' })]);
  expect(changes.removed).toEqual(['old.txt']);
  expect(store.list('dm:1').map(file => file.name).sort()).toEqual(['frames/one.txt', 'tree.png', 'turned.png']);
  // A bare name reaches a file in a subfolder when it is the only one.
  expect(store.read('dm:1', 'one.txt')?.data.toString()).toBe('frame');
});

it('never reads through a link a command planted, and removes what an oversized command made', async () => {
  const root = await directory('teapilot-workspace-');
  const store = new WorkspaceStore(join(root, 'workspaces'), join(root, 'index'), undefined, { ...fileLimits, workspaceBytes: 4096 });
  const secret = join(root, 'secret.txt');
  await writeFile(secret, 'host secret');
  const folder = store.folder('dm:1');
  await link(secret, join(folder, 'linked.txt'));
  await store.reconcile('dm:1');
  expect(store.list('dm:1')).toEqual([]);
  expect(store.safePath('dm:1', 'linked.txt')).toBeUndefined();
  await rm(join(folder, 'linked.txt'));

  await store.save('dm:1', 'small.txt', Buffer.from('kept'), 'op');
  const before = await store.snapshot('dm:1');
  await writeFile(join(folder, 'huge.bin'), Buffer.alloc(8192));
  const changes = await store.reconcile('dm:1', before);
  expect(changes.overQuota?.dropped).toEqual(['huge.bin']);
  expect(existsSync(join(folder, 'huge.bin'))).toBe(false);
  expect(store.list('dm:1').map(file => file.name)).toEqual(['small.txt']);
});

it('moves a conversation\'s files from before workspaces into its workspace, keeping who shared them', async () => {
  const state = await directory('teapilot-workspace-');
  const old = join(state, 'discord-files', createHash('sha256').update('thread:9').digest('hex').slice(0, 24));
  await mkdir(old, { recursive: true });
  await writeFile(join(old, 'cat.png'), await png());
  await writeFile(join(old, 'index.json'), JSON.stringify([{ name: 'cat.png', size: 10, type: 'image/png', width: 40, height: 20, from: 'op', at: 1 }]));
  const store = WorkspaceStore.at(state);
  expect(store.list('thread:9')).toEqual([expect.objectContaining({ name: 'cat.png', from: 'op' })]);
  expect(existsSync(join(store.folder('thread:9'), 'cat.png'))).toBe(true);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(join(store.folder('thread:9'), 'index.json'))).toBe(false);
  expect(store.list('thread:9')).toEqual([expect.objectContaining({ name: 'cat.png', from: 'op' })]);
});

const rotator = `
import { app, button, row, embed, picture } from '@teapilot/discord-play';
export default app({
  init: () => ({ angle: 0, grey: false }),
  update: (state, action) => action.id === 'turn' ? { ...state, angle: (state.angle + 90) % 360 } : action.id === 'grey' ? { ...state, grey: !state.grey } : state,
  view: state => ({ embeds: [embed({ title: 'Tree', image: picture('tree.png', { rotate: state.angle, greyscale: state.grey }) })], rows: [row(button('turn', 'Turn'), button('grey', 'Grey'))] }),
});`;

async function playSetup(files: WorkspaceStore) {
  const posts: MessagePayload[] = [];
  const surface: PlaySurface = { post: vi.fn(async (_channel, payload) => { posts.push(payload); return 'm1'; }), edit: vi.fn(), request: vi.fn() };
  const runtime = new PlayRuntime({ store: new PlayStore(await directory('teapilot-play-')), surface, log: vi.fn(), pictures: pictures(files) });
  cleanups.push(() => runtime.close());
  return { runtime, posts };
}

it('shows picture() as an attachment the embed refers to, rendered again as the app changes', async () => {
  const files = WorkspaceStore.at(await directory('teapilot-workspace-'));
  await files.save('dm:1', 'tree.png', await png(), 'op');
  const { runtime, posts } = await playSetup(files);
  const { record, preview } = await runtime.start({ title: 'Tree', channelId: 'c1', conversation: 'dm:1', owner, source: { kind: 'sandbox', code: rotator } });
  expect(preview).toContain('image: tree.png {"rotate":0,"greyscale":false}');
  const first = posts[0]!;
  expect(first.pictures).toBeUndefined();
  expect(first.files).toHaveLength(1);
  expect((first.embeds[0] as { image: { url: string } }).image.url).toBe(`attachment://${first.files![0]!.name}`);
  expect(await pixel(first.files![0]!.data, 0, 0)).toEqual([255, 0, 0, 255]);

  const updates: MessagePayload[] = [];
  const click = (id: string): PlayInteraction => ({ playId: record.id, controlId: id, kind: 'button', user: owner, messageId: 'm1',
    openModal: vi.fn(), reply: vi.fn(), defer: vi.fn(async () => undefined), update: vi.fn(async payload => { updates.push(payload); }), followUp: vi.fn() });
  await runtime.interact(click('turn'));
  await runtime.interact(click('grey'));
  const turned = updates[0]!.files![0]!, grey = updates[1]!.files![0]!;
  expect(turned.name).not.toBe(first.files![0]!.name);
  const { loadImage } = await canvasLibrary();
  expect((await loadImage(turned.data)).width).toBe(20);
  const [r, g, b] = await pixel(grey.data, 5, 5);
  expect(r).toBe(g); expect(g).toBe(b);
});

it('rejects an app whose picture() names no image here, listing the images there are', async () => {
  const files = WorkspaceStore.at(await directory('teapilot-workspace-'));
  await files.save('dm:1', 'cat.png', await png(), 'op');
  const { runtime } = await playSetup(files);
  await expect(runtime.start({ title: 'Tree', channelId: 'c1', conversation: 'dm:1', owner, source: { kind: 'sandbox', code: rotator } }))
    .rejects.toThrow(/picture\("tree.png"\): no file by that name here\. Images here: cat\.png/);
  await expect(runtime.start({ title: 'Tree', channelId: 'c1', conversation: 'dm:1', owner, source: { kind: 'sandbox', code: rotator.replace("rotate: state.angle", "rotate: state.angle, filter: 'rm -rf'") } }))
    .rejects.toThrow(/CSS filter functions/);
});

async function agentSetup(handler: Parameters<typeof mockServer>[0], sandbox: WorkspaceSandbox = fakeSandbox()) {
  const f = await fixture(); cleanups.push(f.cleanup);
  const server = await mockServer(handler); cleanups.push(server.close);
  Object.assign(f.config.models.capable, { provider: 'ollama', baseUrl: server.url });
  const telemetry = new Telemetry(f.config.stateDir, 'files-test');
  await telemetry.event('start', {});
  const budget = new SpendGovernor(join(f.config.stateDir, 'spend.jsonl'), 'files-test', f.config.policy.budget);
  const store = WorkspaceStore.at(await directory('teapilot-workspace-'));
  const sent: Array<{ text: string; files: Array<{ name: string; data: Buffer }> }> = [];
  const shared: ConversationWorkspace = { store, conversation: 'dm:1', sandbox, delivery: 'post', send: async (text, uploads) => { sent.push({ text, files: uploads }); } };
  const { runtime, posts } = await playSetup(store);
  const play = { runtime, channelId: 'c1', conversation: 'dm:1', owner, files: shared };
  const approvals: Approval[] = [];
  return { ...f, budget, telemetry, store, sent, runtime, posts, play, workspace: shared, approvals,
    base: { tier: 'normal' as const, workload: 'ask' as const, web: false, approve: async (approval: Approval) => { approvals.push(approval); return true; } } };
}

it('runs a script from the reply in the workspace, then posts what it made', async () => {
  const bodies: any[] = [];
  const script = '```python\nfrom PIL import Image\nImage.open("leaves.png").transpose(Image.FLIP_LEFT_RIGHT).rotate(90, expand=True).save("leaves-turned.png")\n```';
  const steps = [
    { text: script, tool: { name: 'workspace_run', arguments: { script: 'turn.py', command: 'python3 turn.py' } } },
    { tool: { name: 'file_send', arguments: { file: 'leaves-turned.png' } } },
    { text: 'Here you go.' },
  ];
  const sandbox = fakeSandbox(async folder => { await copyFile(join(folder, 'leaves.png'), join(folder, 'leaves-turned.png')); return 'turned'; });
  const f = await agentSetup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); }, sandbox);
  await f.store.save('dm:1', 'leaves.png', await png(), 'op');
  const result = await runAttempt({ ...f, ...f.base, prompt: 'flip it and turn it 90 degrees', activePermissions: ['inference'], play: f.play, workspace: f.workspace });
  expect(result.success, JSON.stringify(result)).toBe(true);
  const names = (bodies[0].tools ?? []).map((tool: any) => tool.function.name);
  expect(names).toEqual(expect.arrayContaining(['workspace_run', 'file_send']));
  expect(names).not.toContain('image_edit');
  const instructions = JSON.stringify(bodies[0].messages);
  expect(instructions).toContain('leaves.png (PNG image 40×20');
  expect(instructions).toContain('Installed: magick 7.1.2, python3 3.12.3');
  expect(sandbox.commands).toEqual(['python3 turn.py']);
  expect(f.store.read('dm:1', 'turn.py')?.data.toString()).toContain('FLIP_LEFT_RIGHT');
  const ran = JSON.stringify(bodies[1].messages);
  expect(ran).toContain('Saved the script as turn.py. Exit code 0.');
  expect(ran).toContain('New files: leaves-turned.png (PNG image 40×20');
  expect(f.sent.map(entry => entry.files.map(file => file.name))).toEqual([['leaves-turned.png']]);
  // The script is shown by what it made, not by its source.
  expect(result.text).not.toContain('FLIP_LEFT_RIGHT');
});

it('asks once before a command reaches a package registry, and remembers the answer for the conversation', async () => {
  const hosts: boolean[] = [];
  const sandbox = fakeSandbox(async (_folder, _command, options) => {
    hosts.push(await options.network('pypi.org'), await options.network('files.pythonhosted.org'));
    return 'Successfully installed six';
  });
  const f = await agentSetup(() => undefined, sandbox);
  const tools = (await workspace(f.workspace, { latest: () => undefined, block: () => undefined, used: new Set() }, f.base.approve)).tools;
  const run = tools.find(tool => tool.name === 'workspace_run')!;
  await run.execute('one', { command: 'pip install six' });
  expect(hosts).toEqual([true, true]);
  expect(f.approvals).toEqual([expect.objectContaining({ kind: 'network', details: 'pip install six', summary: expect.stringContaining('pypi.org and files.pythonhosted.org') })]);
  expect(f.store.domains('dm:1')).toEqual(['pypi.org', 'files.pythonhosted.org']);
  await run.execute('two', { command: 'pip install six' });
  expect(f.approvals).toHaveLength(1);

  // A refusal is reported, so the model does not retry.
  const refusing = await workspace({ ...f.workspace, conversation: 'dm:2' }, { latest: () => undefined, block: () => undefined, used: new Set() }, async () => false);
  const refused = await refusing.tools.find(tool => tool.name === 'workspace_run')!.execute('three', { command: 'pip install six' });
  expect(refused.content[0]).toMatchObject({ text: expect.stringContaining('pypi.org and files.pythonhosted.org was not approved') });
});

it('without a sandbox, keeps and sends files but says commands cannot run', async () => {
  const f = await agentSetup(() => undefined, fakeSandbox(undefined, false));
  const setup = await workspace(f.workspace, { latest: () => undefined, block: () => undefined, used: new Set() }, f.base.approve);
  expect(setup.tools.map(tool => tool.name)).toEqual(['file_send']);
  expect(setup.systemPrompt).toContain('Commands cannot run here (the sandbox is not installed)');
});

it('pauses tools when workspace_run names a script that was not written, then runs what the model writes', async () => {
  const bodies: any[] = [];
  const steps = [
    { tool: { name: 'workspace_run', arguments: { script: 'hello.py', command: 'python3 hello.py' } } },
    { text: '```python\nprint("hi")\n```' },
    { tool: { name: 'workspace_run', arguments: { script: 'hello.py', command: 'python3 hello.py' } } },
    { text: 'It printed hi.' },
  ];
  const sandbox = fakeSandbox(async () => 'hi');
  const f = await agentSetup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); }, sandbox);
  const result = await runAttempt({ ...f, ...f.base, prompt: 'run a hello world', activePermissions: ['inference'], workspace: f.workspace });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(bodies[1].tools ?? []).toHaveLength(0);
  expect(JSON.stringify(bodies[1].messages)).toContain('workspace_run saves the newest code block in your reply');
  expect(JSON.stringify(bodies[2].messages)).toContain('Call workspace_run again now');
  expect(sandbox.commands).toEqual(['python3 hello.py']);
});

it('runs an attached app file, replaces an emoji everywhere, and sends the source back under its name', async () => {
  const bodies: any[] = [];
  const game = `// chairs 🪑 block you
import { app, button, row } from '@teapilot/discord-play';
export default app({ init: () => 0, update: n => n + 1, view: n => ({ content: '🪑 ' + n, rows: [row(button('go', 'Go'))] }) });`;
  const steps = [
    { tool: { name: 'play_start', arguments: { file: 'game.js', title: 'Game' } } },
    { tool: { name: 'play_start', arguments: { file: 'game.js', title: 'Game' } } },
    { tool: { name: 'play_update', arguments: { edits: [{ find: '🪑', replace: '🐖' }] } } },
    { tool: { name: 'play_update', arguments: { edits: [{ find: '🪑', replace: '🐖', all: true }] } } },
    { tool: { name: 'file_send', arguments: { app: 'APP' } } },
    { text: 'Done.' },
  ];
  const f = await agentSetup((body, _req, res) => {
    bodies.push(body);
    const step = structuredClone(steps[bodies.length - 1]!) as any;
    if (step.tool?.arguments.app) step.tool.arguments.app = f.runtime.list('dm:1')[0]!.id;
    completion(res, step);
  });
  await f.store.save('dm:1', 'game.js', Buffer.from(game), 'op', 'text/javascript');
  const result = await runAttempt({ ...f, ...f.base, prompt: 'embed this game', activePermissions: ['inference', 'discord.play'], play: f.play, workspace: f.workspace });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(bodies[0].messages)).toContain('play_start({ file, title })');
  expect(f.posts[0]!.content).toBe('🪑 0');
  expect(JSON.stringify(bodies[2].messages)).toContain('is already live from this turn');
  expect(f.posts).toHaveLength(1);
  expect(JSON.stringify(bodies[3].messages)).toContain('occurs 2 times');
  expect(JSON.stringify(bodies[3].messages)).toContain('set all: true');
  const sent = f.sent[0]!.files[0]!;
  expect(sent.name).toBe('game.js');
  expect(sent.data.toString()).toBe(game.replaceAll('🪑', '🐖'));
});

it('holds a model to a change it claims without calling a play tool, once', async () => {
  const bodies: any[] = [];
  const steps = [
    { text: 'Done — chairs are now pigs 🐷.' },
    { tool: { name: 'play_update', arguments: { edits: [{ find: '🪑', replace: '🐷' }] } } },
    { text: 'Swapped the chairs for pigs.' },
  ];
  const f = await agentSetup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const code = `import { app, button, row } from '@teapilot/discord-play';
export default app({ init: () => 0, update: n => n + 1, view: n => ({ content: '🪑 ' + n, rows: [row(button('go', 'Go'))] }) });`;
  await f.runtime.start({ title: 'Game', channelId: 'c1', conversation: 'dm:1', owner, source: { kind: 'sandbox', code } });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'replace the chairs with pigs', activePermissions: ['inference', 'discord.play'], play: f.play, workspace: f.workspace });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(bodies[1].messages)).toContain('no play_start or play_update succeeded in this turn');
  expect(result.text).toBe('Swapped the chairs for pigs.');
  const source = f.runtime.source(f.runtime.list('dm:1')[0]!.id, 'dm:1');
  expect(source.kind === 'sandbox' && source.code).toContain('🐷');

  // A plain answer about a running app is left alone.
  bodies.length = 0;
  steps.splice(0, steps.length, { text: 'Press Go to count up.' });
  const answer = await runAttempt({ ...f, ...f.base, prompt: 'how do I play?', activePermissions: ['inference', 'discord.play'], play: f.play, workspace: f.workspace });
  expect(answer.text).toBe('Press Go to count up.');
  expect(bodies).toHaveLength(1);
});

it('reports a failed upload as not sent, rather than as Discord\'s own error', async () => {
  const store = WorkspaceStore.at(await directory('teapilot-workspace-'));
  const context: ConversationWorkspace = { store, conversation: 'dm:1', send: async () => { throw new Error('This operation was aborted'); } };
  const drafts = { latest: () => undefined, block: () => ({ tag: 'txt', body: 'olleh' }), used: new Set<string>() };
  const send = (await workspace(context, drafts, async () => true)).tools.find(tool => tool.name === 'file_send')!;
  await expect(send.execute('call', { name: 'helo.txt' })).rejects.toThrow(/nothing was sent.*This operation was aborted.*Do not send it again/);
});

it('pauses tools when file_send is called before the content is written, then sends what the model writes', async () => {
  const bodies: any[] = [];
  const steps = [
    { tool: { name: 'file_send', arguments: { name: 'helo.txt' } } },
    { text: '```txt\nolleh\n```' },
    { tool: { name: 'file_send', arguments: { name: 'helo.txt' } } },
    { text: 'sent.' },
  ];
  const f = await agentSetup((body, _req, res) => { bodies.push(body); completion(res, steps[bodies.length - 1]!); });
  const result = await runAttempt({ ...f, ...f.base, prompt: 'reverse helo.txt and send it back', activePermissions: ['inference'], workspace: f.workspace });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(bodies[1].tools ?? []).toHaveLength(0);
  expect(JSON.stringify(bodies[1].messages)).toContain('file_send never writes content itself');
  expect(JSON.stringify(bodies[2].messages)).toContain('Call file_send now');
  expect(f.sent.map(entry => entry.files.map(file => [file.name, file.data.toString()]))).toEqual([[['helo.txt', 'olleh']]]);
});

it('copies @mentioned files into a terminal session\'s workspace and saves sent files beside the user, never over one unasked', async () => {
  const state = await directory('teapilot-workspace-');
  const cwd = await directory('teapilot-cwd-');
  await writeFile(join(cwd, 'tree.png'), await png());
  await writeFile(join(cwd, 'notes.txt'), 'buy tea');
  const store = WorkspaceStore.at(state);
  const approvals: Approval[] = [];
  const session = new TerminalWorkspace(store, fakeSandbox(), async approval => { approvals.push(approval); return false; });
  const prompt = await session.attach('turn @tree.png and read @notes.txt, but not @missing.png or @../escape.txt', cwd, 5000);
  expect(prompt).toContain('[Attached file tree.png (PNG image 40×20');
  expect(prompt).toContain('buy tea');
  const context = session.context(cwd);
  expect(context.store.list(context.conversation).map(file => file.name)).toEqual(['tree.png', 'notes.txt']);

  const told = await context.send!('', [{ name: 'tree.png', data: Buffer.from('turned') }, { name: 'new.txt', data: Buffer.from('new') }]);
  expect(approvals).toEqual([expect.objectContaining({ kind: 'overwrite' })]);
  expect(await readFile(join(cwd, 'tree-1.png'), 'utf8')).toBe('turned');
  expect(await readFile(join(cwd, 'new.txt'), 'utf8')).toBe('new');
  expect(told).toContain(join(cwd, 'tree-1.png'));

  const folder = store.folder(context.conversation);
  await session.close();
  expect(existsSync(folder)).toBe(false);
});
