import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { replaceFileSync } from '../replace.js';
import { clip } from './sandbox.js';
import { scratchLimits, type Kind, type Saved } from './scratch.js';
import type { RequestRecovery } from '../agents/recovery.js';
import { planReferenceSchema, type PlanReference } from './plan.js';

/** Bounds apply to stored working state as well as the view: history belongs in session transcripts. */
export const taskLimits = { steps: 8, claims: 16, artifacts: 128, receipts: 64, projectionChars: 6000, retrievalChars: scratchLimits.retrievalChars, stateBytes: 512 * 1024 };
const id = z.string().regex(/^[\w-]{1,80}$/);
const refs = z.array(id).max(4);
export const stepSchema = z.object({ id, goal: z.string().min(1).max(240), status: z.enum(['ready', 'working', 'blocked', 'done']), acceptance: z.string().max(240).default(''), evidence: refs.default([]) }).strict();
export const claimSchema = z.object({ id, text: z.string().min(1).max(400), basis: z.enum(['observed', 'inferred', 'reported']), evidence: refs.min(1) }).strict();
const artifactSchema = z.object({ id, sha256: z.string().regex(/^[a-f0-9]{64}$/), path: z.string().max(2048), bytes: z.number().int().nonnegative().max(8 * 1024 * 1024), lines: z.number().int().nonnegative(), complete: z.boolean(), kind: z.enum(['logs', 'pages', 'outputs']), actor: id, producer: id, at: z.number() }).strict();
const receiptSchema = z.object({ id, request: z.string().max(100), actor: id, tool: z.string().max(80), call: z.string().max(2000).optional(), argsSha256: z.string(), summary: z.string().max(240), excerpt: z.string().max(400), origin: z.enum(['file', 'inventory', 'saved-output', 'transcript']).optional(), status: z.enum(['pending', 'succeeded', 'failed', 'uncertain']), artifacts: z.array(id).max(8), at: z.number() }).strict();
const requestSchema = z.object({ id: z.string().max(100), calls: z.number().int().nonnegative(), modelCalls: z.number().int().nonnegative(), maxCalls: z.number().int().nonnegative(), maxModelCalls: z.number().int().nonnegative(), deadline: z.number(), status: z.string().max(80), delegations: z.number().int().nonnegative(), maxDelegations: z.number().int().nonnegative(), readOnly: z.boolean().optional(), juniorCalls: z.record(id, z.number().int().nonnegative()).default({}) }).strict();
const juniorSchema = z.object({ name: id, type: z.enum(['research', 'plan', 'implement', 'review']).optional(), agent_type: z.enum(['research', 'write', 'test']).optional(), description: z.string().max(500).optional(), assignment: z.string().max(24_000).optional(), artifacts: z.array(z.string().min(1).max(2048)).max(16).optional(), scratch: z.string().max(2048), turn: z.number().int().nonnegative(), turns: z.array(z.object({ user: z.string().max(24_000), assistant: z.string().max(4000) })).max(6) }).strict();
const stateSchema = z.object({
  version: z.literal(1), id, scope: z.string().max(4096), scratch: z.string().max(2048), revision: z.number().int().nonnegative(), objective: z.string().max(24_000),
  constraints: z.array(z.string().min(1).max(400)).max(8).refine(values => JSON.stringify(values).length <= 2400, 'constraints exceed the pinned context allowance'),
  currentRequest: z.string().max(24_000).optional(),
  status: z.enum(['active', 'waiting', 'blocked', 'completed', 'cancelled']),
  steps: z.array(stepSchema.extend({ actor: id, request: z.string().max(100).optional() })).max(taskLimits.steps),
  claims: z.array(claimSchema.extend({ actor: id, request: z.string().max(100).optional() })).max(taskLimits.claims),
  artifacts: z.array(artifactSchema).max(taskLimits.artifacts), receipts: z.array(receiptSchema).max(taskLimits.receipts), request: requestSchema.optional(), juniors: z.array(juniorSchema).max(30),
  juniorNames: z.array(id).max(128).default([]),
  plan: planReferenceSchema.optional(),
  fileFailures: z.array(z.tuple([z.string().regex(/^[a-f0-9]{64}$/), z.string().max(1000)])).max(64),
}).strict();
export type TaskState = z.infer<typeof stateSchema>;
export interface TaskActor { name: string; objective?: string; artifacts?: string[] }
export const instructor: TaskActor = { name: 'instructor' };
export interface TaskUpdate { revision: number; step?: z.input<typeof stepSchema>; claim?: z.input<typeof claimSchema>; remove_step?: string; remove_claim?: string }
const brief = (text: string, limit: number): string => {
  let allowance = limit, result = clip(text, allowance);
  while (JSON.stringify(result).length > limit + 2 && allowance > 0) {
    allowance = Math.floor(allowance / 2);
    result = clip(text, allowance);
  }
  return result;
};

