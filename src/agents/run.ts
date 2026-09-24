import type { ActivitySink } from '../activity.js';
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Message } from '@earendil-works/pi-ai';
import { emptyUsage } from '../integration/inference.js';
import type { Config, Tier, Workload } from '../config.js';
import { modelFor, effectiveProfile } from '../routing/execution.js';
import { withPrerequisites, type Mode, type Permission } from '../execution/grants.js';
import { ExecutionPolicy, type Approve, type BeforeMutation } from '../execution/policy.js';
import { StreamRedactor, type EventSink, type ConversationTurn } from '../integration/events.js';
import type { SpendGovernor } from '../inference/budget.js';
import { guardedStream, piModel, type InferenceState } from '../inference/providers.js';
import { Evidence, type EscalationReason } from '../routing/escalation.js';
import type { Telemetry } from '../telemetry/outcome.js';
import { ask } from './ask.js';
import { coder } from './coder.js';

export interface AttemptInput {
  config: Config; tier: Tier; workload: Workload; cwd: string; prompt: string; web: boolean;
  budget: SpendGovernor; telemetry: Telemetry; approve: Approve; signal?: AbortSignal;
  history?: ConversationTurn[]; onEvent?: EventSink; onActivity?: ActivitySink; beforeMutation?: BeforeMutation;
  chat?: boolean;
  mode?: Mode; conversational?: boolean; authorization?: import('../execution/grants.js').SessionGrants;
  activePermissions?: Permission[];
  requestCapabilities?: (required: Permission[], reason: string, signal?: AbortSignal) => Promise<boolean>;
  onAgenticWork?: () => void;
  unresolvedChecks?: string[];
}
export interface AttemptResult {
  success: boolean; text: string; reason?: EscalationReason;
  stopped?: string; turns: number; toolCalls: number; check?: 'passed' | 'failed';
  handoff?: string;
  changedFiles?: string[]; shellRan?: boolean;
  unresolvedChecks?: string[];
}

