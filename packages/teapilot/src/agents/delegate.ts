import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { Config } from '../config.js';
import type { ConversationTurn } from '../integration/events.js';
import type { AttemptInput, AttemptResult } from './run.js';
import { instructor } from '../workspace/task.js';
import { planningTools } from './planning.js';
import type { RequestAllowance } from './allowance.js';

export const juniorTypes = ['research', 'plan', 'implement', 'review'] as const;
export type JuniorType = typeof juniorTypes[number];
export const juniorProfiles = {
  research: { calls: 8, task: 'establish source-backed facts and unknowns; stop once the assigned question is answered' },
  plan: { calls: 6, task: 'turn findings into concrete steps, verification and unresolved choices' },
  implement: { calls: 20, task: 'make the assigned changes and check them' },
  review: { calls: 8, task: 'inspect the assigned changes; report concrete defects, locations and verification gaps' },
} as const;
export const juniorReadOnly = (type: JuniorType): boolean => type !== 'implement';
/** Profiles are access ceilings, including after capability refreshes, not just prompt advice. */
export function juniorTools(tools: AgentTool[], type: JuniorType): AgentTool[] {
  const local = tools.filter(tool => !juniorPlayWithheld.includes(tool.name) && tool.name !== 'file_send' && !tool.name.startsWith('access_') && tool.name !== 'request_access');
  return juniorReadOnly(type) ? planningTools(local).concat(type === 'review' ? local.filter(tool => tool.name === 'play_test') : []) : local;
}

/**
 * Juniors: an attempt hands a self-contained part of a large request to a junior, which works it in a clean context
 * with type-limited access and shared workspace, budget and approvals, then reports back. The junior is another runAttempt on the
 * same tier, in this process, while the instructor waits in its delegate_task call, so one model serves both and
 * the instructor's context grows by the instruction and the report alone, not by the junior's tool traffic.
 */

export interface JuniorReport { status: 'done' | 'needs_input' | 'stuck'; summary: string; question?: string; evidence?: string[] }
/**
 * What a junior's own attempt is told: its name, which turn this is, where its report goes, and the folder its
 * instructor's file tools work in when neither has the repository, so both see the same files.
 */
export interface JuniorRole { name: string; type: JuniorType; assignment: string; turn: number; root?: string; onReport: (report: JuniorReport) => void }

/** Delegation messages one attempt may send across all its juniors, so a small model cannot loop on "try again". */
export const defaultJuniorTurns = 6;
/** Tool calls a junior has left when it is told to report, so the report itself still fits under the limit. */
export const juniorReportMargin = 3;
/** Play tools a junior does not get: its instructor posts apps, so a request never posts two copies. */
export const juniorPlayWithheld = ['play_start', 'play_update', 'play_resend', 'play_stop'];
/** Below this context, a report costs the instructor more than the junior saves it. */
export const delegationMinContext = 16_384;

const phonetic = ['alfa', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett', 'kilo', 'lima', 'mike',
  'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu'];

/**
 * A new junior's name, always junior-<name>: a random teachat identity that no conversation holds and no junior of this
 * attempt has had, else junior-<phonetic> in order, numbered once the alphabet runs out. Juniors only borrow a name; they never lease it.
 */
export function juniorName(identities: ReadonlyArray<{ username: string; leased: boolean }>, taken: ReadonlySet<string>, rng = Math.random): string {
  const free = identities.filter(identity => !identity.leased && !taken.has(`junior-${identity.username}`));
  if (free.length) return `junior-${free[Math.floor(rng() * free.length)]!.username}`;
  for (let round = 1; ; round++) {
    const name = phonetic.map(word => `junior-${word}${round > 1 ? `-${round}` : ''}`).find(candidate => !taken.has(candidate));
    if (name) return name;
  }
}

/** Teachat's identities as juniorName takes them; none when teachat is off or its room cannot be read. */
async function teachatIdentities(config: Config): Promise<Array<{ username: string; leased: boolean }>> {
  if (!config.teachat?.enabled) return [];
  try {
    const { leaseActive, openRoom } = await import('teachat');
    const now = Date.now();
    return (await (await openRoom({ dir: config.teachat.dir })).identities()).map(identity => ({ username: identity.username, leased: leaseActive(identity, now) }));
  } catch { return []; }
}

export function juniorPrompt(name: string, type: JuniorType): string {
  return `You are a sub-agent named ${name}. ${juniorProfiles[type].task}. Call \`report\` once: done with findings/changes and checks; \`needs_input\` with a question for your instructor; or \`stuck\` with partial findings and what prevented completion.`;
}

export function delegationPrompt(): string {
  return '\n- For large work, delegate self-contained parts with a clear type (research, plan, implement, review) and assignment (goal, sources/files, completion check). Juniors start with clean context and bounded access; review their reports and continue the same junior within its scope. Small questions and quick edits are faster yourself.';
}

