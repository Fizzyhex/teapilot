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
/** `text` with any half of a surrogate pair (left by cutting through an emoji) replaced by U+FFFD. */
export function wellFormedText(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

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

// A picture costs by its size in pixels, not by its bytes. Pictures are scaled to at most IMAGE_SIDE pixels on a
// side before they are sent (workspace/images.ts); at 32 pixels a token, that is about this many tokens.
export const IMAGE_SIDE = 1024;
export const IMAGE_TOKENS = 1024;
/** Larger than this, a picture is not sent: it would not fit a request, and a scaled one is far smaller. */
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/** Transport ceiling for the pictures in one request, apart from its text. */
export const MAX_IMAGE_PAYLOAD_BYTES = 32 * 1024 * 1024;
/** The bytes of the pictures (data URLs) in a serialized request body. */
export function imageBytes(body: string): number {
  let total = 0;
  for (const match of body.matchAll(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*/gi)) total += match[0].length;
  return total;
}

/** A picture in a message, as pi holds it or as the chat API takes it. */
const isImage = (value: object) => 'type' in value && (value.type === 'image' && 'data' in value || value.type === 'image_url' && 'image_url' in value);

/** The same lexical estimate over any JSON value: strings, plus keys and structure. A picture counts as IMAGE_TOKENS, however many bytes it holds. */
export function estimateValueTokens(value: unknown): number {
  if (typeof value === 'string') return estimateTextTokens(value);
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + estimateValueTokens(item) + 2, 0);
  if (value && typeof value === 'object' && isImage(value)) return IMAGE_TOKENS;
  if (value && typeof value === 'object') return Object.entries(value).reduce((sum, [key, item]) => sum + estimateTextTokens(key) + estimateValueTokens(item) + 4, 0);
  return estimateTextTokens(String(value));
}

export function estimateInputTokens(body: string): number {
  return estimatePayloadTokens(JSON.parse(body) as { messages?: unknown[]; tools?: unknown[] });
}
/** estimateInputTokens over a request that is not serialized yet. */
export function estimatePayloadTokens(payload: { messages?: unknown; tools?: unknown }): number {
  if (!Array.isArray(payload.messages)) throw new Error('Missing chat messages');
  // Count the model-bearing fields, not escaped transport JSON or sampling
  // options. Retain schema keys and structure because tools enter the prompt.
  // Template/tool rendering headroom plus per-message role/turn delimiters.
  return 2048 + payload.messages.length * 32 + estimateValueTokens(payload.messages) + estimateValueTokens(payload.tools ?? []);
}

/**
 * The room a call must leave for its reply: a quarter of the context, at least 4096 tokens, and never more than the
 * reply may use. A tier's reply limit is a ceiling for each call, not room held back from every call's input:
 * holding back 16k of a 32k context left little more than 14k for the conversation.
 */
export function replyRoom(profile: { contextTokens: number; maxOutputTokens: number }): number {
  return Math.min(profile.maxOutputTokens, Math.max(4096, Math.floor(profile.contextTokens / 4)));
}
