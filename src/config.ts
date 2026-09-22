import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { config as dotenv } from 'dotenv';
import { z } from 'zod';

const money = z.number().finite().nonnegative();
const endpoint = z.string().url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, 'Use an HTTP(S) endpoint without embedded credentials, query, or fragment');
const modelSchema = z.object({
  enabled: z.boolean(),
  id: z.string().min(1),
  provider: z.string().min(1),
  baseUrl: endpoint,
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  contextTokens: z.number().int().min(4096).max(2_000_000),
  maxOutputTokens: z.number().int().min(128).max(32768),
  inputUsdPerMillion: money,
  outputUsdPerMillion: money,
  vision: z.boolean().default(false),
  toolCalling: z.boolean().default(true),
  supportsDeveloperRole: z.boolean().default(false),
  supportsUsage: z.boolean().default(true),
}).strict().refine(m => m.maxOutputTokens + 2048 < m.contextTokens, 'Context must leave room for input');

export const tiers = ['local', 'economy', 'strong'] as const;
export type Tier = typeof tiers[number];
export type Workload = 'coder' | 'ask';
export type ModelConfig = z.infer<typeof modelSchema>;
export const modelsSchema = z.object({ local: modelSchema, economy: modelSchema, strong: modelSchema }).strict();

export const policySchema = z.object({
  router: z.object({
    min_confidence: z.number().min(0).max(1),
    allowed_risk_levels: z.array(z.enum(['low', 'medium', 'high', 'critical'])),
    confirmation_risk_levels: z.array(z.enum(['low', 'medium', 'high', 'critical'])),
    require_verified_candidates: z.boolean(),
  }).strict(),
  permissions: z.array(z.enum(['inference', 'repository.read', 'repository.write', 'repository.shell', 'web.search'])),
  disabledCapabilities: z.array(z.string()),
  budget: z.object({
    requestUsd: money, dailyUsd: money, approvalThresholdUsd: money,
    strongRequiresApproval: z.boolean(), automaticEconomy: z.boolean(),
  }).strict(),
  limits: z.object({
    maxTurns: z.number().int().min(1).max(100),
    maxToolCalls: z.number().int().min(1).max(300),
    attemptTimeoutMs: z.number().int().min(1000).max(3_600_000),
    requestTimeoutMs: z.number().int().min(1000).max(120_000),
    commandTimeoutSeconds: z.number().int().min(1).max(600),
    maxPromptChars: z.number().int().min(1).max(20_000),
  }).strict(),
  escalation: z.object({
    maxEscalations: z.number().int().min(0).max(2),
    consecutiveFailures: z.number().int().min(1).max(10),
    repeatedToolCalls: z.number().int().min(2).max(10),
  }).strict(),
  execution: z.object({
    trustedCommands: z.array(z.string().min(1)),
    largeOverwriteBytes: z.number().int().min(1),
  }).strict(),
}).strict();
export type Policy = z.infer<typeof policySchema>;
export interface Config {
  models: z.infer<typeof modelsSchema>;
  policy: Policy;
  stateDir: string;
  router: { provider: 'typesafe' | 'openrouter'; model?: string; apiKey?: string; endpoint?: string; maxCallUsd: number };
  searchUrl?: string;
  secrets: Record<Tier, string | undefined>;
}

async function readConfig(path: string): Promise<unknown> {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
}

export async function loadConfig(root = process.cwd(), env = process.env): Promise<Config> {
  dotenv({ path: resolve(root, '.env'), processEnv: env, quiet: true });
  const models = modelsSchema.parse(await readConfig(resolve(root, env.TEAPILOT_MODELS_FILE || 'config/models.example.json')));
  const policy = policySchema.parse(await readConfig(resolve(root, env.TEAPILOT_POLICY_FILE || 'config/policy.example.json')));
  for (const tier of tiers) {
    const prefix = tier.toUpperCase();
    const model = models[tier];
    if (env[`${prefix}_MODEL`]) model.id = env[`${prefix}_MODEL`]!;
    if (env[`${prefix}_BASE_URL`]) model.baseUrl = env[`${prefix}_BASE_URL`]!;
    if (env[`${prefix}_ENABLED`]) model.enabled = z.enum(['true', 'false']).parse(env[`${prefix}_ENABLED`]) === 'true';
    if (env[`${prefix}_INPUT_USD_PER_MILLION`]) model.inputUsdPerMillion = money.parse(Number(env[`${prefix}_INPUT_USD_PER_MILLION`]));
    if (env[`${prefix}_OUTPUT_USD_PER_MILLION`]) model.outputUsdPerMillion = money.parse(Number(env[`${prefix}_OUTPUT_USD_PER_MILLION`]));
    modelSchema.parse(model);
    if (tier !== 'local' && model.enabled && (!model.inputUsdPerMillion || !model.outputUsdPerMillion)) {
      throw new Error(`${tier}: enabled cloud models require positive conservative input/output rates`);
    }
    if (tier === 'local' && (model.inputUsdPerMillion || model.outputUsdPerMillion)) throw new Error('Local inference must have zero API cost');
  }
  if (env.REQUEST_BUDGET_USD) policy.budget.requestUsd = money.parse(Number(env.REQUEST_BUDGET_USD));
  if (env.DAILY_BUDGET_USD) policy.budget.dailyUsd = money.parse(Number(env.DAILY_BUDGET_USD));
  const provider = z.enum(['typesafe', 'openrouter']).parse(env.JEV_PROVIDER || 'typesafe');
  return {
    models, policy,
    stateDir: resolve(root, env.TEAPILOT_STATE_DIR || resolve(homedir(), '.teapilot')),
    router: {
      provider, model: env.JEV_MODEL || undefined,
      apiKey: provider === 'typesafe' ? env.TYPESAFE_API_KEY || env.JEV_API_KEY : env.OPENROUTER_API_KEY,
      endpoint: env.JEV_API_URL ? endpoint.parse(env.JEV_API_URL) : undefined,
      maxCallUsd: money.positive().parse(Number(env.JEV_MAX_CALL_USD || '0.01')),
    },
    searchUrl: env.SEARCH_BASE_URL ? endpoint.parse(env.SEARCH_BASE_URL) : undefined,
    secrets: Object.fromEntries(tiers.map(tier => [tier, env[models[tier].apiKeyEnv] || undefined])) as Config['secrets'],
  };
}
