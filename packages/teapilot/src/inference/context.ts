// Independent transport ceiling, not a model token limit.
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

// Model vocabularies and chat templates are not available through the compatible
// chat API. This fallback deliberately budgets more than a typical chars/4
// estimate: short ASCII word fragments, individual punctuation, and byte
// fallback for non-ASCII. Like common BPE vocabularies, a single leading space
// joins the next word or symbol, and other whitespace runs (indentation, blank
// lines) count once per 16 characters rather than once per character. It is
// a heuristic, not an exact tokenizer or a guaranteed upper bound for every
// vocabulary. Providers remain authoritative.
export function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const part of text.match(/ ?[A-Za-z0-9]+| ?[^A-Za-z0-9 \t\r\n]|[ \t\r\n]+/gu) ?? []) {
    const body = part.length > 1 && part[0] === ' ' ? part.slice(1) : part;
    tokens += /^[A-Za-z0-9]/.test(body) ? Math.ceil(body.length / 3)
      : /^[ \t\r\n]/.test(body) ? Math.ceil(body.length / 16) : Buffer.byteLength(body);
  }
  return tokens;
}

// Scale a lexical estimate by what the provider reported for an earlier call in
// the same attempt. The ratio is bounded so one odd report cannot collapse the
// reservation: never below 60% of the lexical estimate, never above 2x.
export function calibratedTokens(estimate: number, observed?: { estimated: number; reported: number }): number {
  if (!observed || observed.estimated <= 0 || observed.reported <= 0) return estimate;
  const scaled = Math.ceil(estimate * observed.reported * 11 / (observed.estimated * 10));
  return Math.min(estimate * 2, Math.max(Math.ceil(estimate * 0.6), scaled));
}

export function estimateInputTokens(body: string): number {
  const payload = JSON.parse(body) as { messages?: unknown[]; tools?: unknown[] };
  if (!Array.isArray(payload.messages)) throw new Error('Missing chat messages');
  // Count the model-bearing fields, not escaped transport JSON or sampling
  // options. Retain schema keys and structure because tools enter the prompt.
  const count = (value: unknown): number => {
    if (typeof value === 'string') return estimateTextTokens(value);
    if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + count(item) + 2, 0);
    if (value && typeof value === 'object') return Object.entries(value).reduce((sum, [key, item]) => sum + estimateTextTokens(key) + count(item) + 4, 0);
    return estimateTextTokens(String(value));
  };
  // Template/tool rendering headroom plus per-message role/turn delimiters.
  return 2048 + payload.messages.length * 32 + count(payload.messages) + count(payload.tools ?? []);
}
