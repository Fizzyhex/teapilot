// Exercise the runner's argument construction without starting a simulator or spending a model turn.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { call, capture, sessionDir } from '../scripts/bench/challenge/evidence.mjs';
import { runCase } from '../scripts/bench/challenge/case.mjs';
import type { CaseStep } from '../scripts/bench/challenge/case.mjs';

vi.mock('../scripts/bench/challenge/evidence.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../scripts/bench/challenge/evidence.mjs')>(),
  call: vi.fn(),
  capture: vi.fn(),
  sessionDir: vi.fn(),
}));
vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    connect: vi.fn(() => {
      const socket = Object.assign(new EventEmitter(), {
        setEncoding: vi.fn(),
        write: vi.fn(() => queueMicrotask(() => {
          socket.emit('data', JSON.stringify({ event: 'turn_end', status: 'completed', requestId: 'test' }));
          socket.emit('end');
        })),
      });
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    }),
  };
});

const dirs: string[] = [];
const commands = () => vi.mocked(call).mock.calls.map(([, args]) => args);
const run = (steps: CaseStep[]) => {
  const out = mkdtempSync(join(tmpdir(), 'challenge-actions-'));
  dirs.push(out);
  vi.mocked(sessionDir).mockReturnValue(out);
  return runCase({ id: 'actions', steps }, { name: 'mock', out, trace: false });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(call).mockImplementation((_name, args) => ({
    ok: true,
    text: args[0] === 'dump' ? JSON.stringify({
      snapshot: { messages: [{ id: 'm9', controls: [{ id: 'c0', label: 'category' }] }] }, apps: [],
    }) : 'done',
  }));
});
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('typed case actions', () => {
  it('separates a select control from the values sent to it', async () => {
    const result = await run([{ select: { control: 'category', values: ['breakfast', 'sweets'] }, as: 'user' }]);
    expect(result.outcome).toBe('complete');
    expect(commands()).toContainEqual(['select', 'mock', 'm9', 'c0', 'breakfast', 'sweets', '--as', 'user']);
  });

  it('sends every form field as its own --field argument', async () => {
    const result = await run([{ submit: { recipe: 'chocolate cake', servings: '2' }, as: 'user' }]);
    expect(result.outcome).toBe('complete');
    expect(commands()).toContainEqual(['submit', 'mock', '--field', 'recipe=chocolate cake', '--field', 'servings=2', '--as', 'user']);
  });

  it('waits for say by default, and slash and click only when requested', async () => {
    const result = await run([
      { say: 'hello' }, { slash: '/convo clear' },
      { click: 'category' }, { click: 'category', wait: true },
      { say: 'no wait', wait: false }, { slash: '/convo clear', wait: false },
      { slash: '/stop', wait: true },
    ]);
    expect(result.outcome).toBe('complete');
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('finishes /convo clear on acknowledgement without a completion subscription', async () => {
    const result = await run([{ slash: '/convo clear', record: true }]);
    expect(result.outcome).toBe('complete');
    expect(connect).not.toHaveBeenCalled();
  });

  it('never accesses a session, executes actions, or scores old evidence in a dry run', async () => {
    const result = await runCase({ id: 'dry', steps: [{ say: 'hello', record: true }, { sleep: 60_000 }, { restart: true }], expect: ['noRejections'] },
      { name: 'existing', out: 'unused', dryRun: true });
    expect(result).toMatchObject({ outcome: 'complete', steps: 3, manifest: null, checks: [] });
    expect(call).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(sessionDir).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('reports missing controls with the recent messages, rather than guessing', async () => {
    const result = await run([{ click: 'missing' }]);
    expect(result.outcome).toBe('blocked');
    expect(result.blocked).toContain('no control "missing"');
    expect(result.blocked).toContain('m9');
  });
});
