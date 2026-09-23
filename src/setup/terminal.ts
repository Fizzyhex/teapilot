import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { styleText } from 'node:util';
import { terminalColour } from '../presentation.js';

export interface SetupUI {
  input(message: string, fallback?: string, secret?: boolean, signal?: AbortSignal): Promise<string>;
  choose(message: string, choices: string[], fallback?: number): Promise<number>;
  confirm(message: string, signal?: AbortSignal): Promise<boolean>;
  log(message: string): void;
}

export async function chooseMany(ui: SetupUI, message: string, choices: string[], fallback = 0): Promise<number[]> {
  ui.log(`\n${message}\n${choices.map((choice, index) => `  ${index + 1}. ${choice}`).join('\n')}`);
  for (;;) {
    const answer = (await ui.input('Choose one or more numbers, separated by commas or spaces', String(fallback + 1))).trim() || String(fallback + 1);
    const parts = answer.split(/[\s,]+/);
    const values = parts.map(Number);
    if (parts.every(part => /^\d+$/.test(part)) && values.every(value => Number.isInteger(value) && value >= 1 && value <= choices.length)) {
      return [...new Set(values.map(value => value - 1))];
    }
    ui.log(`Enter numbers from 1 to ${choices.length}, for example 1, 2.`);
  }
}

export function terminalUI(signal: AbortSignal): SetupUI & { close(): void } {
  const colour = terminalColour(process.stderr.isTTY) && !process.env.NODE_DISABLE_COLORS;
  const paint = (format: Parameters<typeof styleText>[0], text: string) => colour ? styleText(format, text, { validateStream: false }) : text;
  let hidden = false;
  const output = new Writable({ write(chunk, _encoding, callback) {
    if (!hidden) process.stderr.write(chunk);
    callback();
  } });
  const terminal = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  const ui = {
    log: (message: string) => {
      const format = message.trim() === 'Ready to save' ? 'bold' : /FAIL|failed|Invalid/.test(message) ? 'red' : /NOT TESTED|not tested|unverified|Not verified|Partial|Skipped/.test(message) ? 'yellow' : /PASS|Passed|Ready|saved/.test(message) ? 'green' : /^(Next:|Then:|  \w+:)/.test(message) ? 'cyan' : 'dim';
      process.stderr.write(`${paint(format, message)}\n`);
    },
    async input(message: string, fallback?: string, secret = false, extraSignal?: AbortSignal): Promise<string> {
      signal.throwIfAborted();
      const label = `${paint('bold', message)}${fallback !== undefined && !secret && fallback !== '' ? paint('cyan', ` [${fallback}]`) : ''}: `;
      if (secret) { process.stderr.write(label); hidden = true; }
      try { return (await terminal.question(secret ? '' : label, { signal: extraSignal ? AbortSignal.any([signal, extraSignal]) : signal })).trim() || fallback || ''; }
      finally { hidden = false; if (secret) process.stderr.write('\n'); }
    },
    async choose(message: string, choices: string[], fallback = 0): Promise<number> {
      process.stderr.write(`\n${paint('bold', message)}\n\n`);
      choices.forEach((choice, index) => process.stderr.write(`  ${paint('cyan', String(index + 1))}. ${choice}\n`));
      for (;;) {
        const value = Number(await ui.input('Choose', String(fallback + 1)));
        if (Number.isInteger(value) && value >= 1 && value <= choices.length) return value - 1;
        ui.log(`Enter a number from 1 to ${choices.length}.`);
      }
    },
    confirm: async (message: string, extraSignal?: AbortSignal) => {
      try { let r = (await ui.input(`${message} Type yes to confirm`, 'no', false, extraSignal)); return r === 'yes' || r === "ya"; }
      catch (error) { if (signal.aborted || extraSignal?.aborted) return false; throw error; }
    },
    close: () => terminal.close(),
  };
  terminal.on('SIGINT', () => process.emit('SIGINT'));
  return ui;
}
