import { chunk } from './render.js';

/** teapilot's accent, #babbf1, as Discord wants an embed colour. */
export const PLAN_COLOUR = 0xbabbf1;
/** Discord's limits on embeds: a description, a title, a footer, one message's embeds and the characters across them. */
const descriptionLimit = 4096;
const titleLimit = 256;
const footerLimit = 2048;
const embedsPerMessage = 10;
const embedCharsPerMessage = 6000;

/** An embed as Discord's API takes it. */
export interface PlanEmbed { title?: string; description: string; color: number; footer?: { text: string } }
/** What a plan's buttons do. */
export type PlanAction = 'approve' | 'juniors' | 'change';
/** Who pressed a plan button. */
export interface PlanClick { id: string; name: string }
/** A plan's buttons: `actions` are the ones showing, and `press` answers a press with a private note when it does nothing. */
export interface PlanControls {
  actions: PlanAction[];
  /** Why this person may not use the buttons, if they may not. */
  refusal(userId: string): string | undefined;
  press(action: PlanAction, user: PlanClick, request?: string): string | undefined;
}

export const approvePrompt = 'go ahead with the plan';
export const juniorsPrompt = [
  'REFINE THE PLAN',
  'workload distribtion - group up todo tasks for delegation (`delegate_task`) to juniors.',
  'short descriptive `#tags` next to your todos so you can maintain and reference them.',
  '',
  'maintenance - mark off completions, crossing off failures with notes, keep me in the loop.',
].join('\n');
export const changePrompt = (request: string) => `refine the plan with this request - don't take action yet:\n---\n${request}`;
/** How each button looks: the label people read is what they "say". */
export const planButtons: Record<PlanAction, { label: string; emoji?: string; style: 'success' | 'secondary' }> = {
  approve: { label: 'lgtm!', style: 'success' },
  juniors: { label: 'assign juniors', emoji: '♟️', style: 'secondary' },
  change: { label: 'request change', emoji: '✍️', style: 'secondary' },
};
export const planModal = { title: 'Request a change', field: 'request', label: 'What should change in the plan?', maxLength: 1500 };

/** The first `<plan>…</plan>` in a reply, with the text around it. */
export function extractPlan(text: string): { before: string; plan: string; after: string } | undefined {
  const match = /<plan>([\s\S]*?)<\/plan>/i.exec(text);
  const plan = match?.[1]?.trim();
  if (!match || !plan) return undefined;
  return { before: text.slice(0, match.index).trim(), plan, after: text.slice(match.index + match[0].length).trim() };
}

/**
 * A plan as embeds, grouped into the messages that carry them. The leading `# heading` is the title; the rest is cut at
 * line breaks into descriptions. The footer goes on the last embed, where the buttons are.
 */
export function planMessages(plan: string, footer?: string): PlanEmbed[][] {
  const heading = /^#\s+(.+)\n?/.exec(plan.trimStart());
  const title = heading?.[1]?.trim().slice(0, titleLimit);
  const body = (heading ? plan.trimStart().slice(heading[0].length) : plan).trim() || '(empty plan)';
  const embeds: PlanEmbed[] = chunk(body, descriptionLimit).map((description, index) => ({ ...(index === 0 && title ? { title } : {}), description, color: PLAN_COLOUR }));
  if (footer) embeds.at(-1)!.footer = { text: footer.slice(0, footerLimit) };
  const size = (embed: PlanEmbed) => (embed.title?.length ?? 0) + embed.description.length + (embed.footer?.text.length ?? 0);
  const messages: PlanEmbed[][] = [];
  let total = 0;
  for (const embed of embeds) {
    const current = messages.at(-1);
    if (!current || current.length >= embedsPerMessage || total + size(embed) > embedCharsPerMessage) { messages.push([embed]); total = size(embed); }
    else { current.push(embed); total += size(embed); }
  }
  return messages;
}
