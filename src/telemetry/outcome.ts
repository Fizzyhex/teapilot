import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RouteResult } from 'jevrouter';

export class Telemetry {
  constructor(readonly directory: string, readonly requestId: string, private readonly secrets: string[] = []) {}
  redact(value: string): string {
    for (const secret of this.secrets.filter(Boolean).sort((a, b) => b.length - a.length)) value = value.split(secret).join('[REDACTED]');
    return value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]');
  }
  async event(type: string, fields: Record<string, unknown>): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await appendFile(join(this.directory, 'outcomes.jsonl'), this.redact(JSON.stringify({ at: new Date().toISOString(), requestId: this.requestId, type, ...fields })) + '\n', { mode: 0o600 });
  }
  async receipt(result: RouteResult): Promise<string> {
    // The SDK returns the receipt but only its CLI saves it. Persist that exact
    // format instead of designing another routing log. The SDK store is private.
    const directory = join(this.directory, '.jevrouter', 'decisions');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${result.decision_id}.json`);
    await writeFile(path, this.redact(JSON.stringify(result, null, 2)) + '\n', { flag: 'wx', mode: 0o600 });
    return path;
  }
}
