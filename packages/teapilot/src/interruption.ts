import { formatSize } from './integration/events.js';

/** Facts about partial work, separate from how a surface presents them. */
export interface Interruption {
  reason: string;
  edits: Array<{ path: string; size?: number }>;
  shellRan: boolean;
  check?: 'passed' | 'failed';
  advice?: string;
  detail?: string;
  reply?: string;
}

const headlines: Record<string, string> = {
  cancelled: 'stopped', approval_denied: 'stopped — the action wasn’t approved',
  provider_error: 'couldn’t finish — the model provider had a problem',
  unsupported: 'couldn’t finish — the model doesn’t support this request',
  context_limit: 'ran out of context', payload_limit: 'the request was too large to send',
  budget: 'stopped — reached a spending limit',
  ineffective_calls: 'stopped — the calls weren’t making progress',
  test_failures: 'stopped on failing checks', tool_failures: 'stopped on a tool error',
  timeout: 'ran out of time', tool_limit: 'stopped — this request reached its tool limit',
  turn_limit: 'stopped — this request reached its turn limit',
  search_unavailable: 'couldn’t finish — search was unavailable',
};

/** A path stays literal even if its name contains markdown or line breaks. */
function code(path: string): string {
  const text = path.replace(/\s+/g, ' ');
  const fence = '`'.repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length)) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

export function formatInterruption(info: Interruption, discord = false): string {
  const stopped = info.reason === 'cancelled';
  const files = info.edits.slice(0, 3).map(edit => code(edit.path)).join(', ');
  const more = info.edits.length > 3 ? ` +${info.edits.length - 3} more` : '';
  const state = info.edits.length ? `edits to ${files}${more} are still there.` : undefined;
  const shell = info.shellRan ? `commands ran, so there may be ${state ? 'other ' : ''}changes.` : undefined;
  const checks = info.edits.length || info.shellRan ? info.check === 'passed' ? info.edits.length ? 'checks passed after the latest recorded edit.' : 'recorded checks passed.'
    : info.check === 'failed' ? 'checks are still failing.'
    : info.edits.length ? 'those edits haven’t been checked.' : 'no checks were recorded after the commands.' : undefined;
  const headline = headlines[info.reason] ?? `couldn’t finish — ${info.reason.replaceAll('_', ' ')}`;
  const lead = stopped && (state || shell) ? `${headline} — ${state ?? shell}` : headline;
  const body = [!stopped ? state : undefined, shell && (!stopped || state) ? shell : undefined].filter(Boolean).join('\n');
  return [lead, body || undefined, checks ? `${discord ? '-# ' : ''}${checks}` : undefined,
    !stopped ? info.advice : undefined,
    !stopped && info.reply ? `partial reply (task unfinished):\n${info.reply}` : undefined].filter(Boolean).join('\n\n');
}

/** Full paths and diagnostic context are available on demand, not in the acknowledgement. */
export function interruptionDetails(info: Interruption): string {
  return [
    ...info.edits.map(edit => `edited ${code(edit.path)}${edit.size === undefined ? '' : ` (${formatSize(edit.size)})`}`),
    info.shellRan ? 'commands ran; additional changes may exist.' : undefined,
    info.edits.length || info.shellRan ? `checks: ${info.check ?? 'not run after latest recorded edit'}` : undefined,
    info.detail,
    info.reason === 'cancelled' && info.reply ? `partial reply (task unfinished):\n${info.reply}` : undefined,
  ].filter(Boolean).join('\n');
}
