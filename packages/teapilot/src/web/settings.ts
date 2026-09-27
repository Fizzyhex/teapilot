export const readerModes = ['auto', 'agent-browser', 'builtin', 'off'] as const;
export type ReaderMode = typeof readerModes[number];
/** How pages are read: `auto` uses agent-browser when it is found, `builtin` never does, `off` removes web_read. */
export interface ReaderSettings { mode: ReaderMode; agentBrowserBin?: string }
