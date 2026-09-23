// Independent transport ceiling, not a model token limit.
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

// Model vocabularies and chat templates are not available through the compatible
// chat API. This fallback deliberately budgets more than a typical chars/4
// estimate: short ASCII word fragments, individual punctuation/whitespace, and
// byte fallback for non-ASCII. It is a heuristic, not an exact tokenizer or a
// guaranteed upper bound for every vocabulary. Providers remain authoritative.
export function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const part of text.match(/[A-Za-z0-9]+|[^A-Za-z0-9]/gu) ?? []) {
    tokens += /^[A-Za-z0-9]/.test(part) ? Math.ceil(part.length / 3) : Buffer.byteLength(part);
  }
  return tokens;
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
