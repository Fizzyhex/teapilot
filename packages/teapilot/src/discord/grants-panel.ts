import type { Permission, SessionGrants } from '../execution/grants.js';
import type { Approve } from '../execution/policy.js';
import type { EventSink } from '../integration/events.js';
import type { AccessStore } from './access-store.js';

/** Custom id prefix of the buttons under /convo grants: `teapilot-grant:<permission>`; the panel's message id finds its conversation. */
export const grantPrefix = 'teapilot-grant:';
export const grantsGone = 'these buttons are from before teapilot restarted. run /convo grants again.';

/** A conversation's access as buttons; each press works on whatever the session holds at that moment. */
export interface GrantPanel {
  /** Everything the conversation can hold, and whether it holds it now. */
  state(): Array<{ permission: Permission; granted: boolean }>;
  /** Revokes a held permission, or asks for one that is not. Resolves with a note for the presser alone, if any. */
  press(permission: Permission, userId: string): Promise<string | undefined>;
}

/**
 * The press rules for `grants`. Anyone who may talk to teapilot can revoke; asking works as /grant does, within what the
 * presser may hold, and an operator's press is its own approval. Without `ask`, nobody is there to answer an approval,
 * so only operators and what the presser needs no approval for are granted.
 */
export function grantControls({ grants, access, key, log, onEvent, ask, signal, ended }: {
  grants: SessionGrants;
  access?: AccessStore;
  key: string;
  log(text: string): void;
  onEvent?: EventSink;
  ask?: Approve;
  signal?: AbortSignal;
  ended?(): boolean;
}): GrantPanel {
  const operator = (id: string) => !access || access.roleOf(id) === 'operator';
  return {
    state: () => grants.offered(),
    press: async (permission, userId) => {
      if (access && access.roleOf(userId) === undefined) return "you can't use teapilot here.";
      if (ended?.()) return grantsGone;
      const entry = grants.offered().find(offered => offered.permission === permission);
      if (!entry) return `${permission} isn't available in this convo.`;
      if (entry.granted) {
        grants.revoke(permission, onEvent);
        log(`${key}: ${userId} revoked ${permission}`);
        return undefined;
      }
      let unanswered = false;
      const approve: Approve = operator(userId) ? async () => true : ask ?? (async () => { unanswered = true; return false; });
      const approved = await grants.request([permission], 'asked for from /convo grants.', approve, signal,
        async (type, fields) => { onEvent?.({ type, ...fields } as Parameters<EventSink>[0]); }, access?.callerFor(userId)());
      log(`${key}: ${userId} asked for ${permission}: ${approved ? 'granted' : 'not granted'}`);
      return approved ? undefined : unanswered ? `${permission} needs an operator's ok. ask one to press it, or send a message and ask for it there.`
        : `${permission} wasn't granted - denied or unavailable.`;
    },
  };
}

/** The panel's text and buttons, as Discord's API takes them: green when granted, grey when not, five to a row. */
export function grantView(panel: GrantPanel) {
  const buttons = panel.state().map(({ permission, granted }) => ({ type: 2, style: granted ? 3 : 2, label: permission, custom_id: `${grantPrefix}${permission}` }));
  const rows = Array.from({ length: Math.ceil(buttons.length / 5) }, (_, index) => ({ type: 1, components: buttons.slice(index * 5, index * 5 + 5) }));
  return { content: buttons.length ? 'session access: green is granted, grey is not. press one to grant or revoke it.' : 'this conversation cannot be granted anything.', components: rows };
}
