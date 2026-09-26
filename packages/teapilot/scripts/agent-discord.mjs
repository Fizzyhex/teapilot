#!/usr/bin/env node
// Drives teapilot's Discord service against a simulated Discord, for agents whose shell tool runs
// one command at a time. A detached daemon (discord-sim/daemon.ts) owns teapilot and the fake
// Discord; every other command is a short client call that returns plain text. Development tooling only.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(tmpdir(), 'teapilot-discord');
const files = name => {
  const directory = join(base, name);
  return { directory, meta: join(directory, 'session.json'), log: join(directory, 'daemon.log'), state: join(directory, 'state'), root: join(directory, 'repo'),
    socket: process.platform === 'win32' ? `\\\\.\\pipe\\teapilot-discord-${name}` : join(directory, 'socket') };
};
const readMeta = name => { try { return JSON.parse(readFileSync(files(name).meta, 'utf8')); } catch { return undefined; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

const usage = `Usage: node scripts/agent-discord.mjs <command>

  start [--name N] [--root DIR] [--mode ask|chat] [--config-dir DIR] [--ttl S] [--teachat]
                                     --root is teapilot's repository (default: an empty scratch directory)
  say <name> <text> [--as P] [--in C] send a message; @op, @user, @stranger and @teapilot become mentions
  click <name> <message> <control> [--as P]
  select <name> <message> <control> <value...> [--as P]
  submit <name> [--field id=value ...] [--as P]      the form P has open
  approve <name> [--deny] [--as P]   answer the newest waiting approval
  wait <name> --for REGEX | --idle MS [--timeout S]
  screen <name> [--in C] [--last N]  a channel's latest messages (default: the most recently active)
  apps <name>                        every discord.play app
  app <name> <id>                    one app: state, view, timers, recent actions and its source
  advance <name> <duration>          move the clock ahead, e.g. 30s, 5m, 25h
  restart <name>                     restart teapilot; apps are recovered, conversations start over
  log <name> [--last N]              teapilot's operator log
  status <name>
  stop <name>
  list

People (--as, default op): op is an operator, user is whitelisted, stranger is neither.
Channels (--in): dm-<person> (the default), channel (teapilot's channel; messages mention it),
and thread-N once teapilot opens one. Messages are m1, m2, ...; controls use their app ids.
wait exit codes: 0 matched, 3 teapilot stopped, 124 timed out. --for matches output since the last
say, click, select, submit, approve, advance or restart; the regex uses the m flag.`;

class UsageError extends Error {}

function request(name, body) {
  return new Promise((done, reject) => {
    const socket = connect(files(name).socket);
    let data = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(body) + '\n'));
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => {
      try {
        const reply = JSON.parse(data);
        if (reply.error) reject(reply.usage ? new UsageError(reply.error) : new Error(reply.error)); else done(reply);
      } catch { reject(new Error('The session daemon closed unexpectedly.')); }
    });
    socket.on('error', reject);
  });
}

async function session(name, body) {
  const meta = readMeta(name);
  if (!meta) throw new UsageError(`No session named ${name}. Use list, or start one.`);
  try { return await request(name, body); }
  catch (error) {
    if (error instanceof UsageError || alive(meta.pid)) throw error;
    return { gone: true, text: 'The session daemon has gone.' };
  }
}

function duration(text) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(text ?? '');
  if (!match) throw new UsageError('Give a duration like 1500ms, 30s, 5m, 2h or 1d.');
  return Math.round(Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] ?? 'ms']);
}

