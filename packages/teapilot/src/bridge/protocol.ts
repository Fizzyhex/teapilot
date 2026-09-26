import { z } from 'zod';
import type { Activity } from '../activity.js';
import type { HostEvent } from '../integration/events.js';
import type { ChatPromptState } from '../composer.js';

export const BRIDGE_PROTOCOL = 1;
export const DEFAULT_BRIDGE_PORT = 8377;
/** Prompts are capped far below this by policy; the limit only bounds what an unauthenticated peer can make us buffer. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const TOKEN_ENV = 'TEAPILOT_BRIDGE_TOKEN';

export interface TurnResult { success: boolean; status: string; text: string; spentUsd: number; requestId: string; receipts: string[] }

/** Host → client. The client never supplies paths, configuration or credentials. */
export type HostMessage =
  | { t: 'hello'; version: number; root: string; routingMode: 'hosted' | 'direct' }
  | { t: 'input'; state: ChatPromptState }
  | { t: 'turn' }
  | { t: 'activity'; activity: Activity | undefined }
  | { t: 'event'; event: HostEvent }
  | { t: 'log'; text: string }
  | { t: 'approval'; id: string; text: string }
  | { t: 'answer'; result: TurnResult }
  | { t: 'end'; reason: string };

export const clientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('input'), text: z.string().max(100_000) }).strict(),
  z.object({ t: z.literal('approval'), id: z.string().max(100), approved: z.boolean() }).strict(),
]);
export type ClientMessage = z.infer<typeof clientMessage>;

const activity = z.object({ kind: z.enum(['waiting', 'reasoning', 'composing']), label: z.string() }).optional();
const state = z.object({ spentUsd: z.number(), lastModel: z.string().optional(), mode: z.enum(['chat', 'ask', 'code']).optional(), grants: z.array(z.string()).optional(), tier: z.string().optional(), cwd: z.string().optional() }).passthrough();
export const hostMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), version: z.number(), root: z.string(), routingMode: z.enum(['hosted', 'direct']) }),
  z.object({ t: z.literal('input'), state }),
  z.object({ t: z.literal('turn') }),
  z.object({ t: z.literal('activity'), activity }),
  z.object({ t: z.literal('event'), event: z.object({ type: z.string() }).passthrough() }),
  z.object({ t: z.literal('log'), text: z.string() }),
  z.object({ t: z.literal('approval'), id: z.string(), text: z.string() }),
  z.object({ t: z.literal('answer'), result: z.object({ success: z.boolean(), status: z.string(), text: z.string(), spentUsd: z.number(), requestId: z.string(), receipts: z.array(z.string()) }) }),
  z.object({ t: z.literal('end'), reason: z.string() }),
]);
