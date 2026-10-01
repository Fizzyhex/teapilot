export * from './types/shared.d.mts';
import type { ChallengeCase, FoundControl, NamedVerdict, RunOptions, RunResult, WorldSnapshot } from './types/shared.d.mts';

export declare function loadCases(options?: { fixtures?: boolean; directory?: string; fixtureDirectory?: string }): Record<string, ChallengeCase>;
export declare function findControl(snapshot: WorldSnapshot, wanted: string, messageHint?: string): FoundControl | undefined;
export declare function scoreOut(evidence: string, value?: ChallengeCase): Promise<NamedVerdict[]>;
export declare function runCase(value: ChallengeCase, options: RunOptions): Promise<RunResult>;
export declare const caseDir: string;
export declare function waitTurn(name: string, timeout?: number): Promise<{ event: 'turn_end'; status: 'completed'; requestId: string }>;