/** Host-owned, atomic snapshots. runHost's state lock serializes writers; models only submit bounded deltas. */
export class TaskStore {
  private constructor(private readonly file: string, private state: TaskState, readonly scratch: string, private readonly redact: (text: string) => string) {}

  static open(stateDir: string, scope: string, objective: string, scratch: string, redact = (text: string) => text, constraints: string[] = []): TaskStore {
    const key = createHash('sha256').update(scope).digest('hex');
    const directory = join(stateDir, 'tasks');
    mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink()) throw new Error('task state directory is linked');
    const file = join(directory, `${key}.json`);
    let state: TaskState;
    if (existsSync(file)) {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > taskLimits.stateBytes) throw new Error('unsafe task state file');
      state = stateSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      if (state.scope !== scope) throw new Error('task scope mismatch');
      if (state.scratch !== resolve(scratch)) throw new Error('task scratch scope changed');
    } else state = stateSchema.parse({ version: 1, id: `t-${key.slice(0, 24)}`, scope, scratch: resolve(scratch), revision: 0, objective: redact(objective), constraints: constraints.map(redact), status: 'active', steps: [], claims: [], artifacts: [], receipts: [], juniors: [], juniorNames: [], fileFailures: [] });
    const store = new TaskStore(file, state, resolve(scratch), redact);
    // Never infer whether a call with a missing result executed. Do not replay it automatically.
    if (state.receipts.some(receipt => receipt.status === 'pending')) store.change(next => {
      for (const receipt of next.receipts) if (receipt.status === 'pending') receipt.status = 'uncertain';
      next.status = 'blocked';
    });
    else if (!existsSync(file)) store.change(() => undefined);
    return store;
  }

  snapshot(): TaskState { return structuredClone(this.state); }
  setPlan(plan: PlanReference): void {
    if (JSON.stringify(this.state.plan) !== JSON.stringify(plan)) this.change(next => { next.plan = plan; }, true);
  }
  /** Explicit user amendments come through the host, never through task_state. */
  configure(update: { objective?: string; constraints?: string[]; currentRequest?: string }): void {
    this.change(next => {
      if (update.objective !== undefined) next.objective = this.redact(update.objective);
      if (update.constraints !== undefined) next.constraints = update.constraints.map(value => this.redact(value));
      if (update.currentRequest !== undefined) next.currentRequest = this.redact(update.currentRequest);
    }, update.objective !== undefined || update.constraints !== undefined);
  }
  /** A cleared conversation must not resurrect its state or references on restart. */
  static clearScratch(stateDir: string, scratch: string): void {
    const directory = join(stateDir, 'tasks');
    if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) return;
    for (const name of readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = join(directory, name), info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > taskLimits.stateBytes) continue;
      try {
        const state = stateSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
        if (state.scratch === resolve(scratch)) rmSync(file);
      } catch { /* Corrupt or foreign records are not cleanup targets. */ }
    }
  }
  restoreRecovery(recovery: RequestRecovery): void { for (const [key, value] of this.state.fileFailures) recovery.fileFailures.set(key, value); }
  saveRecovery(recovery: RequestRecovery): void {
    const failures = [...recovery.fileFailures].slice(-64).map(([key, value]): [string, string] => [key, this.redact(value).slice(0, 1000)]);
    if (JSON.stringify(failures) !== JSON.stringify(this.state.fileFailures)) this.change(next => { next.fileFailures = failures; });
  }
  private change(update: (next: TaskState) => void, working = false): void {
    const next = structuredClone(this.state);
    update(next); if (working) next.revision++;
    const valid = stateSchema.parse(next);
    const text = JSON.stringify(valid);
    if (Buffer.byteLength(text) > taskLimits.stateBytes) throw new Error('task state exceeds storage limit');
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    try { replaceFileSync(temporary, this.file); } finally { rmSync(temporary, { force: true }); }
    this.state = valid;
  }

  startRequest(request: string, limits: { calls: number; modelCalls: number; timeoutMs: number; delegations?: number; readOnly?: boolean }): void {
    if (this.state.request?.id === request) return;
    this.change(next => {
      next.status = 'active';
      next.request = { id: request, calls: 0, modelCalls: 0, maxCalls: limits.calls, maxModelCalls: limits.modelCalls, deadline: Date.now() + limits.timeoutMs, status: 'active', delegations: 0, maxDelegations: limits.delegations ?? 6, readOnly: limits.readOnly ?? false, juniorCalls: {} };
    });
  }
  remaining(): { calls: number; modelCalls: number; ms: number } {
    const request = this.state.request;
    if (!request) throw new Error('task request has not started');
    return { calls: Math.max(0, request.maxCalls - request.calls), modelCalls: Math.max(0, request.maxModelCalls - request.modelCalls), ms: Math.max(0, request.deadline - Date.now()) };
  }
  consumeModel(): boolean {
    const remaining = this.remaining();
    if (!remaining.modelCalls || !remaining.ms) return false;
    this.change(next => { next.request!.modelCalls++; });
    return true;
  }
  get delegationExhausted(): boolean { return !this.state.request || this.state.request.delegations >= this.state.request.maxDelegations || this.remaining().calls <= 4; }
  juniorCalls(name: string): number { return this.state.request?.juniorCalls[name] ?? 0; }
  consumeJunior(name: string): void { this.change(next => { next.request!.juniorCalls[name] = (next.request!.juniorCalls[name] ?? 0) + 1; }); }
  consumeDelegation(): boolean {
    if (this.delegationExhausted) return false;
    this.change(next => { next.request!.delegations++; });
    return true;
  }
  saveJunior(junior: z.infer<typeof juniorSchema>, dismiss = false): void {
    this.change(next => {
      const value = juniorSchema.parse({ ...junior, ...(junior.description ? { description: this.redact(junior.description) } : {}), ...(junior.assignment ? { assignment: this.redact(junior.assignment) } : {}), turns: junior.turns.slice(-6).map(turn => ({ user: this.redact(turn.user), assistant: this.redact(turn.assistant).slice(0, 4000) })) });
      next.juniors = next.juniors.filter(item => item.name !== value.name);
      if (!dismiss) {
        next.juniors.push(value);
        if (!next.juniorNames.includes(value.name)) next.juniorNames.push(value.name);
      }
    });
  }
  authorizeArtifacts(actor: TaskActor, references: string[]): void {
    if (references.length > 16 || references.some(ref => !this.state.artifacts.some(artifact => artifact.id === ref && this.accessible(actor, artifact)))) throw new Error('unknown or inaccessible delegation evidence');
  }
  authorizeEvidence(actor: TaskActor, references: string[]): void {
    if (references.length > 4 || references.some(ref => !this.state.artifacts.some(artifact => artifact.id === ref && this.accessible(actor, artifact))
      && !this.state.receipts.some(receipt => receipt.id === ref && ['succeeded', 'failed'].includes(receipt.status) && (actor.name === instructor.name || receipt.actor === actor.name)))) throw new Error('unknown or inaccessible artifact/receipt');
  }
  begin(actor: TaskActor, tool: string, args: unknown, call?: string): string | undefined {
    const remaining = this.remaining();
    if (!remaining.calls || !remaining.ms) return undefined;
    const receipt = `e-${randomUUID()}`;
    const data = (args ?? {}) as { path?: unknown; command?: unknown; url?: unknown; pattern?: unknown; query?: unknown };
    const search = data.pattern ?? data.query;
    const summary = String(data.path ?? data.command ?? data.url ?? '') + (search === undefined ? '' : `; ${String(search)}`);
    this.change(next => {
      next.request!.calls++;
      if (next.receipts.length >= taskLimits.receipts) {
        const removable = next.receipts.findIndex(item => item.status !== 'pending');
        if (removable < 0) throw new Error('too many pending tool calls');
        next.receipts.splice(removable, 1);
      }
      next.receipts.push({ id: receipt, request: next.request!.id, actor: actor.name, tool, ...(call ? { call } : {}), argsSha256: createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex'), summary: brief(this.redact(summary), 240), excerpt: '', status: 'pending', artifacts: [], at: Date.now() });
    });
    return receipt;
  }
  settle(receipt: string, failed: boolean, excerpt = '', origin?: 'file' | 'inventory' | 'saved-output' | 'transcript'): void {
    this.change(next => {
      const found = next.receipts.find(item => item.id === receipt);
      if (!found || found.status !== 'pending') throw new Error('unknown pending tool receipt');
      found.status = failed ? 'failed' : 'succeeded';
      found.excerpt = this.redact(excerpt).slice(0, 400);
      if (origin) found.origin = origin;
    });
  }
  register(actor: TaskActor, producer: string, saved: Saved, kind: Kind): void {
    const path = resolve(saved.path), rel = relative(this.scratch, path);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('artifact is outside this task scratchpad');
    this.change(next => {
      const receipt = next.receipts.find(item => item.id === producer && item.actor === actor.name);
      if (!receipt) throw new Error('artifact producer is unknown');
      const { id, sha256, bytes, lines, complete } = saved;
      const entry = artifactSchema.parse({ id, sha256, bytes, lines, complete, path, kind, actor: actor.name, producer, at: Date.now() });
      next.artifacts = [...next.artifacts, entry].slice(-taskLimits.artifacts);
      receipt.artifacts.push(entry.id);
    });
  }
  private accessible(actor: TaskActor, artifact: TaskState['artifacts'][number]): boolean {
    return actor.name === instructor.name || artifact.actor === actor.name || Boolean(actor.artifacts?.includes(artifact.id));
  }
  update(actor: TaskActor, input: TaskUpdate): void {
    if (input.revision !== this.state.revision) throw new Error(`stale state revision; current revision is ${this.state.revision}`);
    this.change(next => {
      const validate = (evidence: string[]) => {
        for (const ref of evidence) {
          const artifact = next.artifacts.some(artifact => artifact.id === ref && this.accessible(actor, artifact));
          const receipt = next.receipts.some(receipt => receipt.id === ref && ['succeeded', 'failed'].includes(receipt.status) && (actor.name === instructor.name || receipt.actor === actor.name));
          if (!artifact && !receipt) throw new Error(`unknown or inaccessible artifact/receipt: ${ref}`);
        }
      };
      for (const [key, remove] of [['steps', input.remove_step], ['claims', input.remove_claim]] as const) {
        if (remove) {
          if (next[key].some(item => item.id === remove && item.actor !== actor.name)) throw new Error('cannot remove another actor\'s state');
          // Both record types have the same ownership fields; mutate the array rather than widening its type.
          const index = next[key].findIndex(item => item.id === remove);
          if (index >= 0) next[key].splice(index, 1);
        }
      }
      if (input.step) {
        const step = stepSchema.parse(input.step); validate(step.evidence);
        if (next.steps.some(item => item.id === step.id && item.actor !== actor.name)) throw new Error('step ID belongs to another actor');
        const index = next.steps.findIndex(item => item.id === step.id && item.actor === actor.name);
        const value = { ...step, goal: this.redact(step.goal), acceptance: this.redact(step.acceptance), actor: actor.name, request: next.request?.id };
        if (index < 0) next.steps.push(value); else next.steps[index] = value;
      }
      if (input.claim) {
        const claim = claimSchema.parse(input.claim); validate(claim.evidence);
        if (next.claims.some(item => item.id === claim.id && item.actor !== actor.name)) throw new Error('claim ID belongs to another actor');
        const index = next.claims.findIndex(item => item.id === claim.id && item.actor === actor.name);
        const value = { ...claim, text: this.redact(claim.text), actor: actor.name, request: next.request?.id };
        if (index < 0) next.claims.push(value); else next.claims[index] = value;
      }
    }, true);
  }
  finish(status: string): void {
    this.change(next => {
      for (const receipt of next.receipts) if (receipt.status === 'pending') receipt.status = 'uncertain';
      if (next.request) next.request.status = status;
      next.status = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'blocked';
    });
  }
  /** One current view, replaced before each inference. Model-authored text is data, never prompt authority. */
  project(actor: TaskActor): string {
    const artifacts = this.state.artifacts.filter(item => this.accessible(actor, item));
    let objective = clip(actor.objective ?? this.state.objective, 800);
    while (JSON.stringify(objective).length > 1000) objective = clip(objective, Math.floor(objective.length / 2));
    const view = { task: this.state.id, revision: this.state.revision, objective, constraints: this.state.constraints, plan: actor.name === instructor.name ? this.state.plan : undefined, readOnly: this.state.request?.readOnly ?? false,
      budget: this.remaining(),
      steps: this.state.steps.filter(item => item.actor === actor.name && item.status !== 'done').map(item => ({ ...item, historical: item.request !== this.state.request?.id, goal: brief(item.goal, 160), acceptance: brief(item.acceptance, 160) })),
      claims: this.state.claims.filter(item => item.actor === actor.name).slice(-4).map(item => ({ ...item, historical: item.request !== this.state.request?.id, text: brief(item.text, 240) })),
      juniors: actor.name === instructor.name ? this.state.juniors.slice(-4).map(({ name, description, agent_type, type, turn, assignment }) => ({ name, description, agent_type, legacyType: type, turn, assignment: assignment && brief(assignment, 240) })) : undefined,
      recent: this.state.receipts.filter(item => actor.name === instructor.name || item.actor === actor.name).slice(-4).map(({ id, actor, tool, summary, status, artifacts }) => ({ id, actor, tool, summary, status, artifacts })),
      observations: this.observations(actor),
      artifacts: artifacts.slice(-4).map(({ id, kind, bytes, complete, producer }) => ({ id, kind, bytes, complete, producer })),
    };
    while (JSON.stringify(view).length > taskLimits.projectionChars) {
      if (view.claims.length) view.claims.shift();
      else if (view.recent.length) view.recent.shift();
      else if (view.observations.length > 1) view.observations.pop();
      else if (view.steps.length > 1) view.steps.pop();
      else if (view.artifacts.length) view.artifacts.shift();
      else if (view.juniors?.length) view.juniors.shift();
      else break;
    }
    const text = JSON.stringify(view);
    if (text.length > taskLimits.projectionChars) throw new Error('task projection exceeds its context allowance');
    return text;
  }
  /** Host-recorded observations work even when a model never opts into bookkeeping. */
  private observations(actor: TaskActor) {
    const distinct = new Map<string, TaskState['receipts'][number]>();
    for (const item of this.state.receipts) {
      if (!item.origin || !['succeeded', 'failed'].includes(item.status) || (actor.name !== instructor.name && item.actor !== actor.name)) continue;
      distinct.delete(`${item.tool}:${item.summary}`);
      distinct.set(`${item.tool}:${item.summary}`, item);
    }
    const priority = { file: 3, inventory: 2, 'saved-output': 1, transcript: 0 };
    return [...distinct.values()].sort((a, b) => priority[b.origin!] - priority[a.origin!] || b.at - a.at).slice(0, 3)
      .map(({ id, tool, summary, origin, excerpt, status, request }) => ({ id, tool, source: summary, origin, excerpt: brief(excerpt, 240), status, request }));
  }
  catalog(actor: TaskActor, kind: 'artifacts' | 'receipts' | 'steps' | 'claims', offset = 0): string {
    if (!Number.isInteger(offset) || offset < 0) throw new Error('invalid catalog offset');
    const records = kind === 'artifacts'
      ? this.state.artifacts.filter(item => this.accessible(actor, item)).map(({ id, kind, actor, producer, complete, bytes }) => ({ id, kind, actor, producer, complete, bytes }))
      : this.state[kind].filter(item => actor.name === instructor.name || item.actor === actor.name).map(item => {
        if ('tool' in item) return { id: item.id, actor: item.actor, tool: item.tool, summary: brief(item.summary, 120), origin: item.origin, status: item.status };
        if ('goal' in item) return { id: item.id, actor: item.actor, goal: brief(item.goal, 120), status: item.status };
        return { id: item.id, actor: item.actor, text: brief(item.text, 120), basis: item.basis };
      });
    return JSON.stringify({ kind, total: records.length, offset, records: records.slice(offset, offset + 8), next: offset + 8 < records.length ? offset + 8 : null });
  }
  record(actor: TaskActor, record: string): string {
    const item = [...this.state.steps, ...this.state.claims, ...this.state.receipts].find(item => item.id === record && (actor.name === instructor.name || actor.name === item.actor));
    if (!item) throw new Error('unknown or inaccessible state record');
    return clip(JSON.stringify(item), taskLimits.projectionChars);
  }
  async artifact(actor: TaskActor, handle: string, options: { offset?: number; limit?: number; search?: string } = {}): Promise<string> {
    const artifact = this.state.artifacts.find(item => item.id === handle && this.accessible(actor, item));
    if (!artifact) throw new Error('unknown, expired or inaccessible artifact');
    const path = resolve(artifact.path), rel = relative(this.scratch, path);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('artifact is outside this task scratchpad');
    // Check every component, including parents of the scratch root. Never follow a planted link.
    let current = path;
    for (;;) {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) throw new Error('linked artifact paths are not allowed');
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    const info = await lstat(path);
    if (!info.isFile() || info.size !== artifact.bytes || info.size > scratchLimits.fileBytes) throw new Error('artifact is missing or changed');
    const bytes = await readFile(path);
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('artifact is changed');
    const offset = options.offset ?? 1, limit = options.limit ?? 40;
    if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100 || (options.search !== undefined && (!options.search || options.search.length > 200))) throw new Error('invalid artifact range or search');
    const text = bytes.toString('utf8');
    const found: string[] = [];
    let start = 0, lineNumber = 1, chars = 0;
    while (start < text.length && found.length < limit && chars < taskLimits.retrievalChars) {
      const newline = text.indexOf('\n', start), end = newline < 0 ? text.length : newline;
      if (lineNumber >= offset) {
        const line = text.slice(start, end), match = options.search === undefined ? -1 : line.indexOf(options.search);
        if (options.search === undefined || match >= 0) {
          // Search must expose the actual match, even when a single giant line would hide it in a head/tail clip.
          const from = Math.max(0, match - 300), to = match + (options.search?.length ?? 0) + 300;
          const shown = match >= 0 && line.length > taskLimits.retrievalChars
            ? `${from ? '[…] ' : ''}${line.slice(from, to)}${to < line.length ? ' […]' : ''} (column ${match + 1})`
            : clip(line, taskLimits.retrievalChars);
          const entry = `${lineNumber}: ${shown}`;
          found.push(entry); chars += entry.length;
        }
      }
      if (newline < 0) break;
      start = end + 1; lineNumber++;
    }
    return clip(`artifact ${handle} (${artifact.complete ? 'complete' : 'incomplete'}, ${artifact.lines} lines)\n${found.join('\n') || 'no matches'}`, taskLimits.retrievalChars);
  }
}
