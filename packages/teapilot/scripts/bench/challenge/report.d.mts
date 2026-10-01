export * from './types/shared.d.mts';
import type { Batch, ChallengeCase, CheckOptions, Score } from './types/shared.d.mts';

export declare function captures(dir: string, found?: string[]): string[];
export declare function score(dir: string, config?: { options?: Record<string, CheckOptions>; value?: ChallengeCase }): Score;
export declare function batch(dir: string, config?: { label?: string }): Batch;
export declare function compare(beforeDir: string, afterDir: string): {
  before: Batch;
  after: Batch;
  checks: Array<{ name: string; before: string; after: string }>;
  caveats: string[];
  comparable: boolean;
  verdict: string;
};
export declare function cheatCheck(beforeDir: string, afterDir: string): { patchChanged: boolean; needles: number; hits: string[]; clean: boolean; note: string };