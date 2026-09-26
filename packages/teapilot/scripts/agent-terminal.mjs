#!/usr/bin/env node
// Drives teapilot in a real pseudo-terminal for agents whose shell tool runs one
// command at a time. A detached daemon owns the PTY; every other command is a
// short client call that returns plain text. Development tooling only.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(tmpdir(), 'teapilot-term');
const files = name => ({ meta: join(directory, `${name}.json`), log: join(directory, `${name}.log`), daemonLog: join(directory, `${name}.daemon.log`),
  socket: process.platform === 'win32' ? `\\\\.\\pipe\\teapilot-term-${name}` : join(directory, `${name}.sock`) });
const readMeta = name => { try { return JSON.parse(readFileSync(files(name).meta, 'utf8')); } catch { return undefined; } };
const writeMeta = (name, meta) => writeFileSync(files(name).meta, JSON.stringify(meta, null, 2));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const describe = meta => meta.expired ? 'expired (stopped after --ttl without contact)' : meta.exitCode !== undefined ? `exited ${meta.exitCode}`
  : alive(meta.pid) ? 'running' : 'daemon gone';
// ConPTY moves between rows with cursor positioning instead of newlines; keep those as line breaks.
const plain = text => stripVTControlCharacters(text.replace(/\x1b\[[\d;]*[HfBEF]/g, '\n')).replace(/\r\n?/g, '\n');
const keys = { enter: '\r', tab: '\t', esc: '\x1b', backspace: '\x7f', delete: '\x1b[3~', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  home: '\x1b[H', end: '\x1b[F', 'shift-enter': '\x1b[13;2u', 'alt-enter': '\x1b\r', submit: '\x1b\r' };
const key = name => keys[name] ?? (/^ctrl-[a-z]$/.test(name) ? String.fromCharCode(name.charCodeAt(5) - 96) : undefined);

const usage = `Usage: node scripts/agent-terminal.mjs <command>

  start [--name N] [--cols 100] [--rows 36] [--cwd DIR] [--built] [--ttl S] -- <teapilot args...>
                                        --cwd is the launch directory (default: home, so the personal
                                        profile applies); give teapilot its repository after --
  send <name> <text> [--submit|--enter] type literal text (use -- before text starting with -)
  key <name> <key...>                   ${Object.keys(keys).join('|')}|ctrl-<letter>
  wait <name> --for REGEX | --idle MS | --exit [--timeout S]
  screen <name> [--scrollback N]
  transcript <name>
  status <name>
  stop <name>
  list

wait exit codes: 0 matched, 3 teapilot exited first, 124 timed out.
--for matches output since the last send/key or match; the regex uses the m flag.
The composer sends with Alt+Enter (--submit); plain Enter adds a line there.
Approval and setup questions submit with plain Enter (--enter).`;

class UsageError extends Error {}

function request(name, body) {
  return new Promise((done, reject) => {
    const socket = connect(files(name).socket);
    let data = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(body) + '\n'));
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => { try { const reply = JSON.parse(data); reply.error ? reject(new Error(reply.error)) : done(reply); } catch { reject(new Error('The session daemon closed unexpectedly.')); } });
    socket.on('error', reject);
  });
}

function print(reply) {
  if (reply.screen !== undefined) process.stdout.write(`${reply.screen}\n[cursor ${reply.cursor} | ${reply.status} | ${reply.size}]\n`);
}

async function session(name, body) {
  const meta = readMeta(name);
  if (!meta) throw new UsageError(`No session named ${name}. Use list, or start one.`);
  try { return await request(name, body); }
  catch (error) {
    if (alive(meta.pid)) throw error;
    // The daemon has gone; answer what the metadata still knows.
    return { status: describe(meta), screen: meta.finalScreen ?? '', cursor: '-', size: `${meta.cols}x${meta.rows}`, gone: true, exitCode: meta.exitCode };
  }
}

