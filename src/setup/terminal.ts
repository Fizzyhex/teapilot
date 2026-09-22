import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export interface SetupUI {
  input(message: string, fallback?: string, secret?: boolean): Promise<string>;
  choose(message: string, choices: string[]): Promise<number>;
  confirm(message: string): Promise<boolean>;
  log(message: string): void;
}

export function terminalUI(signal: AbortSignal): SetupUI & { close(): void } {
  let hidden = false;
  const output = new Writable({ write(chunk, _encoding, callback) {
    if (!hidden) process.stderr.write(chunk);
    callback();
  } });
  const terminal = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  const ui = {
    log: (message: string) => { process.stderr.write(`${message}\n`); },
    async input(message: string, fallback?: string, secret = false): Promise<string> {
      signal.throwIfAborted();
      const label = `${message}${fallback !== undefined && !secret ? ` [${fallback}]` : ''}: `;
      if (secret) { process.stderr.write(label); hidden = true; }
      try { return (await terminal.question(secret ? '' : label, { signal })).trim() || fallback || ''; }
      finally { hidden = false; if (secret) process.stderr.write('\n'); }
    },
    async choose(message: string, choices: string[]): Promise<number> {
      ui.log(message);
      choices.forEach((choice, index) => ui.log(`  ${index + 1}. ${choice}`));
      for (;;) {
        const value = Number(await ui.input('Choose a number', '1'));
        if (Number.isInteger(value) && value >= 1 && value <= choices.length) return value - 1;
        ui.log(`Enter a number from 1 to ${choices.length}.`);
      }
    },
    confirm: async (message: string) => (await ui.input(`${message} Type yes to confirm`, 'no')).toLowerCase() === 'yes',
    close: () => terminal.close(),
  };
  terminal.on('SIGINT', () => process.emit('SIGINT'));
  return ui;
}
