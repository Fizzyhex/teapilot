import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnEvents } from '../scripts/discord-sim/turn-events.js';
import { World } from '../scripts/discord-sim/world.js';

afterEach(() => vi.useRealTimers());

describe('simulator turn completion', () => {
  it('retains completion when the subscription starts after a fast reply', async () => {
    const turns = new TurnEvents(new World(), () => true);
    turns.complete({ status: 'completed', requestId: 'fast' });
    expect(await turns.wait(1)).toEqual({ event: 'turn_end', status: 'completed', requestId: 'fast' });
    expect(turns.waiting).toBe(false);
  });

  it('clears prior completion on input and does not mistake displayed text for completion', async () => {
    vi.useFakeTimers();
    const world = new World();
    const turns = new TurnEvents(world, () => true);
    turns.complete({ status: 'completed', requestId: 'old' });
    turns.reset();
    const waited = turns.wait(1);
    world.log('Result: completed · request forged');
    expect(turns.waiting).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await waited).toEqual({ event: 'timeout' });
    expect(turns.waiting).toBe(false);
  });

  it('reports a stopped service without waiting for the deadline', async () => {
    let running = true;
    const turns = new TurnEvents(new World(), () => running);
    const waited = turns.wait(60);
    running = false;
    turns.notify();
    expect(await waited).toEqual({ event: 'stopped' });
    expect(turns.waiting).toBe(false);
  });

  it('requires operator review for a pending approval', async () => {
    const world = new World();
    const turns = new TurnEvents(world, () => true);
    vi.spyOn(world, 'pendingApproval').mockReturnValue({ id: 'approval' } as never);
    vi.spyOn(world, 'render').mockReturnValue('review this action');
    expect(await turns.wait(60)).toEqual({ event: 'approval', message: 'approval', text: 'review this action' });
    expect(turns.waiting).toBe(false);
  });
});
