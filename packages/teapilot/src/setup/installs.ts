import { ollamaURL, prepareOllamaModel, type OllamaModel, type PreparedModel } from '../runtime/ollama.js';
import type { SetupUI } from './terminal.js';

export type InstallState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export interface InstallJob {
  readonly id: string;
  readonly context: number;
  /** Approximate download size, when known, for disk space reservations. */
  readonly bytes: number;
  state: InstallState;
  /** What the running job is doing, for example "Downloading qwen3:8b". */
  phase: string;
  percent?: number;
  error?: string;
  result?: Omit<PreparedModel, 'roles'>;
}

const settled = (job: InstallJob) => job.state === 'done' || job.state === 'failed' || job.state === 'cancelled';

/**
 * Downloads and prepares Ollama models one at a time, in the order they were
 * queued, while the rest of setup stays usable. Jobs never ask questions: a
 * failed download is reported on the job and can be retried.
 */
export class InstallQueue {
  readonly jobs: InstallJob[] = [];
  private running?: { job: InstallJob; stop: AbortController };
  private readonly listeners = new Set<() => void>();
  constructor(private readonly signal: AbortSignal, readonly installed: OllamaModel[], private readonly options: { base?: string; verbose?: boolean; prepare?: typeof prepareOllamaModel } = {}) {}

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { for (const listener of this.listeners) listener(); }

  /** Queue a model, or return the matching job that is already queued, running or done. */
  add(id: string, context: number, bytes = 0): InstallJob {
    const existing = this.jobs.find(job => job.id === id && job.context === context && !['failed', 'cancelled'].includes(job.state));
    if (existing) return existing;
    const job: InstallJob = { id, context, bytes, state: 'queued', phase: 'Queued' };
    this.jobs.push(job);
    this.changed(); this.pump();
    return job;
  }
  /** Failed and cancelled jobs rejoin the end of the queue. */
  retry(job: InstallJob): void {
    if (job.state !== 'failed' && job.state !== 'cancelled') return;
    this.jobs.splice(this.jobs.indexOf(job), 1); this.jobs.push(job);
    Object.assign(job, { state: 'queued', phase: 'Queued', percent: undefined, error: undefined });
    this.changed(); this.pump();
  }
  cancel(job: InstallJob): void {
    if (job.state === 'queued') { job.state = 'cancelled'; this.changed(); }
    else if (this.running?.job === job) this.running.stop.abort();
  }
  get pending(): InstallJob[] { return this.jobs.filter(job => !settled(job)); }
  /** Bytes still to be downloaded by queued and running jobs. */
  get reservedBytes(): number {
    return this.pending.filter(job => !this.installed.some(model => model.name === job.id)).reduce((total, job) => total + job.bytes * 1.1, 0);
  }
  /** One line for the top of the screen, only while something is installing. */
  status(): string | undefined {
    const job = this.running?.job;
    if (!job) return undefined;
    const waiting = this.pending.length - 1;
    const phase = job.phase[0]!.toLowerCase() + job.phase.slice(1);
    return `${phase}${job.percent === undefined ? '' : ` - ${job.percent}%`}${waiting ? ` · ${waiting} queued` : ''}`;
  }
  /** Resolves once every given job has finished, failed or been cancelled. */
  settle(jobs: InstallJob[], signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => { if (jobs.every(settled)) { stop(); resolve(); } };
      const abort = () => { stop(); reject(signal.reason); };
      const unsubscribe = this.subscribe(check);
      const stop = () => { unsubscribe(); signal.removeEventListener('abort', abort); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else check();
    });
  }

  private pump(): void {
    if (this.running || this.signal.aborted) return;
    const job = this.jobs.find(item => item.state === 'queued');
    if (!job) return;
    const stop = new AbortController();
    this.running = { job, stop };
    Object.assign(job, { state: 'running', phase: `Starting ${job.id}`, percent: undefined });
    this.changed();
    const ui: SetupUI = {
      log: text => {
        const percent = text.match(/(\d+)%\s*$/)?.[1];
        if (percent !== undefined) { job.percent = Number(percent); this.changed(); }
      },
      activity: ({ label }) => { job.phase = label.replace(/\.{3}$/, ''); job.percent = undefined; this.changed(); return () => {}; },
      confirm: async () => false,
      input: async () => { throw new Error('Background installs cannot ask questions.'); },
      choose: async () => { throw new Error('Background installs cannot ask questions.'); },
    };
    const prepare = this.options.prepare ?? prepareOllamaModel;
    void prepare(ui, AbortSignal.any([this.signal, stop.signal]), job.id, job.context, this.installed, this.options.base ?? ollamaURL, this.options.verbose ?? false).then(result => {
      Object.assign(job, { state: 'done', result, percent: undefined, phase: `Ready ${job.id}` });
      if (!this.installed.some(model => model.name === job.id)) this.installed.push({ name: job.id, size: 0 });
    }, error => {
      Object.assign(job, { state: stop.signal.aborted ? 'cancelled' : 'failed', percent: undefined, error: error instanceof Error ? error.message : String(error) });
    }).finally(() => { this.running = undefined; this.changed(); this.pump(); });
  }
}