async function client(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === 'help') { console.log(usage); return 0; }
  if (command === 'daemon') return daemon(JSON.parse(Buffer.from(rest[0], 'base64url').toString()));
  if (command === 'start') {
    const boundary = rest.indexOf('--');
    if (boundary < 0) throw new UsageError('start needs -- before the teapilot arguments, e.g. start -- ask "hello".');
    const { values } = parseArgs({ args: rest.slice(0, boundary), options: {
      name: { type: 'string', default: 'default' }, cols: { type: 'string', default: '100' }, rows: { type: 'string', default: '36' },
      // Teapilot prefers configuration in its launch directory, and a checkout always has some.
      // Launch from home like a user would; pass the repository with teapilot's own --cwd.
      cwd: { type: 'string', default: homedir() }, built: { type: 'boolean', default: false }, ttl: { type: 'string', default: '1800' },
    } });
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(values.name)) throw new UsageError('--name may contain letters, digits, _ and - (at most 40).');
    const [cols, rows, ttl] = [values.cols, values.rows, values.ttl].map(Number);
    if (![cols, rows, ttl].every(value => Number.isInteger(value) && value > 0)) throw new UsageError('--cols, --rows and --ttl must be positive integers.');
    try { await import('@lydell/node-pty'); } catch { throw new Error('Missing devDependency @lydell/node-pty. Run npm install in the teapilot checkout.'); }
    const entry = values.built ? join(root, 'dist', 'cli.js') : join(root, 'src', 'cli.ts');
    if (!existsSync(entry)) throw new Error(`${entry} does not exist${values.built ? '; run npm run build' : ''}.`);
    const previous = readMeta(values.name);
    if (previous && alive(previous.pid)) throw new UsageError(`Session ${values.name} is already running. Stop it or choose another --name.`);
    mkdirSync(directory, { recursive: true });
    const paths = files(values.name);
    for (const path of [paths.meta, paths.log, paths.daemonLog]) rmSync(path, { force: true });
    const args = rest.slice(boundary + 1);
    const spec = { name: values.name, cols, rows, ttl, cwd: resolve(values.cwd), args,
      argv: [...(values.built ? [] : ['--import', import.meta.resolve('tsx'), '--conditions=teapilot-source']), entry, ...args] };
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'daemon', Buffer.from(JSON.stringify(spec)).toString('base64url')],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    for (const started = Date.now(); ; await new Promise(done => setTimeout(done, 100))) {
      try { print(await request(values.name, { op: 'wait', idle: 750, timeout: 10, afterOutput: true })); break; }
      catch (error) {
        if (Date.now() - started > 10_000 || !alive(child.pid)) {
          const log = existsSync(paths.daemonLog) ? readFileSync(paths.daemonLog, 'utf8').trim() : '';
          throw new Error(`The session daemon did not start.${log ? `\n${log}` : ` ${error.message}`}`);
        }
      }
    }
    console.error(`Session ${values.name} started.`);
    return 0;
  }
  if (command === 'list') {
    if (!existsSync(directory)) return 0;
    for (const file of readdirSync(directory).filter(file => file.endsWith('.json'))) {
      const meta = readMeta(file.slice(0, -5));
      if (meta) console.log(`${meta.name}\t${describe(meta)}\t${meta.cwd}\t${meta.args.join(' ')}`);
    }
    return 0;
  }
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    enter: { type: 'boolean' }, submit: { type: 'boolean' }, for: { type: 'string' }, idle: { type: 'string' }, exit: { type: 'boolean' }, timeout: { type: 'string', default: '60' },
    scrollback: { type: 'string', default: '0' },
  } });
  const [name, ...args] = positionals;
  if (!name) throw new UsageError(`${command} needs a session name.\n\n${usage}`);
  if (command === 'send') {
    if (args.length !== 1) throw new UsageError('send takes one text argument; quote it.');
    if (values.enter && values.submit) throw new UsageError('Use --submit for the composer or --enter for a question, not both.');
    await session(name, { op: 'input', data: args[0] + (values.submit ? keys.submit : values.enter ? keys.enter : '') });
    return 0;
  }
  if (command === 'key') {
    const data = args.map(value => { const sequence = key(value.toLowerCase()); if (!sequence) throw new UsageError(`Unknown key ${value}.`); return sequence; });
    if (!data.length) throw new UsageError('key needs at least one key name.');
    await session(name, { op: 'input', data: data.join('') });
    return 0;
  }
  if (command === 'wait') {
    if (values.for === undefined && values.idle === undefined && !values.exit) throw new UsageError('wait needs --for REGEX, --idle MS or --exit.');
    if (values.for !== undefined) new RegExp(values.for, 'm');
    const timeout = Number(values.timeout), idle = values.idle === undefined ? undefined : Number(values.idle);
    if (!(timeout > 0) || (idle !== undefined && !(idle > 0))) throw new UsageError('--timeout and --idle must be positive numbers.');
    const reply = await session(name, { op: 'wait', pattern: values.for, idle, exit: values.exit, timeout });
    print(reply);
    return reply.gone ? (values.exit ? 0 : 3) : reply.code;
  }
  if (command === 'screen') { print(await session(name, { op: 'screen', scrollback: Number(values.scrollback) || 0 })); return 0; }
  if (command === 'status') { console.log((await session(name, { op: 'status' })).status); return 0; }
  if (command === 'transcript') {
    const reply = await session(name, { op: 'transcript' });
    process.stdout.write(reply.gone ? plain(readFileSync(files(name).log, 'utf8')) : reply.transcript + '\n');
    return 0;
  }
  if (command === 'stop') {
    const reply = await session(name, { op: 'stop' });
    print(reply);
    const paths = files(name);
    for (const path of [paths.meta, paths.log, paths.daemonLog]) rmSync(path, { force: true });
    return 0;
  }
  throw new UsageError(`Unknown command ${command}.\n\n${usage}`);
}

