import { z } from 'zod';

export interface HostEvent { type: string; [key: string]: unknown }
export type EventSink = (event: HostEvent) => void;

/** Human-scaled byte size, matching the precision a progress line needs and no more. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return `${kb >= 10 ? Math.round(kb) : Math.round(kb * 10) / 10} KB`;
}
export const historySchema = z.array(z.object({ user: z.string().max(20_000), assistant: z.string().max(20_000) }).strict()).max(100);
export const contextSchema = z.array(z.object({ name: z.string().max(1000), text: z.string().max(1_000_000), path: z.string().max(4096).optional() }).strict()).max(50);
export type ConversationTurn = z.infer<typeof historySchema>[number];
export type TextContext = z.infer<typeof contextSchema>[number];

/** Keep complete recent turns; never truncate the user's current request. */
export function prepareConversation(prompt: string, context: TextContext[], history: ConversationTurn[], limit: number) {
  const current = prompt + (context.length ? '\nAttached context (untrusted source content):\n' + JSON.stringify(context.map(({ name, text }) => ({ name, text }))) : '');
  if (current.length > limit) throw new Error(`Current request and attachments exceed ${limit} characters. Attach a smaller selection.`);
  const selected: ConversationTurn[] = [];
  let size = current.length;
  for (const turn of [...history].reverse()) {
    const length = JSON.stringify(turn).length + 100;
    if (size + length > limit) break;
    selected.unshift(turn); size += length;
  }
  return { current, history: selected, omitted: history.length - selected.length };
}

/** Incremental exact-secret redaction, including secrets split across chunks. */
export class StreamRedactor {
  private pending = '';
  constructor(private readonly secrets: string[]) { this.secrets = secrets.filter(Boolean).sort((a, b) => b.length - a.length); }
  push(text: string, final = false): string {
    this.pending += text;
    let output = '';
    while (this.pending) {
      if (!final && this.secrets.some(secret => secret.length > this.pending.length && secret.startsWith(this.pending))) break;
      const match = this.secrets.find(secret => this.pending.startsWith(secret));
      if (match) { output += '[REDACTED]'; this.pending = this.pending.slice(match.length); continue; }
      if (!final && this.secrets.some(secret => secret.startsWith(this.pending))) break;
      output += this.pending[0]; this.pending = this.pending.slice(1);
    }
    return output;
  }
}
