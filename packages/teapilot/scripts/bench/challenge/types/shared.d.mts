// Shared types for the challenge tooling. The tooling itself is plain JavaScript so it runs with no build
// step, so each module has a sibling `.d.mts` that re-exports from here; the checks' contract is the part
// tests and case files lean on, so it is written down rather than inferred as `any`.
import type { WorldSnapshot } from '../../../discord-sim/world.js';

/** A check's verdict. `pass: null` means unscored: the evidence was not there, which is not a pass. */
export interface Verdict {
  pass: boolean | null;
  detail: string;
  /** `info` marks a measurement rather than a judgement, such as a count or a duration. */
  severity: 'failure' | 'info' | 'unscored';
}

type NoOptions = Record<string, never>;

/** Author-facing options, correlated with the check that consumes them. */
export interface CheckOptionsMap {
  noRejections: NoOptions;
  controlsAreValid: NoOptions;
  noShortcodeInControls: NoOptions;
  appExists: { title?: string; shows?: string; source?: string; min?: number };
  appSourceContains: { pattern: string; flags?: string };
  appUsesConsult: { notPattern?: string };
  timersRespectRateLimit: NoOptions;
  sendsFileNotText: { extension?: string; maxTextChars?: number };
  casualPerTurn: { expect?: number; max?: number; min?: number };
  routingPerTurn: NoOptions;
  historyLacksOldTurns: { after?: string; mustNotInclude?: string[]; maxUserMessages?: number };
  recoveryCameFromGit: { tools?: string[]; commands?: RegExp };
  retrievalDemonstrated: { contains?: string[] };
  answerMatches: { contains?: string[]; notContains?: string[]; sinceCall?: string };
  retrievalBudget: { maxChars?: number; fullLogChars?: number };
  noOversizedBlobReachable: { maxBytes?: number; ignore?: string[] };
  disposableMaterialIgnored: { patterns?: string[] };
  commitsProportional: { max?: number; excludeInitial?: boolean };
  trackedUsefulArtifacts: { patterns?: string[] };
  appSurvivesRestart: { before?: string[] };
  turnTimings: NoOptions;
  toolCalls: NoOptions;
  fixtureInvocations: { max?: number };
}

/** Runtime-only dependency: case authors do not supply payload validators. */
export interface RuntimeCheckOptionsMap extends Omit<CheckOptionsMap, 'controlsAreValid'> {
  controlsAreValid: { validate?: { checkMessage(payload: unknown): void } };
}
export type CheckOptions = RuntimeCheckOptionsMap[CheckName];
export type Check<K extends CheckName = CheckName> = (evidence: string, options?: RuntimeCheckOptionsMap[K]) => Verdict;
export type CheckConfiguration = Partial<RuntimeCheckOptionsMap>;
export type NamedVerdict = Verdict & { name: CheckName };

/** Every check's name, so a case naming one that does not exist is a type error rather than a silent unscore. */
export type CheckName = keyof CheckOptionsMap;

/** What one capture records about itself. */
export interface Manifest {
  case: string | null;
  label: string | null;
  session: string;
  startedAt: string;
  capturedAt: string;
  revision: string;
  patchSha256: string;
  configDir: string | null;
  seed: string | null;
  fixture: string | null;
  notes: string | null;
  apps: Array<{ id: string; title: string; status: string; file?: string; source: string; timers: number; consults: number; actions: number }>;
  git: Array<{ id: string; commits: number; blobs: number; largest: number }>;
  workspaces: string[];
  transcript: string | null;
  trace: number;
  events: number;
  requests: number;
  scratchFiles: number;
  scratchBytes: number;
  warnings: number;
  models: string[];
}

/** One blob any reachable commit holds, across every indexed workspace. */
export interface Blob { path: string; blob: string; commit: string; bytes: number; workspace: string }

export interface Control {
  id: string; type: number; label?: string; emoji?: { id?: string; name?: string }; url?: string;
  style?: number; disabled: boolean; customId?: string;
}

export interface FoundControl { message: string; control: Control; guessed?: boolean }

export type CaseActor = 'op' | 'user' | 'stranger';
export type CaseDuration = `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`;

interface StepAnnotations {
  note?: string;
  /** Snapshot the apps and trace files as they stand, for a later stage to compare against. */
  record?: boolean;
}

interface StepActions {
  /** Say waits for turn completion by default; slash waits only when explicitly requested. */
  say: { say: string; as?: CaseActor; in?: string; attach?: string[]; wait?: boolean };
  slash: { slash: string; as?: CaseActor; in?: string; choose?: number; oneShot?: boolean; wait?: boolean };
  /** Click only waits for a model turn when wait is true. */
  click: { click: string; as?: CaseActor; message?: string; wait?: boolean };
  select: { select: { control: string; values: [string, ...string[]] }; as?: CaseActor; message?: string };
  submit: { submit: Record<string, string>; as?: CaseActor };
  approve: { approve: boolean; as?: CaseActor };
  advance: { advance: CaseDuration };
  restart: { restart: true };
  /** Milliseconds, unlike advance's duration string. */
  sleep: { sleep: number };
  inspect: { inspect: true };
}
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type StepFields = KeysOfUnion<StepActions[keyof StepActions]>;
/** Exactly one action, with only the fields that action understands. */
export type CaseStep = {
  [K in keyof StepActions]: StepAnnotations & StepActions[K] &
    { [F in Exclude<StepFields, keyof StepActions[K]>]?: never }
}[keyof StepActions];

/** Options cannot drift onto another check; checks with required options must provide them. */
export type Expectation = {
  [K in CheckName]: { check: K } & ({} extends CheckOptionsMap[K]
    ? { options?: CheckOptionsMap[K] }
    : { options: CheckOptionsMap[K] })
}[CheckName];
export type Expectations = Array<{
  [K in CheckName]: {} extends CheckOptionsMap[K] ? K : never
}[CheckName] | Expectation>;

export interface ChallengeCase {
  id: string;
  title?: string;
  summary?: string;
  tags?: string[];
  prose?: string;
  steps: CaseStep[];
  expect?: Expectations;
  /** What stays for an agent to read; the tooling does not score these. */
  judged?: string[];
  notes?: string;
  fixtureName?: string;
  fixtureDescription?: string;
  scratchpad?: 'on' | 'off';
  compactHistory?: boolean;
  historyTokens?: number;
  forceRetry?: string;
  capture?: boolean;
}

export interface RunOptions {
  name: string;
  out: string;
  configDir?: string;
  label?: string;
  seed?: string;
  fixture?: string;
  root?: string;
  trace?: boolean;
  dryRun?: boolean;
  keepGoing?: boolean;
  only?: number[];
  timeout?: number;
  stepTimeout?: number;
}

export interface RunResult {
  outcome: 'complete' | 'blocked';
  manifest: Manifest | null;
  checks: NamedVerdict[];
  judged: string[];
  steps: number;
  failed: string[];
  unscored: string[];
  blocked: string | null;
}

export interface Score {
  dir: string;
  case: string | null;
  label: string | null;
  revision?: string;
  patchSha256?: string;
  models: string[];
  apps: number;
  warnings: number;
  requests: number;
  checks: NamedVerdict[];
  failed: string[];
  passed: number;
  unscored: string[];
  judged: string[];
  outcome: string;
}

export interface Batch {
  label: string | null;
  dir: string;
  runs: number;
  revision: string[];
  frozen: boolean;
  patchSha256: string[];
  frozenPatch: boolean;
  cases: Array<string | null>;
  entries: Score[];
  failures: string[];
  unscored: string[];
  models: string[];
}

export type { WorldSnapshot };
