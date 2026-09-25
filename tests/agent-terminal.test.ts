import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, mockServer, jev, completion } from './helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const pty = await import('@lydell/node-pty').then(() => true, () => false);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });

function term(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, [resolve(root, 'scripts/agent-terminal.mjs'), ...args], { cwd: root, windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('close', code => done({ code, stdout, stderr }));
  });
}

it('requires -- between driver options and teapilot arguments', async () => {
  const result = await term(['start', 'code', 'x']);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('start needs --');
});

it.skipIf(!pty)('drives an interactive code session through a real approval prompt', async () => {
  const f = await fixture(); cleanup.push(f.cleanup);
  const server = await mockServer((_body, request, response) => {
    if (request.url === '/jev') jev(response, 'coder.normal');
    else if (request.url?.endsWith('/models')) response.end(JSON.stringify({ data: [{ id: 'fast-test' }, { id: 'capable-test' }] }));
    else completion(response, { text: 'Mock turn finished.' });
  }); cleanup.push(server.close);
  await writeFile(join(f.cwd, 'models.json'), JSON.stringify(f.config.models));
  await writeFile(join(f.cwd, 'policy.json'), JSON.stringify(f.config.policy));
  const env = {
    TEAPILOT_MODELS_FILE: join(f.cwd, 'models.json'), TEAPILOT_POLICY_FILE: join(f.cwd, 'policy.json'), TEAPILOT_STATE_DIR: f.config.stateDir,
    JEV_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'never-log-this-secret', JEV_API_URL: `${server.url}/jev`,
    FAST_BASE_URL: `${server.url}/v1`, CAPABLE_BASE_URL: `${server.url}/v1`, TEAPILOT_NO_MOTION: '1',
  };
  const name = `vitest-${process.pid}`;
  cleanup.push(() => term(['stop', name]));

  const started = await term(['start', '--name', name, '--cwd', f.cwd, '--', 'code', '--config-dir', f.cwd, 'say hello'], env);
  expect(started.code, started.stderr).toBe(0);
  const turn = await term(['wait', name, '--for', '^Result: ', '--timeout', '60']);
  expect(turn.code, turn.stdout).toBe(0);
  expect(turn.stdout).toContain('Mock turn finished.');

  // Approvals are answered by typing, exactly as a user would.
  await term(['send', name, '/grant repository.shell', '--submit']);
  const approval = await term(['wait', name, '--for', 'Approve this action', '--timeout', '30']);
  expect(approval.code, approval.stdout).toBe(0);
  expect(approval.stdout).toContain('repository.shell');
  await term(['send', name, 'no', '--enter']);
  expect((await term(['wait', name, '--for', 'was not granted', '--timeout', '30'])).code).toBe(0);

  expect((await term(['wait', name, '--for', 'no such output', '--timeout', '1'])).code).toBe(124);
  await term(['send', name, '/exit', '--submit']);
  expect((await term(['wait', name, '--for', 'no such output', '--timeout', '30'])).code).toBe(3);
  expect((await term(['status', name])).stdout.trim()).toBe('exited 0');
  expect((await term(['transcript', name])).stdout).toContain('Mock turn finished.');
  expect(JSON.stringify(await term(['list']))).toContain(name);

  expect((await term(['stop', name])).code).toBe(0);
  expect(existsSync(join(tmpdir(), 'teapilot-term', `${name}.json`))).toBe(false);
}, 120_000);
