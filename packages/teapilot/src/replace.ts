import { renameSync } from 'node:fs';

/** Codes Windows gives while something else (antivirus, indexing, sync) briefly holds the file being replaced. */
const busy = new Set(['EPERM', 'EACCES', 'EBUSY']);
const pause = new Int32Array(new SharedArrayBuffer(4));

/**
 * Replaces `file` with `temporary` in one step, as the stores save. On Windows a replaced file that another program
 * has open for a moment refuses the rename, so it is tried again for up to about a second, as graceful-fs does.
 */
export function replaceFileSync(temporary: string, file: string): void {
  for (let attempt = 0, waited = 0; ; attempt++) {
    try { renameSync(temporary, file); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !busy.has(code) || waited >= 1000) throw error;
      const delay = Math.min(10 * 2 ** attempt, 100);
      Atomics.wait(pause, 0, 0, delay);
      waited += delay;
    }
  }
}
