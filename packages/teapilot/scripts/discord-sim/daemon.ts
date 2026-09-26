// The long-lived half of scripts/agent-discord.mjs: runs teapilot's Discord service against the
// simulated Discord in world.ts and answers the client's commands over a local socket.
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configDirectory, loadConfig } from '../../src/config.js';
import { AccessStore } from '../../src/discord/access-store.js';
import { serveDiscord } from '../../src/discord/index.js';
import { describe } from '../../src/discord/play/render.js';
import { PlayStore } from '../../src/discord/play/store.js';
import type { DiscordSettings } from '../../src/discord/settings.js';
import { SkippableClock } from './clock.js';
import { channelId, people, SimError, World } from './world.js';

export interface Spec {
  name: string; directory: string; socket: string; meta: string; log: string;
  /** Where the access list and app records live; the profile's own state directory is never touched for these. */
  state: string;
  root: string; mode: 'ask' | 'chat'; configDir?: string; ttl: number; teachat: boolean;
}
type Body = Record<string, unknown> & { op: string };

const spec = JSON.parse(Buffer.from(process.argv[2]!, 'base64url').toString()) as Spec;
const fail = (error: unknown) => { appendFileSync(spec.log, `${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1); };
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

const world = new World();
const clock = new SkippableClock();
const notes: string[] = [];
const config = await loadConfig(await configDirectory(spec.configDir, homedir()), { ...process.env });
if (!config.policy.permissions.includes('discord.play')) {
  config.policy.permissions.push('discord.play');
  notes.push('This profile\'s policy.json lacks discord.play; the simulator allows it for this session only.');
}
const settings: DiscordSettings = { token: 'simulated-discord-token', allowedUserIds: [people.op.id], channelId, root: spec.root, startMode: spec.mode };
AccessStore.at(spec.state, settings.allowedUserIds, config.policy.permissions).addUser(people.user.id, people.op.id, { name: people.user.name });
const store = new PlayStore(join(spec.state, 'discord-play'));

let fresh = '';
const waiters = new Set<() => void>();
world.onEvent(text => { fresh = (fresh + text + '\n').slice(-1_000_000); for (const waiter of waiters) waiter(); });

let session: { controller: AbortController; done: Promise<void>; ended: boolean } | undefined;
async function serve(): Promise<void> {
  const controller = new AbortController();
  const current = { controller, ended: false, done: Promise.resolve() };
  current.done = serveDiscord({ config, settings, log: world.log, signal: controller.signal, connect: world.connect, stateDir: spec.state, clock, teachat: spec.teachat })
    .catch(error => world.warn(`teapilot stopped after an error: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => { current.ended = true; for (const waiter of waiters) waiter(); });
  session = current;
  await new Promise<void>(resolve => {
    const off = world.onEvent(text => { if (text.startsWith('[log] Connected as')) { off(); resolve(); } });
    void current.done.then(() => { off(); resolve(); });
  });
}
async function halt(): Promise<void> {
  const current = session;
  session = undefined;
  if (!current) return;
  current.controller.abort();
  await current.done;
}
const running = () => Boolean(session && !session.ended);

function wait({ pattern, idle, timeout }: { pattern?: string; idle?: number; timeout: number }): Promise<{ code: number; screen: string }> {
  return new Promise(done => {
    const regex = pattern === undefined ? undefined : new RegExp(pattern, 'm');
    const started = Date.now();
    const finish = (code: number) => { waiters.delete(evaluate); clearInterval(timer); done({ code, screen: world.screen() }); };
    function evaluate() {
      const match = regex?.exec(fresh);
      if (match) { fresh = fresh.slice(match.index + match[0].length); return finish(0); }
      if (idle !== undefined && Date.now() - Math.max(world.lastActivity, started) >= idle) return finish(0);
      if (!running()) return finish(3);
      if (Date.now() - started >= timeout * 1000) return finish(124);
    }
    const timer = setInterval(evaluate, 100);
    waiters.add(evaluate);
    evaluate();
  });
}

const since = (at: number) => world.logs.slice(at).join('\n');
const ago = (ms: number) => ms >= 0 ? `in ${Math.round(ms / 1000)} s` : `${Math.round(-ms / 1000)} s overdue`;

function apps(): string {
  const records = store.all();
  if (!records.length) return 'No apps yet.';
  return records.map(record => `${record.id}  ${record.status.padEnd(8)}  ${record.title}  (#${world.channel(record.channelId).name}${record.messageId ? ` ${record.messageId}` : ''}; ${record.source.kind})`).join('\n');
}