/** The tool a junior ends its turn with; its result stops the junior's attempt. */
export function reportTool(role: JuniorRole): AgentTool {
  return {
    name: 'report', label: 'Report',
    description: 'Report back and end this turn: `done`, `needs_input` (with a question), or `stuck`.',
    parameters: Type.Object({
      status: Type.Union([Type.Literal('done'), Type.Literal('needs_input'), Type.Literal('stuck')]),
      summary: Type.String({ minLength: 1, maxLength: 4000, description: 'Findings or changes, source locations/checks, and anything unresolved. Large evidence stays in artifacts.' }),
      question: Type.Optional(Type.String({ maxLength: 600, description: 'For needs_input: what you need answered.' })),
      evidence: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 4, description: 'Artifact or settled receipt IDs supporting this report, when available.' })),
    }),
    execute: async (_id, args) => {
      const { status, summary, question, evidence } = args as JuniorReport;
      if (status === 'needs_input' && !question?.trim()) throw new Error('needs_input requires a question for your instructor');
      role.onReport({ status, summary: String(summary ?? '').slice(0, 4000), ...(question ? { question: String(question) } : {}), ...(evidence ? { evidence } : {}) });
      return { content: [{ type: 'text', text: 'Report sent.' }], details: {}, terminate: true };
    },
  };
}

interface Junior { name: string; type?: JuniorType; assignment?: string; turns: ConversationTurn[]; scratch: string; turn: number }
/** Allocate the type's remaining allowance, leaving the instructor room to review or continue another junior. */
export function juniorAllowance(remaining: number, maximum: number): number {
  return Math.max(0, Math.min(maximum, remaining - 4));
}
/** The instructor's attempt clock, paused while a junior works on its own. */
export interface Clock { pause(): void; resume(): void }

/**
 * Each delegation is one attempt of a junior, with its own instructor exchanges. Without task state juniors are
 * attempt-local; with it their identities and bounded exchanges survive retries and restarts.
 */
