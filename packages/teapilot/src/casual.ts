/** A conversational reply sent as more than this many lines is sent as one message instead. */
export const MAX_CASUAL_LINES = 8;

/**
 * A conversational reply as the messages it is sent as, one per line. Models sometimes write the prompt's `\n`
 * literally, so that splits too. Undefined when it should go out as it is: code, or too many lines.
 */
export function casualLines(text: string): string[] | undefined {
  if (/^\s*(`{3,}|~{3,})/m.test(text)) return undefined;
  const lines = text.split(/\n|\\n/).map(line => line.trim()).filter(Boolean);
  return lines.length && lines.length <= MAX_CASUAL_LINES ? lines : undefined;
}

/** Sends the first line at once, then each later one 0.5–2 seconds after, showing typing while it waits. */
export async function paceLines(lines: string[], send: (line: string) => Promise<unknown> | void, { typing, delayMs = () => 500 + Math.random() * 1500, signal }: {
  typing?: () => void; delayMs?: () => number; signal?: AbortSignal;
} = {}): Promise<void> {
  for (const [index, line] of lines.entries()) {
    if (index) {
      if (signal?.aborted) return;
      typing?.();
      await new Promise(done => setTimeout(done, delayMs()));
    }
    await send(line);
  }
}
