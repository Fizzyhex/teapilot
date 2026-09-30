import type { Permission } from '../execution/grants.js';

/** Custom id prefix of the buttons under /convo grants: `teapilot-grant:<permission>`; the panel's message id finds its conversation. */
export const grantPrefix = 'teapilot-grant:';
export const grantsGone = 'these grants are gone: teapilot restarted since, or the conversation ended. run /convo grants again.';

/** A conversation's access as buttons; each press works on whatever the session holds at that moment. */
export interface GrantPanel {
  /** Everything the conversation can hold, and whether it holds it now. */
  state(): Array<{ permission: Permission; granted: boolean }>;
  /** Revokes a held permission, or asks for one that is not. Resolves with a note for the presser alone, if any. */
  press(permission: Permission, userId: string): Promise<string | undefined>;
}

/** The panel's text and buttons, as Discord's API takes them: green when granted, grey when not, five to a row. */
export function grantView(panel: GrantPanel) {
  const buttons = panel.state().map(({ permission, granted }) => ({ type: 2, style: granted ? 3 : 2, label: permission, custom_id: `${grantPrefix}${permission}` }));
  const rows = Array.from({ length: Math.ceil(buttons.length / 5) }, (_, index) => ({ type: 1, components: buttons.slice(index * 5, index * 5 + 5) }));
  return { content: buttons.length ? 'session access: green is granted, grey is not. press one to grant or revoke it.' : 'this conversation cannot be granted anything.', components: rows };
}
