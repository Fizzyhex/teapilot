import { readFileSync } from 'node:fs';

export type ClipName = 'typing' | 'pawing' | 'tea-break';
export interface Clip { fps: number; frames: readonly string[] }
export type Clips = Record<ClipName, Clip>;

export function parseClip(raw: string, expectedCount: number): Clip {
  const value = JSON.parse(raw);
  if (value.format !== 'ascii-video-frames' || value.version !== 1 || value.frameRate !== 12
    || value.frameCount !== expectedCount || !Array.isArray(value.frames) || value.frames.length !== expectedCount) throw new Error('Invalid animation');
  const frames = value.frames.map((frame: { index: number; rows: unknown[] }, index: number) => {
    if (frame.index !== index || !Array.isArray(frame.rows) || frame.rows.length !== 19
      || !frame.rows.every(row => typeof row === 'string' && [...row].length === 60 && !/[\x00-\x1f\x7f-\x9f]/.test(row))
      || frame.rows.slice(0, 2).some(row => (row as string).trim())) throw new Error('Invalid animation frame');
    return frame.rows.slice(2).join('\n');
  });
  return { fps: value.frameRate, frames };
}

let cached: Clips | null | undefined;
export function loadClips(): Clips | undefined {
  if (cached === undefined) {
    try {
      cached = Object.fromEntries((['typing', 'pawing', 'tea-break'] as const).map(name => [name,
        parseClip(readFileSync(new URL(`ascii-${name}.json`, import.meta.url), 'utf8'), name === 'tea-break' ? 13 : 7),
      ])) as Clips;
    } catch { cached = null; }
  }
  return cached ?? undefined;
}

/** Clock-based playback skips missed frames and stops scheduling held poses. */
export class Playback {
  private timer?: ReturnType<typeof setTimeout>;
  private sequence?: { clip: Clip; indices: number[]; loop: boolean; started: number; onEnd?: () => void };
  frame?: string;
  constructor(private readonly draw: () => void) {}
  /** A non-looping sequence calls onEnd once, after drawing its final frame. */
  play(clip: Clip, indices = clip.frames.map((_, index) => index), loop = false, delay = 0, onEnd?: () => void): void {
    this.stop(); this.frame = undefined;
    this.sequence = { clip, indices, loop, started: performance.now() + delay, onEnd };
    if (delay) this.schedule(delay); else this.tick();
  }
  private schedule(delay: number): void { this.timer = setTimeout(() => this.tick(), delay); this.timer.unref(); }
  private tick(): void {
    this.timer = undefined;
    const sequence = this.sequence;
    if (!sequence) return;
    const elapsed = Math.max(0, performance.now() - sequence.started);
    const step = Math.floor(elapsed * sequence.clip.fps / 1000);
    const index = sequence.loop ? step % sequence.indices.length : Math.min(step, sequence.indices.length - 1);
    this.frame = sequence.clip.frames[sequence.indices[index]!];
    this.draw();
    if (this.sequence !== sequence) return;
    if (sequence.loop || index < sequence.indices.length - 1) {
      this.schedule(Math.max(1, (step + 1) * 1000 / sequence.clip.fps - elapsed));
    } else if (sequence.onEnd) { const onEnd = sequence.onEnd; sequence.onEnd = undefined; onEnd(); }
  }
  hold(frame?: string): void { this.stop(); this.frame = frame; this.draw(); }
  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.sequence = undefined; }
}
