import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { parse } from 'dotenv';
import { loadConfig, userConfigDir, type Config } from '../config.js';
import { runHost } from '../host.js';
import { doctor } from '../diagnostics.js';
import { setup } from '../setup/index.js';
import { SpendGovernor } from '../inference/budget.js';
import { ExecutionPolicy, PolicyDenied } from '../execution/policy.js';
import { Telemetry } from '../telemetry/outcome.js';
import { contextSchema, historySchema, type HostEvent } from './events.js';
import { inferenceSchema, modelInformation, runInference } from './inference.js';
import { Review, cleanReviews, readReview, readReviewText } from './review.js';

export const PROTOCOL_VERSION = 1;
const id = z.string().min(1).max(100);
const envelope = z.object({ version: z.literal(PROTOCOL_VERSION), id, method: z.string(), params: z.unknown().optional() }).strict();
const runSchema = z.object({ prompt: z.string().min(1).max(20_000), cwd: z.string().min(1), workload: z.enum(['ask', 'coder']), web: z.boolean().optional(), context: contextSchema.optional(), history: historySchema.optional(), review: z.boolean().optional() }).strict();
const initSchema = z.object({ configDir: z.string().optional(), secrets: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string()).default({}), managed: z.boolean().default(false) }).strict();
const reviewSchema = z.object({ id: z.string(), index: z.number().int().nonnegative().optional(), side: z.enum(['before', 'after']).optional() }).strict();

