import { spawn } from 'node:child_process';
import { join } from 'node:path';

/** A Windows system tool by full path, so a Unix tool of the same name on PATH (Git Bash's whoami) is never run instead. */
export const windowsTool = (name: 'whoami' | 'icacls') => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', `${name}.exe`);

/** Run a program without a shell and return its trimmed standard output. */
export function command(executable: string, args: string[], signal: AbortSignal, inherit = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, signal, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout?.on('data', part => { text = (text + String(part)).slice(-16000); });
    child.stderr?.on('data', () => {});
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(text.trim()) : reject(new Error(`${executable} failed (${code ?? 'cancelled'}).`)));
  });
}
export type Command = typeof command;
