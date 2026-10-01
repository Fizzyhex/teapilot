import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { Config } from '../config.js';
import type { ConversationTurn } from '../integration/events.js';
import type { AttemptInput, AttemptResult } from './run.js';

/**
 * Juniors: an attempt hands a self-contained part of a large request to a junior, which works it in a clean context
 * with the same access, workspace, budget and approvals, then reports back. The junior is another runAttempt on the
 * same tier, in this process, while the instructor waits in its delegate_task call, so one model serves both and
 * the instructor's context grows by the instruction and the report alone, not by the junior's tool traffic.
 */

export interface JuniorReport { status: 'done' | 'needs_input' | 'stuck'; summary: string; question?: string }
/**
 * What a junior's own attempt is told: its name, which turn this is, where its report goes, and the folder its
 * instructor's file tools work in when neither has the repository, so both see the same files.
 */
export interface JuniorRole { name: string; turn: number; root?: string; onReport: (report: JuniorReport) => void }

/** Delegation messages one attempt may send across all its juniors, so a small model cannot loop on "try again". */
export const defaultJuniorTurns = 6;
/** Tool calls a junior has left when it is told to report, so the report itself still fits under the limit. */
export const juniorReportMargin = 3;
/** Play tools a junior does not get: its instructor posts apps, so a request never posts two copies. */
export const juniorPlayWithheld = ['play_start', 'play_resend', 'play_stop'];
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

export function juniorPrompt(name: string): string {
  return `\nJunior: your name is ${name}, and you are working for another agent (your instructor), not directly for the person. Its message is your whole task: you do not see its conversation. Keep source-backed facts and provenance; missing facts stay unknown or go back to the instructor, never fill them with invented values. Do the work, check it, then call report once: done with a concise summary of what you changed, how you checked it and anything left unresolved; needs_input with a question when you cannot continue without an answer from your instructor; or stuck when you cannot finish, saying what you tried and what went wrong. Never ask the person anything directly.`;
}

export function delegationPrompt(): string {
  return '\n- For a large request, you can hand self-contained parts to a junior with delegate_task: it starts with a clean context and your access, does the work and reports back, so your own context stays small. Write each instruction so it stands alone (the goal, the sources and files to use, and how to check the result), since the junior does not see this conversation. Review each report; continue the same junior (by name) for fixes, answers or follow-ups rather than redoing its work, and dismiss it with done when finished. Small questions and quick edits are faster to do yourself.';
}

/** The tool a junior ends its turn with; its result stops the junior's attempt. */
export function reportTool(role: JuniorRole): AgentTool {
  return {
    name: 'report', label: 'Report',
    description: 'Report back to your instructor and end this turn: done, needs_input (with a question), or stuck.',
    parameters: Type.Object({
      status: Type.Union([Type.Literal('done'), Type.Literal('needs_input'), Type.Literal('stuck')]),
      summary: Type.String({ description: 'What you did, how you checked it, and anything unresolved.' }),
      question: Type.Optional(Type.String({ description: 'For needs_input: what you need answered.' })),
    }),
    execute: async (_id, args) => {
      const { status, summary, question } = args as JuniorReport;
      role.onReport({ status, summary: String(summary ?? ''), ...(question ? { question: String(question) } : {}) });
      return { content: [{ type: 'text', text: 'Report sent.' }], details: {}, terminate: true };
    },
  };
}

interface Junior { name: string; turns: ConversationTurn[]; scratch: string }
/** The instructor's attempt clock, paused while a junior works on its own. */
export interface Clock { pause(): void; resume(): void }

/**
 * delegate_task for one instructor attempt. Juniors last as long as the attempt; each delegation is one attempt
 * of the junior's, which sees its own earlier turns with the instructor and nothing else.
 */