/** Local, private pipe protocol. No sockets and no implicit repository config. */
export async function serve(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  let initialized = false;
  let directory = userConfigDir();
  let secretEnv: Record<string, string> = {};
  let managed = false;
  let active: { id: string; controller: AbortController; done: Promise<void> } | undefined;
  const interactions = new Map<string, { owner: string; resolve: (value: unknown) => void }>();
  let redact = (text: string) => text;
  const send = (value: unknown, sensitive = false) => output.write((sensitive ? JSON.stringify(value) : redact(JSON.stringify(value))) + '\n');
  const event = (owner: string, event: HostEvent) => send({ version: PROTOCOL_VERSION, id: owner, event });
  const ask = (owner: string, signal: AbortSignal, kind: string, data: Record<string, unknown>, sensitive = false): Promise<unknown> => {
    signal.throwIfAborted();
    const interactionId = randomUUID();
    return new Promise(resolvePromise => {
      const finish = (value: unknown) => { interactions.delete(interactionId); signal.removeEventListener('abort', abort); resolvePromise(value); };
      const abort = () => finish(false);
      interactions.set(interactionId, { owner, resolve: finish });
      signal.addEventListener('abort', abort, { once: true });
      send({ version: PROTOCOL_VERSION, id: owner, event: { type: 'interaction', interactionId, kind, ...data } }, sensitive);
    });
  };
  const execute = async (owner: string, method: string, params: unknown, signal: AbortSignal): Promise<unknown> => {
    if (method === 'initialize') {
      const init = initSchema.parse(params);
      directory = resolve(init.configDir ?? userConfigDir()); secretEnv = init.secrets; managed = init.managed; initialized = true;
      redact = text => Object.values(secretEnv).filter(Boolean).sort((a, b) => b.length - a.length).reduce((s, key) => s.split(key).join('[REDACTED]'), text);
      return { protocolVersion: PROTOCOL_VERSION, configDir: directory };
    }
    if (!initialized) throw new Error('Initialize protocol before use');
    const onEvent = (value: HostEvent) => event(owner, value);
    const log = (text: string) => onEvent({ type: 'progress', text });
    const approve = async (approval: { kind: string; summary: string; details?: string; signal?: AbortSignal }) => {
      const result = await ask(owner, approval.signal ? AbortSignal.any([signal, approval.signal]) : signal, 'approval', { summary: approval.summary, details: approval.details, approvalKind: approval.kind });
      return result === true && !signal.aborted && !approval.signal?.aborted;
    };
    if (method === 'setup') {
      if (!managed) throw new Error('Imported profiles are read-only. Create a managed profile to reconfigure.');
      z.object({}).strict().parse(params ?? {});
      return setup({ directory }, {
        log,
        input: async (message, fallback, secret, extraSignal) => {
          const value = await ask(owner, extraSignal ? AbortSignal.any([signal, extraSignal]) : signal, 'input', { message, fallback: secret ? undefined : fallback, secret });
          if (typeof value !== 'string') throw new Error('Setup cancelled');
          return value || fallback || '';
        },
        choose: async (message, choices) => {
          const value = await ask(owner, signal, 'choose', { message, choices });
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= choices.length) throw new Error('Setup cancelled');
          return value;
        },
        confirm: (message, extraSignal) => approve({ kind: 'setup', summary: message, signal: extraSignal }),
      }, signal, {
        load: async () => secretEnv,
        save: async credentials => {
          if (await ask(owner, signal, 'credentials_save', { credentials }, true) !== true) throw new Error('Could not save credentials');
          secretEnv = credentials;
        },
      });
    }
    const config = await loadConfig(directory, { ...process.env, ...secretEnv });
    const telemetry = new Telemetry(config.stateDir, owner, [config.router.apiKey ?? '', ...Object.values(config.secrets).map(s => s ?? '')]);
    redact = text => telemetry.redact(text);
    if (method === 'models') return modelInformation(config);
    if (method === 'configuration') {
      const env = parse(await readFile(join(directory, '.env'), 'utf8').catch(() => ''));
      return { directory, stateDir: config.stateDir, modelsFile: resolve(directory, env.TEAPILOT_MODELS_FILE ?? 'models.json'), policyFile: resolve(directory, env.TEAPILOT_POLICY_FILE ?? 'policy.json'), maxPromptChars: config.policy.limits.maxPromptChars, budget: config.policy.budget, models: Object.fromEntries(Object.entries(config.models).map(([tier, model]) => [tier, { id: model.id, apiKeyEnv: model.apiKeyEnv }])) };
    }
    if (method === 'spending') {
      const governor = new SpendGovernor(join(config.stateDir, 'spend.jsonl'), owner, config.policy.budget); await governor.load();
      return { ...governor.spent(), limits: config.policy.budget };
    }
    if (method === 'doctor') {
      const options = z.object({ live: z.boolean().default(false) }).strict().parse(params ?? {});
      return doctor(config, directory, { ...options, signal, consent: message => approve({ kind: 'diagnostics', summary: message }), log });
    }
    if (method === 'inference') return runInference(config, inferenceSchema.parse(params), { approve, onEvent }, signal);
    if (method === 'review') {
      const options = reviewSchema.parse(params);
      return options.index !== undefined && options.side ? readReviewText(config.stateDir, options.id, options.index, options.side) : readReview(config.stateDir, options.id);
    }
    if (method === 'clearReviews') { await cleanReviews(config.stateDir, true); return true; }
    if (method === 'validatePath') {
      const options = z.object({ cwd: z.string(), path: z.string() }).strict().parse(params);
      return new ExecutionPolicy(options.cwd, config, approve).path(options.path, false);
    }
    if (method === 'run') {
      const request = runSchema.parse(params);
      await cleanReviews(config.stateDir);
      const review = request.workload === 'coder' && request.review ? new Review(request.cwd, config) : undefined;
      await review?.start();
      try {
        const result = await runHost(config, { ...request, signal }, { approve, onEvent, onProgress: log, beforeMutation: async (action, actionSignal) => {
          const combined = actionSignal ? AbortSignal.any([signal, actionSignal]) : signal;
          if (await ask(owner, combined, 'checkpoint', { ...action, cwd: request.cwd }) !== true) throw new PolicyDenied('Editor has unsaved changes or the run was cancelled');
          if (action.path) await review?.capture(action.path);
        } });
        return result;
      } finally {
        if (review) {
          try { onEvent({ type: 'review', review: await review.finish() }); }
          catch { onEvent({ type: 'progress', text: 'Change review could not be saved. Existing edits remain on disk.' }); }
        }
      }
    }
    throw new Error('Unknown protocol method');
  };
  const dispatch = (line: string) => {
    let request: z.infer<typeof envelope>;
    try { request = envelope.parse(JSON.parse(line)); }
    catch { send({ version: PROTOCOL_VERSION, id: null, error: 'Invalid protocol envelope or version' }); return; }
    const { id: owner, method, params } = request;
    if (method === 'cancel') { if (active?.id === owner) active.controller.abort(); return; }
    if (method === 'respond') {
      const reply = z.object({ interactionId: id, value: z.unknown() }).strict().safeParse(params);
      if (reply.success) { const pending = interactions.get(reply.data.interactionId); if (pending?.owner === owner) pending.resolve(reply.data.value); }
      return;
    }
    if (active) { send({ version: PROTOCOL_VERSION, id: owner, error: 'TeaPilot is busy; enqueue requests in the client.' }); return; }
    const controller = new AbortController();
    const done = Promise.resolve().then(async () => {
      try { const result = await execute(owner, method, params, controller.signal); send({ version: PROTOCOL_VERSION, id: owner, result }); }
      catch (error) { send({ version: PROTOCOL_VERSION, id: owner, error: controller.signal.aborted ? 'Cancelled' : error instanceof z.ZodError ? 'Invalid method parameters' : error instanceof Error ? error.message : 'Request failed' }); }
      finally { for (const pending of interactions.values()) if (pending.owner === owner) pending.resolve(false); active = undefined; }
    });
    active = { id: owner, controller, done };
  };
  const abort = () => active?.controller.abort();
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  let pending = '';
  const decoder = new StringDecoder('utf8');
  try {
    for await (const chunk of input) {
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        if (end > 8 * 1024 * 1024) throw new Error('Protocol frame exceeds 8 MiB');
        const line = pending.slice(0, end); pending = pending.slice(end + 1); if (line.trim()) dispatch(line);
      }
      if (pending.length > 8 * 1024 * 1024) throw new Error('Protocol frame exceeds 8 MiB');
    }
  } finally { abort(); await active?.done; process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
