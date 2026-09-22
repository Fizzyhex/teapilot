import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture, mockServer, jev, completion } from './helpers.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });
const root = fileURLToPath(new URL('..', import.meta.url));

async function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve(root, 'src/cli.ts'), ...args], { cwd: root, windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('close', code => done({ code, stdout, stderr }));
  });
}

it('starts the native CLI and provides help without credentials', async () => {
  const result = await cli(['--help']);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('teapilot');
});

it('doctor and an ask request work from a clean machine config with mock endpoints', async () => {
  const f = await fixture(); cleanup.push(f.cleanup);
  const server = await mockServer((_body, request, response) => {
    if (request.url === '/jev') jev(response, 'ask.local');
    else if (request.url?.endsWith('/models')) response.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    else completion(response, { text: 'CLI mock response.' });
  }); cleanup.push(server.close);
  await writeFile(join(f.cwd, 'models.json'), JSON.stringify(f.config.models));
  await writeFile(join(f.cwd, 'policy.json'), JSON.stringify(f.config.policy));
  const env = {
    TEAPILOT_MODELS_FILE: join(f.cwd, 'models.json'), TEAPILOT_POLICY_FILE: join(f.cwd, 'policy.json'), TEAPILOT_STATE_DIR: f.config.stateDir,
    JEV_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'never-log-this-secret', JEV_API_URL: `${server.url}/jev`,
    LOCAL_BASE_URL: `${server.url}/v1`, LOCAL_MODEL: 'mock', LOCAL_ENABLED: 'true', ECONOMY_ENABLED: 'false', STRONG_ENABLED: 'false',
  };
  const doctor = await cli(['doctor'], env);
  expect(doctor.code, doctor.stderr).toBe(0);
  expect(doctor.stdout).not.toContain(env.TYPESAFE_API_KEY);
  const result = await cli(['--cwd', f.cwd, '--json', 'Explain a topic'], env);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ success: true, capability: 'ask.local', text: 'CLI mock response.' });
});