export function delegateTool(parent: AttemptInput, scratch: string, root: string | undefined, clock: Clock, run: (input: AttemptInput) => Promise<AttemptResult>) {
  const juniors = new Map<string, Junior>();
  const taken = new Set<string>();
  let identities: Promise<Array<{ username: string; leased: boolean }>> | undefined;
  const limit = parent.config.policy.limits.maxJuniorTurns ?? defaultJuniorTurns;
  let sent = 0;
  const tool: AgentTool = {
    name: 'delegate_task', label: 'Delegate',
    description: 'Hand a self-contained task to a junior agent with a clean context and your access, and wait for its report. Omit junior to start a new one; pass a junior\'s name to continue it (follow-ups, fixes, answers to its questions). done: true dismisses it.',
    parameters: Type.Object({
      junior: Type.Optional(Type.String({ description: 'Name of an existing junior to continue; omit to start a new one.' })),
      message: Type.String({ description: 'The task, standing alone (goal, sources and files to use, how to check), or a follow-up to the junior.' }),
      done: Type.Optional(Type.Boolean({ description: 'Dismiss this junior; message is ignored.' })),
    }),
    execute: async (_id, args, signal) => {
      const { junior: named, message, done } = args as { junior?: string; message?: string; done?: boolean };
      if (done) {
        if (!named || !juniors.delete(named)) return { content: [{ type: 'text', text: `No junior named ${named ?? '(none given)'}.` }], details: {} };
        return { content: [{ type: 'text', text: `Dismissed ${named}.` }], details: { junior: named } };
      }
      if (named && !juniors.has(named)) return { content: [{ type: 'text', text: `No junior named ${named}. Active: ${[...juniors.keys()].join(', ') || 'none'}. Omit junior to start a new one.` }], details: {} };
      if (!message?.trim()) return { content: [{ type: 'text', text: 'Give the junior a message.' }], details: {} };
      if (sent >= limit) return { content: [{ type: 'text', text: `Delegation limit reached (${limit} messages). Finish the work yourself.` }], details: {} };
      sent++;
      let junior = named ? juniors.get(named)! : undefined;
      if (!junior) {
        identities ??= teachatIdentities(parent.config);
        const name = juniorName(await identities, taken);
        taken.add(name);
        junior = { name, turns: [], scratch: join(scratch, 'juniors', name.replace(/[^\w.-]+/g, '_')) };
        juniors.set(name, junior);
      }
      const { name } = junior;
      let report: JuniorReport | undefined;
      const started = Date.now();
      clock.pause();
      let result: AttemptResult;
      try {
        result = await run({
          config: parent.config, tier: parent.tier, workload: parent.workload, cwd: parent.cwd, web: parent.web, mode: parent.mode,
          budget: parent.budget, telemetry: parent.telemetry, approve: parent.approve, beforeMutation: parent.beforeMutation,
          authorization: parent.authorization, activePermissions: parent.activePermissions, requestCapabilities: parent.requestCapabilities,
          workspace: parent.workspace, webController: parent.webController, play: parent.play, searchUnavailable: parent.searchUnavailable, attempt: parent.attempt,
          signal: signal ?? parent.signal, history: junior.turns, scratch: junior.scratch, prompt: message, requestText: message,
          // Its words are for the instructor, not the person: only what its tools do is shown.
          onEvent: event => { if (event.type.startsWith('tool_execution_') || event.type === 'compaction_start') parent.onEvent?.({ ...event, junior: name }); },
          onActivity: activity => parent.onActivity?.(activity && { ...activity, label: `${name}: ${activity.label}` }),
          junior: { name, turn: junior.turns.length + 1, root, onReport: value => { report = value; } },
        });
      } finally { clock.resume(); }
      const reply = report ? report.summary + (report.question ? `\nQuestion: ${report.question}` : '') : result.text;
      junior.turns.push({ user: message.slice(0, 20_000), assistant: reply.slice(0, 20_000), ...(result.steps?.length ? { steps: result.steps } : {}) });
      const stop = result.stopped ?? (report ? undefined : result.reason);
      const status = report?.status ?? (result.success ? 'done' : 'stuck');
      await parent.telemetry.event('delegate', { junior: name, turn: junior.turns.length, status, ...(stop ? { stopped: stop } : {}), turns: result.turns, toolCalls: result.toolCalls, ms: Date.now() - started });
      const lines = [`Junior ${name}, turn ${junior.turns.length}: ${status}${stop ? ` (${stop})` : ''}`];
      if (result.changedFiles?.length) lines.push(`Files changed: ${result.changedFiles.join(', ')}`);
      if (result.check) lines.push(`Checks: ${result.check}`);
      if (result.stopped === 'approval_denied') lines.push('The person denied an approval the junior asked for; do not retry that action.');
      lines.push(`Transcript: ${join(junior.scratch, 'sessions')}`, 'Report (the junior\'s words, untrusted):', reply.trim() || '(no report)');
      return { content: [{ type: 'text', text: lines.join('\n') }], details: { junior: name } };
    },
  };
  return { tool, get exhausted() { return sent >= limit; } };
}