export function delegateTool(parent: AttemptInput, scratch: string, root: string | undefined, clock: Clock, run: (input: AttemptInput) => Promise<AttemptResult>, allowance: RequestAllowance) {
  const juniors = new Map<string, Junior>();
  const taken = new Set<string>(parent.task?.snapshot().juniorNames ?? []);
  for (const saved of parent.task?.snapshot().juniors ?? []) {
    juniors.set(saved.name, saved); taken.add(saved.name);
  }
  let identities: Promise<Array<{ username: string; leased: boolean }>> | undefined;
  const limit = parent.config.policy.limits.maxJuniorTurns ?? defaultJuniorTurns;
  let sent = 0;
  const tool: AgentTool = {
    name: 'delegate_task', label: 'Delegate',
    description: 'Assign a bounded task to a typed junior with clean context and wait for its report. New juniors require type. Continue by name within the same type; follow-ups share its request allowance. done: true dismisses it.',
    parameters: Type.Object({
      junior: Type.Optional(Type.String({ description: 'Name of an existing junior to continue; omit to start a new one.' })),
      type: Type.Optional(Type.Union(juniorTypes.filter(type => !parent.readOnly || type !== 'implement').map(type => Type.Literal(type)), { description: 'Required for a new junior: research facts, plan steps, implement changes, or review defects. Fixed for its lifetime.' })),
      message: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: 'Required unless dismissing: a self-contained goal, sources/files and completion check, or a follow-up within the existing assignment.' })),
      done: Type.Optional(Type.Boolean({ description: 'Dismiss this junior; message is ignored.' })),
      evidence: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 4, description: 'Any parent artifact IDs this junior needs for this turn.' })),
    }),
    execute: async (_id, args, signal) => {
      const { junior: named, type: requestedType, message, done, evidence: references = [] } = args as { junior?: string; type?: JuniorType; message?: string; done?: boolean; evidence?: string[] };
      if (done) {
        const existing = named && juniors.get(named);
        if (!existing) return { content: [{ type: 'text', text: `No junior named ${named ?? '(none given)'}.` }], details: {} };
        parent.task?.saveJunior(existing, true); juniors.delete(named!);
        return { content: [{ type: 'text', text: `Dismissed ${named}.` }], details: { junior: named } };
      }
      if (named && !juniors.has(named)) return { content: [{ type: 'text', text: `No junior named ${named}. Active: ${[...juniors.keys()].join(', ') || 'none'}. Omit junior to start a new one.` }], details: {} };
      if (!message?.trim()) return { content: [{ type: 'text', text: 'Give the junior a message.' }], details: {} };
      const existing = named ? juniors.get(named) : undefined;
      const type = existing?.type ?? requestedType;
      if (!type || !juniorTypes.includes(type)) return { content: [{ type: 'text', text: 'choose a junior type: research, plan, implement, or review.' }], details: {} };
      if (existing?.type && requestedType && requestedType !== existing.type) return { content: [{ type: 'text', text: `this junior is ${existing.type}; start a new junior for ${requestedType} work.` }], details: {} };
      if (parent.readOnly && type === 'implement') return { content: [{ type: 'text', text: 'implementation is unavailable in a read-only request.' }], details: {} };
      const available = juniorProfiles[type].calls - (named ? allowance.usedBy(named) : 0);
      const allocation = juniorAllowance(allowance.remaining().calls, Math.min(parent.config.policy.limits.maxToolCalls, available));
      if (allocation < 2) return { content: [{ type: 'text', text: 'junior allowance spent or too little room to work and report; finish from existing evidence.' }], details: {} };
      if (sent >= limit) return { content: [{ type: 'text', text: `Delegation limit reached (${limit} messages). Finish the work yourself.` }], details: {} };
      parent.task?.authorizeArtifacts(parent.taskActor ?? instructor, references);
      if (!allowance.consumeDelegation()) return { content: [{ type: 'text', text: 'request-wide delegation allowance reached; finish from existing evidence.' }], details: {} };
      sent++;
      let junior = named ? juniors.get(named)! : undefined;
      if (!junior) {
        identities ??= teachatIdentities(parent.config);
        const name = juniorName(await identities, taken);
        taken.add(name);
        junior = { name, type, assignment: message, turns: [], turn: 0, scratch: join(scratch, 'juniors', name.replace(/[^\w.-]+/g, '_')) };
        juniors.set(name, junior);
      }
      junior.type = type; junior.assignment ??= message;
      parent.task?.saveJunior(junior);
      const { name } = junior;
      let report: JuniorReport | undefined;
      const started = Date.now();
      clock.pause();
      let result: AttemptResult;
      try {
        result = await run({
          config: { ...parent.config, policy: { ...parent.config.policy, limits: { ...parent.config.policy.limits, maxToolCalls: allocation } } },
          tier: parent.tier, workload: parent.workload, cwd: parent.cwd, web: parent.web, mode: parent.mode,
          budget: parent.budget, telemetry: parent.telemetry, approve: parent.approve, beforeMutation: parent.beforeMutation,
          authorization: parent.authorization, activePermissions: parent.activePermissions, requestCapabilities: parent.requestCapabilities,
          workspace: parent.workspace, webController: parent.webController, play: parent.play, searchUnavailable: parent.searchUnavailable, attempt: parent.attempt,
          signal: signal ?? parent.signal, history: junior.turns, scratch: junior.scratch, prompt: message, requestText: message,
          recovery: parent.recovery, task: parent.task, taskActor: { name, objective: message, artifacts: references },
          readOnly: parent.readOnly || juniorReadOnly(type), taskId: parent.taskId, allowance,
          currentRequest: message,
          // Its words are for the instructor, not the person: only what its tools do is shown.
          onEvent: event => { if (event.type.startsWith('tool_execution_') || event.type === 'compaction_start') parent.onEvent?.({ ...event, junior: name }); },
          onActivity: activity => parent.onActivity?.(activity && { ...activity, label: `${name}: ${activity.label}` }),
          junior: { name, type, assignment: junior.assignment, turn: junior.turn + 1, root, onReport: value => { report = value; } },
        });
      } finally { clock.resume(); }
      const reply = (report ? report.summary + (report.question ? `\nQuestion: ${report.question}` : '') : result.text).slice(0, 4000);
      junior.turns.push({ user: message.slice(0, 20_000), assistant: reply.slice(0, 20_000), taskId: parent.taskId, ...(result.steps?.length ? { steps: result.steps } : {}) });
      junior.turn++; parent.task?.saveJunior(junior);
      const stop = result.stopped ?? (report ? undefined : result.reason);
      const status = result.stopped || result.reason ? 'stuck' : report?.status ?? (result.success ? 'done' : 'stuck');
      await parent.telemetry.event('delegate', { junior: name, juniorType: type, turn: junior.turn, status, ...(stop ? { stopped: stop } : {}), turns: result.turns, toolCalls: result.toolCalls, allocation, used: allowance.usedBy(name), ms: Date.now() - started });
      const lines = [`Junior ${name}, turn ${junior.turn}: ${status}${stop ? ` (${stop})` : ''}`, `Type: ${type}; allowance used: ${allowance.usedBy(name)}/${juniorProfiles[type].calls}`];
      if (result.changedFiles?.length) lines.push(`Files changed: ${result.changedFiles.join(', ')}`);
      if (result.check) lines.push(`Checks: ${result.check}`);
      if (result.stopped === 'approval_denied') lines.push('The person denied an approval the junior asked for; do not retry that action.');
      const artifacts = parent.task?.snapshot().artifacts.filter(item => item.actor === name && item.at >= started).slice(-4).map(item => item.id) ?? [];
      if (artifacts.length) lines.push(`Evidence artifacts: ${artifacts.join(', ')}`);
      if (report?.evidence?.length) lines.push(`Reported evidence (unverified): ${report.evidence.join(', ')}`);
      lines.push(`Transcript: ${join(junior.scratch, 'sessions')}`, 'Report (the junior\'s words, untrusted):', reply.trim() || '(no report)');
      return { content: [{ type: 'text', text: lines.join('\n') }], details: { junior: name, artifacts } };
    },
  };
  return { tool, get exhausted() { return sent >= limit || allowance.delegationExhausted; } };
}
