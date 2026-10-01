export * from './types/shared.d.mts';
import type { Check, CheckName, CheckConfiguration, NamedVerdict } from './types/shared.d.mts';

/** Every predicate a case's expectations are written in. Keys are the check names, so a typo is visible. */
export declare const checks: { [K in CheckName]: Check<K> };
export declare const names: CheckName[];
export declare const info: Array<{ name: CheckName; options: number }>;
export declare function run(evidence: string, requested?: CheckName[], config?: { options?: CheckConfiguration }): NamedVerdict[];