async function daemon(spec) {
  const paths = files(spec.name);
  const fail = error => { appendFileSync(paths.daemonLog, `${error?.stack ?? error}\n`); process.exit(1); };
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  const { default: pty } = await import('@lydell/node-pty');
  const { default: { Terminal } } = await import('@xterm/headless');
  const terminal = new Terminal({ cols: spec.cols, rows: spec.rows, scrollback: 5000, allowProposedApi: true });
  const child = pty.spawn(process.execPath, spec.argv, { name: 'xterm-256color', cols: spec.cols, rows: spec.rows, cwd: spec.cwd,
    env: { ...process.env, TERM: 'xterm-256color' } });
  const meta = { name: spec.name, pid: process.pid, childPid: child.pid, cwd: spec.cwd, args: spec.args,
    cols: spec.cols, rows: spec.rows, startedAt: new Date().toISOString() };
  writeMeta(spec.name, meta);
  let fresh = '';            // plain output since the last input or match
  let lastOutput = Date.now();
  let lastContact = Date.now();
  let exitCode;
  let stopped = false;
  const waiters = new Set();
  const flushed = () => new Promise(done => terminal.write('', done));
  const status = () => exitCode === undefined ? 'running' : `exited ${exitCode}`;
  const view = async (scrollback = 0) => {
    await flushed();
    const buffer = terminal.buffer.active;
    const lines = [];
    for (let row = Math.max(0, buffer.viewportY - scrollback); row < Math.min(buffer.length, buffer.viewportY + spec.rows); row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
    while (lines.length && !lines.at(-1)) lines.pop();
    return { screen: lines.join('\n'), cursor: `${buffer.cursorY + 1},${buffer.cursorX + 1}`, status: status(), size: `${spec.cols}x${spec.rows}` };
  };
  const check = () => { for (const waiter of waiters) waiter(); };
  child.onData(data => {
    appendFileSync(paths.log, data);
    fresh = (fresh + plain(data)).slice(-1_000_000);
    lastOutput = Date.now();
    terminal.write(data, check);
  });
  child.onExit(({ exitCode: code }) => { exitCode = code; writeMeta(spec.name, { ...meta, exitCode }); flushed().then(check); });
  const shutdown = async () => {
    const expired = exitCode === undefined;
    if (expired) { try { child.kill(); } catch {} }
    const { screen } = await view();
    if (!stopped) writeMeta(spec.name, { ...meta, ...(expired ? { expired } : { exitCode }), finalScreen: screen });
    server.close();
    process.exit(0);
  };
  const wait = ({ pattern, idle, exit, timeout, afterOutput }) => new Promise(done => {
    const regex = pattern === undefined ? undefined : new RegExp(pattern, 'm');
    const started = Date.now();
    const finish = code => { waiters.delete(evaluate); clearInterval(timer); view().then(reply => done({ ...reply, code })); };
    const evaluate = () => {
      const match = regex?.exec(fresh);
      if (match) { fresh = fresh.slice(match.index + match[0].length); return finish(0); }
      if (idle !== undefined && (!afterOutput || lastOutput > started) && Date.now() - Math.max(lastOutput, started) >= idle) return finish(0);
      if (exitCode !== undefined) return finish(exit ? 0 : 3);
      if (Date.now() - started >= timeout * 1000) return finish(124);
    };
    const timer = setInterval(evaluate, 100);
    waiters.add(evaluate);
    // Evaluate after pending output has rendered, so an exit sees its final output.
    flushed().then(evaluate);
  });
  const handle = async body => {
    if (body.op === 'input') {
      if (exitCode !== undefined) throw new Error(`teapilot has ${status()}; input was not sent.`);
      fresh = ''; child.write(body.data); return {};
    }
    if (body.op === 'wait') return wait(body);
    if (body.op === 'screen') return view(body.scrollback);
    if (body.op === 'transcript') return { transcript: (await view(Infinity)).screen };
    if (body.op === 'status') return { status: status() };
    if (body.op === 'stop') {
      stopped = true;
      if (exitCode === undefined) { child.write('\x03'); await wait({ exit: true, timeout: 3 }); }
      if (exitCode === undefined) { try { child.kill(); } catch {} await wait({ exit: true, timeout: 2 }); }
      return { ...await view(), shutdown: true };
    }
    throw new Error(`Unknown operation ${body.op}`);
  };
  if (process.platform !== 'win32') rmSync(paths.socket, { force: true });
  const server = createServer(socket => {
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      data += chunk;
      const end = data.indexOf('\n');
      if (end < 0) return;
      lastContact = Date.now();
      Promise.resolve().then(() => handle(JSON.parse(data.slice(0, end))))
        .then(reply => socket.end(JSON.stringify(reply), () => { if (reply.shutdown) void shutdown(); }), error => socket.end(JSON.stringify({ error: error.message })))
        .finally(() => { lastContact = Date.now(); });
    });
    socket.on('error', () => {});
  });
  server.listen(paths.socket);
  // Abandoned sessions end themselves: after the TTL without contact while running,
  // or a minute without contact once teapilot has exited.
  setInterval(() => {
    if (waiters.size) lastContact = Date.now();
    if (Date.now() - lastContact > (exitCode === undefined ? spec.ttl * 1000 : 60_000)) void shutdown();
  }, 1000);
}

client(process.argv.slice(2)).then(code => { if (code !== undefined) process.exitCode = code; }, error => {
  console.error(error instanceof UsageError ? error.message : `agent-terminal: ${error.message}`);
  process.exitCode = 1;
});