async function client(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === 'help') { console.log(usage); return 0; }
  if (command === 'start') {
    const { values } = parseArgs({ args: rest, options: {
      name: { type: 'string', default: 'default' }, root: { type: 'string' }, mode: { type: 'string', default: 'ask' },
      'config-dir': { type: 'string' }, ttl: { type: 'string', default: '1800' }, teachat: { type: 'boolean', default: false },
    } });
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(values.name)) throw new UsageError('--name may contain letters, digits, _ and - (at most 40).');
    if (!['ask', 'chat'].includes(values.mode)) throw new UsageError('--mode is ask or chat.');
    const ttl = Number(values.ttl);
    if (!Number.isInteger(ttl) || ttl <= 0) throw new UsageError('--ttl must be a positive integer.');
    const previous = readMeta(values.name);
    if (previous && alive(previous.pid)) throw new UsageError(`Session ${values.name} is already running. Stop it or choose another --name.`);
    const paths = files(values.name);
    rmSync(paths.directory, { recursive: true, force: true });
    mkdirSync(paths.state, { recursive: true });
    if (!values.root) mkdirSync(paths.root, { recursive: true });
    const spec = { name: values.name, directory: paths.directory, socket: paths.socket, meta: paths.meta, log: paths.log, state: paths.state,
      root: values.root ? resolve(values.root) : paths.root, mode: values.mode, configDir: values['config-dir'] && resolve(values['config-dir']), ttl, teachat: values.teachat };
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--conditions=teapilot-source', join(root, 'scripts', 'discord-sim', 'daemon.ts'), Buffer.from(JSON.stringify(spec)).toString('base64url')],
      { cwd: homedir(), detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    for (const started = Date.now(); ; await new Promise(done => setTimeout(done, 200))) {
      if (existsSync(paths.meta)) {
        try { console.log((await request(values.name, { op: 'hello' })).text); break; } catch { /* not listening yet */ }
      }
      if (Date.now() - started > 60_000 || !alive(child.pid)) {
        const log = existsSync(paths.log) ? readFileSync(paths.log, 'utf8').trim() : '';
        try { process.kill(child.pid); } catch { /* already gone */ }
        rmSync(paths.directory, { recursive: true, force: true });
        throw new Error(`The session daemon did not start.${log ? `\n${log}` : ''}`);
      }
    }
    console.error(`Session ${values.name} started.`);
    return 0;
  }
  if (command === 'list') {
    if (!existsSync(base)) return 0;
    for (const name of readdirSync(base)) {
      const meta = readMeta(name);
      if (meta) console.log(`${meta.name}\t${alive(meta.pid) ? 'running' : 'daemon gone'}\t${meta.mode}\t${meta.root}`);
    }
    return 0;
  }
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    as: { type: 'string', default: 'op' }, in: { type: 'string' }, for: { type: 'string' }, idle: { type: 'string' }, timeout: { type: 'string', default: '120' },
    last: { type: 'string' }, field: { type: 'string', multiple: true, default: [] }, deny: { type: 'boolean', default: false },
  } });
  const [name, ...args] = positionals;
  if (!name) throw new UsageError(`${command} needs a session name.\n\n${usage}`);
  const need = (count, shape) => { if (args.length < count) throw new UsageError(`Use ${command} <name> ${shape}.`); };
  let body;
  if (command === 'say') { need(1, '<text>'); if (args.length > 1) throw new UsageError('say takes one text argument; quote it.'); body = { op: 'say', as: values.as, in: values.in, text: args[0] }; }
  else if (command === 'click') { need(2, '<message> <control>'); body = { op: 'click', as: values.as, message: args[0], control: args[1] }; }
  else if (command === 'select') { need(3, '<message> <control> <value...>'); body = { op: 'select', as: values.as, message: args[0], control: args[1], values: args.slice(2) }; }
  else if (command === 'submit') {
    const fields = Object.fromEntries(values.field.map(entry => {
      const at = entry.indexOf('=');
      if (at < 1) throw new UsageError('Give fields as --field id=value.');
      return [entry.slice(0, at), entry.slice(at + 1)];
    }));
    body = { op: 'submit', as: values.as, fields };
  }
  else if (command === 'approve') body = { op: 'approve', as: values.as, deny: values.deny };
  else if (command === 'wait') {
    if (values.for === undefined && values.idle === undefined) throw new UsageError('wait needs --for REGEX or --idle MS.');
    if (values.for !== undefined) new RegExp(values.for, 'm');
    const timeout = Number(values.timeout), idle = values.idle === undefined ? undefined : Number(values.idle);
    if (!(timeout > 0) || (idle !== undefined && !(idle > 0))) throw new UsageError('--timeout and --idle must be positive numbers.');
    const reply = await session(name, { op: 'wait', pattern: values.for, idle, timeout });
    console.log(reply.screen ?? reply.text);
    return reply.gone ? 3 : reply.code;
  }
  else if (command === 'screen') body = { op: 'screen', in: values.in, last: values.last };
  else if (command === 'apps') body = { op: 'apps' };
  else if (command === 'app') { need(1, '<id>'); body = { op: 'app', id: args[0] }; }
  else if (command === 'advance') { need(1, '<duration>'); body = { op: 'advance', ms: duration(args[0]) }; }
  else if (command === 'log') body = { op: 'log', last: values.last };
  else if (['restart', 'status', 'stop'].includes(command)) body = { op: command };
  else throw new UsageError(`Unknown command ${command}.\n\n${usage}`);
  const reply = await session(name, body);
  console.log(reply.text);
  if (command === 'stop') rmSync(files(name).directory, { recursive: true, force: true });
  return reply.gone && command !== 'stop' ? 3 : 0;
}

client(process.argv.slice(2)).then(code => { if (code !== undefined) process.exitCode = code; }, error => {
  console.error(error instanceof UsageError ? error.message : `agent-discord: ${error.message}`);
  process.exitCode = 1;
});