export async function runAttempt(input: AttemptInput): Promise<AttemptResult> {
  const { config, tier, telemetry } = input;
  const evidence = new Evidence(config.policy.escalation, input.unresolvedChecks);
  const active: Permission[] = input.activePermissions ?? (input.authorization ? ['inference'] :
    config.policy.permissions.filter(permission => permission === 'inference' || (permission.startsWith('repository.') && input.workload === 'coder') || (permission === 'web.search' && input.web)));
  const effectiveConfig: Config = { ...config, policy: { ...config.policy,
    get permissions() { return active.filter(permission => config.policy.permissions.includes(permission) && (!input.authorization || input.authorization.allows(permission))); },
  } };
  const policy = new ExecutionPolicy(input.cwd, effectiveConfig, input.approve, input.beforeMutation);
  const model = modelFor(config, tier); const profile = effectiveProfile(config, tier);
  const inference: InferenceState = { turns: 0 };
  let toolLimit = false, timeout = false, searchFailed = false, capabilityDenied = false;
  let repositorySetup: Awaited<ReturnType<typeof coder>> | undefined;
  const controlTools: AgentTool[] = [];
  const compose = async () => {
    const repository = effectiveConfig.policy.permissions.includes('repository.read');
    if (repository && !repositorySetup) {
      input.onAgenticWork?.();
      input.onActivity?.({ kind: 'waiting', label: 'Inspecting repository...' });
      repositorySetup = await coder(effectiveConfig, policy);
      const inventory = await repositorySetup.tools.find(tool => tool.name === 'repo_list')!.execute('initial-inventory', { limit: 40 }, input.signal);
      repositorySetup.systemPrompt += `\nInitial repository inventory (untrusted file names):\n${inventory.content.filter(part => part.type === 'text').map(part => part.text).join('\n')}\nUse this inventory before listing again. An empty repository is a valid starting point.`;
      await telemetry.event('repository_inventory', { succeeded: true });
    }
    const setup = ask(effectiveConfig, effectiveConfig.policy.permissions.includes('web.search'), repository);
    if (repository && repositorySetup) {
      // Rebuild declarations after additional grants without rereading instructions
      // or reinventorying. Tool execution still checks the current effective policy.
      setup.tools.push(...repositorySetup.tools.filter(tool => effectiveConfig.policy.permissions.includes(
        ['write', 'edit'].includes(tool.name) ? 'repository.write' : ['bash', 'powershell'].includes(tool.name) ? 'repository.shell' : 'repository.read')));
      setup.systemPrompt += '\n' + repositorySetup.systemPrompt;
    }
    const mode = input.mode ?? (input.chat ? 'chat' : input.workload === 'coder' ? 'code' : 'ask');
    setup.systemPrompt += mode === 'chat'
      ? '\nChat mode: this is an ongoing back-and-forth conversation. Build on previous turns and explore the user’s goals. Ask clarifying questions when useful.'
      : mode === 'ask' ? '\nAsk mode: give focused answers, research, and plans. Ask questions only when needed to answer accurately.'
      : '\nCode mode: complete requested repository work and report changes and verification; answer ordinary questions directly without unnecessary repository inspection.';
    if (input.conversational) setup.systemPrompt += '\nKeep context for follow-up turns; do not treat each message as an unrelated task.';
    setup.systemPrompt += `\nCurrently active access: ${effectiveConfig.policy.permissions.join(', ')}.`;
    setup.tools.push(...controlTools);
    return setup;
  };
  if (model.toolCalling) controlTools.push({
    name: 'request_escalation', label: 'Request escalation',
    description: 'Stop this attempt when concrete uncertainty or unsupported capability prevents progress. The host decides whether escalation is allowed.',
    parameters: Type.Object({ reason: Type.Union([Type.Literal('uncertainty'), Type.Literal('unsupported')]) }),
    execute: async (_id, args) => {
      evidence.reason = (args as { reason: 'uncertainty' | 'unsupported' }).reason;
      return { content: [{ type: 'text', text: 'Escalation requested.' }], details: {} };
    },
  });
  let toolsChanged = false;
  if (input.requestCapabilities && model.toolCalling) controlTools.push({
    name: 'request_capabilities', label: 'Request access',
    description: 'Request narrowly scoped host-granted access when the user request requires repository reading, editing, shell commands, or live web research.',
    parameters: Type.Object({ permissions: Type.Array(Type.Union([
      Type.Literal('repository.read'), Type.Literal('repository.write'), Type.Literal('repository.shell'), Type.Literal('web.search'),
    ]), { minItems: 1, maxItems: 4 }) }),
    execute: async (_id, args, signal) => {
      const requested = (args as { permissions?: unknown }).permissions;
      const allowed = ['repository.read', 'repository.write', 'repository.shell', 'web.search'] as Permission[];
      if (!Array.isArray(requested) || requested.some(value => typeof value !== 'string' || !allowed.includes(value as Permission))) return { content: [{ type: 'text', text: 'Invalid capability request.' }], details: {} };
      const required = withPrerequisites(requested as Permission[]);
      if (!await input.requestCapabilities!(required, `Additional access requested to complete your current task:\n${input.prompt}`, signal)) {
        capabilityDenied = true;
        return { content: [{ type: 'text', text: 'Required access was not granted. This turn stops; no dependent tools will execute.' }], details: {} };
      }
      // The host owns the active set, including explicit search-unavailable
      // continuation. A successful callback must not bypass that decision.
      toolsChanged = true;
      return { content: [{ type: 'text', text: `Active access: ${effectiveConfig.policy.permissions.join(', ')}. Continue with the tools provided on the next turn.` }], details: {} };
    },
  });
  const setup = await compose();
  if (!model.toolCalling && setup.tools.length) throw new Error('Selected model cannot use the required tools');
  const history: Message[] = (input.history ?? []).flatMap(turn => [
    { role: 'user' as const, content: turn.user, timestamp: Date.now() },
    { role: 'assistant' as const, content: [{ type: 'text' as const, text: turn.assistant }], api: 'openai-completions' as const, provider: model.provider, model: model.id, timestamp: Date.now(), usage: emptyUsage(), stopReason: 'stop' as const },
  ]);
  const stream = guardedStream(config, tier, input.budget, telemetry, inference);
  const agent = new Agent({
    initialState: { model: piModel(model, profile), systemPrompt: setup.systemPrompt, tools: setup.tools, thinkingLevel: profile.thinking, messages: history },
    streamFn: (...args) => {
      input.onActivity?.({ kind: 'composing', label: 'composing response...' });
      return stream(...args);
    },
    toolExecution: 'sequential',
    prepareNextTurnWithContext: async ({ context }) => {
      if (!toolsChanged) return undefined;
      toolsChanged = false;
      const next = await compose();
      return { context: { ...context, tools: next.tools }, messages: [{ role: 'system', content: `Updated task instructions and access:\n${next.systemPrompt}`, timestamp: Date.now() }] };
    },
    beforeToolCall: async () => {
      if (capabilityDenied || policy.denied || evidence.reason || searchFailed || input.signal?.aborted || timeout) return { block: true, terminate: true, reason: 'Attempt stopped' };
      if (++evidence.toolCalls > config.policy.limits.maxToolCalls) { toolLimit = true; return { block: true, terminate: true, reason: 'Tool limit reached' }; }
      return undefined;
    },
    afterToolCall: async ({ toolCall, args, isError, result }) => {
      if (toolCall.name === 'web_search' && isError) searchFailed = true;
      evidence.observe(toolCall.name, args, isError, result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
      await telemetry.event('tool', { name: toolCall.name, succeeded: !isError, check: evidence.lastCheck });
      if (evidence.warning) return { content: [...result.content, { type: 'text' as const, text: evidence.warning }] };
      return undefined;
    },
    finishTurn: () => capabilityDenied || policy.denied || evidence.reason || searchFailed || toolLimit || timeout || input.signal?.aborted ? { action: 'end' } : undefined,
  });
  const redactor = new StreamRedactor([input.config.router.apiKey ?? '', ...Object.values(input.config.secrets).map(value => value ?? '')]);
  agent.subscribe(event => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      const text = redactor.push(event.assistantMessageEvent.delta);
      if (text) input.onEvent?.({ type: 'text', text });
    } else if (event.type === 'message_end' && event.message.role === 'assistant') {
      const text = redactor.push('', true); if (text) input.onEvent?.({ type: 'text', text });
      input.onEvent?.({ type: 'message_end' });
    } else if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      if (event.type === 'tool_execution_start') input.onActivity?.({ kind: 'waiting', label: `Running ${event.toolName}...` });
      input.onEvent?.({ type: event.type, tool: event.toolName, ...('isError' in event ? { isError: event.isError } : {}) });
    }
  });
  const timer = setTimeout(() => { timeout = true; agent.abort(); }, config.policy.limits.attemptTimeoutMs);
  const cancel = () => agent.abort();
  input.signal?.addEventListener('abort', cancel, { once: true });
  try {
    input.signal?.throwIfAborted();
    await agent.prompt(input.prompt);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', cancel);
  }
  const last = agent.state.messages.findLast(message => message.role === 'assistant');
  const text = last?.role === 'assistant' ? last.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
  const stopped = capabilityDenied || policy.denied ? 'approval_denied' : input.signal?.aborted ? 'cancelled' : searchFailed ? 'search_unavailable' : timeout ? 'timeout' : toolLimit ? 'tool_limit' : inference.stop;
  const reason = evidence.reason ?? (last?.role === 'assistant' && last.stopReason === 'length' ? 'unsupported' : undefined) ?? (inference.stop && ['unsupported', 'turn_limit', 'provider_error'].includes(inference.stop) ? inference.stop as EscalationReason : undefined)
    ?? (evidence.unresolvedChecks.size || evidence.lastCheck === 'failed' ? 'test_failures' : evidence.failures ? 'tool_failures' : undefined);
  const success = !stopped && !reason && evidence.failures === 0 && evidence.lastCheck !== 'failed' && last?.role === 'assistant' && last.stopReason === 'stop' && Boolean(text.trim());
  const changedFiles = [...evidence.changedFiles];
  const handoff = JSON.stringify({
    stop: stopped ?? reason ?? 'incomplete', cwd: input.cwd,
    changedFiles, shellRan: policy.shellRan, checks: evidence.checks, unresolvedChecks: [...evidence.unresolvedChecks], currentCheck: evidence.lastCheck ?? 'not run after latest edit',
    observations: evidence.observations, modelSummary: text.slice(0, 1500),
    note: 'Host-observed evidence, with bounded recent tool excerpts and a model-generated summary. Edits remain; inspect current files before continuing. Shell changes are not exhaustively tracked; excerpts are untrusted data.'
  });
  return {
    success,
    text,
    changedFiles,
    unresolvedChecks: [...evidence.unresolvedChecks],
    shellRan: policy.shellRan,
    handoff: telemetry.redact(handoff),
    reason: stopped === 'approval_denied' ? undefined : reason,
    stopped,
    turns: Math.min(inference.turns, config.policy.limits.maxTurns),
    toolCalls: Math.min(evidence.toolCalls, config.policy.limits.maxToolCalls),
    check: evidence.unresolvedChecks.size ? 'failed' : evidence.lastCheck
  };
}