/** Everything about one app, including the code the model wrote, which play_inspect does not show. */
function app(id: string): string {
  const record = store.all().find(entry => entry.id === id);
  if (!record) throw new SimError(`No app ${id}. Apps:\n${apps()}`);
  const participants = Array.isArray(record.participants) ? record.participants.map(value => Object.values(people).find(person => person.id === value)?.name ?? value).join(', ') : record.participants;
  return [
    `${record.id}: ${record.title} (${record.status}${record.note ? `: ${record.note}` : ''})`,
    `owner ${record.owner.name ?? record.owner.id}; participants ${participants}; message ${record.messageId ?? '-'} in #${world.channel(record.channelId).name}`,
    `timers: ${record.timers.map(timer => `${timer.id} ${ago(timer.dueAt - clock.now())}`).join(', ') || 'none'}`,
    `consults in the last hour: ${record.consults.filter(at => at > clock.now() - 3_600_000).length}`,
    '## state', JSON.stringify(record.state, null, 2),
    '## view', describe(record.view),
    '## recent actions', ...record.log.map(entry => `${new Date(entry.at).toISOString()} ${entry.action}${entry.error ? ` -> error: ${entry.error}` : ''}`),
    '## source', record.source.kind === 'sandbox' ? record.source.code : `trusted file ${record.source.path} (sha256 ${record.source.sha256})`,
  ].join('\n');
}

async function handle(body: Body): Promise<Record<string, unknown>> {
  const as = String(body.as ?? 'op');
  const input = () => { fresh = ''; };
  switch (body.op) {
    case 'hello': return { text: [`Simulated Discord ${running() ? 'is running' : 'did not start'}.`, ...notes].join('\n') };
    case 'say': { input(); const message = world.say(as, String(body.text), body.in as string | undefined); return { text: `${message.id} sent by ${as} in #${message.channel.name}.` }; }
    case 'click': input(); return { text: await world.click(as, String(body.message), String(body.control)) };
    case 'select': input(); return { text: await world.select(as, String(body.message), String(body.control), body.values as string[]) };
    case 'submit': input(); return { text: await world.submit(as, body.fields as Record<string, string>) };
    case 'approve': {
      const message = world.pendingApproval();
      if (!message) throw new SimError('No approval is waiting.');
      input();
      return { text: await world.click(as, message.id, body.deny ? 'deny' : 'approve') };
    }
    case 'wait': return wait(body as never);
    case 'screen': return { text: world.screen(body.in as string | undefined, Number(body.last) || 15) };
    case 'apps': return { text: apps() };
    case 'app': return { text: app(String(body.id)) };
    case 'log': return { text: world.logs.slice(-(Number(body.last) || 30)).join('\n') || 'Nothing logged yet.' };
    case 'advance': {
      input();
      const due = clock.advance(Number(body.ms));
      await world.quiet(300, 10_000);
      return { text: `The clock is ${Math.round(clock.skipped / 1000)} s ahead of real time; ${due} timer(s) came due.\n${world.screen()}` };
    }
    case 'restart': {
      input();
      const mark = world.logs.length;
      await halt();
      await serve();
      return { text: `teapilot restarted; conversations started over and apps were recovered.\n${since(mark)}` };
    }
    case 'status': return { text: `${running() ? 'running' : 'stopped'}; clock +${Math.round(clock.skipped / 1000)} s; root ${spec.root}; mode ${spec.mode}` };
    case 'stop': await halt(); return { text: 'Stopped.', shutdown: true };
    default: throw new Error(`Unknown operation ${body.op}`);
  }
}

let lastContact = Date.now();
const server = createServer(socket => {
  let data = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    data += chunk;
    const end = data.indexOf('\n');
    if (end < 0) return;
    lastContact = Date.now();
    Promise.resolve().then(() => handle(JSON.parse(data.slice(0, end)) as Body))
      .then(reply => socket.end(JSON.stringify(reply), () => { if (reply.shutdown) shutdown(); }),
        error => socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error), usage: error instanceof SimError })))
      .finally(() => { lastContact = Date.now(); });
  });
  socket.on('error', () => undefined);
});
function shutdown(): never {
  server.close();
  rmSync(spec.directory, { recursive: true, force: true });
  process.exit(0);
}
if (process.platform !== 'win32') rmSync(spec.socket, { force: true });
await serve();
server.listen(spec.socket);
writeFileSync(spec.meta, JSON.stringify({ name: spec.name, pid: process.pid, root: spec.root, mode: spec.mode, startedAt: new Date().toISOString() }, null, 2));
// An abandoned session ends itself after the TTL without contact.
setInterval(() => {
  if (waiters.size) lastContact = Date.now();
  if (Date.now() - lastContact > spec.ttl * 1000) void halt().then(shutdown);
}, 1000);
