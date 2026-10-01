export * from './types/shared.d.mts';
import type { Manifest } from './types/shared.d.mts';

export interface CaptureOptions {
  caseId?: string;
  label?: string;
  seed?: string;
  fixture?: string;
  startedAt?: string;
  interactions?: unknown[];
  notes?: string;
}

export declare function capture(name: string, out: string, options?: CaptureOptions): Manifest;
export declare function call(name: string, args: string[], config?: { allowFailure?: boolean }): { ok: boolean; text: string; code?: number; stderr?: string };
export declare function sessionDir(name: string): string;
export declare function meta(name: string): { name: string; pid: number; root: string; mode: string; startedAt: string };
export declare function workspaces(name: string): Array<{ id: string; path: string }>;
export declare function gitEvidence(workspace: string, out: string): Record<string, unknown>;
export declare function scratchEvidence(name: string): { files: Array<{ path: string; bytes: number }>; events: unknown[] };
export declare function telemetry(name: string): { path: string | null; all: unknown[]; sinceStarted: unknown[] };
export declare const packageRoot: string;
export declare const repoRoot: string;