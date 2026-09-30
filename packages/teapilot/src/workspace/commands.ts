import { rm } from 'node:fs/promises';
import type { WorkspaceStore } from './store.js';

/**
 * What /workspace, /convo clear and /new do to a conversation's workspace. The workspace belongs to the conversation:
 * clearing the conversation takes its scratchpad, clearing the workspace takes its files, and /new takes both.
 */
export interface WorkspaceControls {
  /** How many files people can see in it. */
  count(): number;
  clearFiles(): Promise<number>;
  /** The scratchpad is the conversation's working material, so it goes with the conversation. */
  clearScratch(): Promise<void>;
  /** The label people give it; with `label`, sets it first, and an empty one removes it. */
  name(label?: string): string | undefined;
  tree(dir?: string): string | undefined;
}

export const storeControls = (store: WorkspaceStore, conversation: () => string): WorkspaceControls => ({
  count: () => store.list(conversation()).length,
  clearFiles: () => store.clearFiles(conversation()),
  clearScratch: () => rm(store.scratch(conversation()), { recursive: true, force: true }),
  name: label => { if (label !== undefined) store.rename(conversation(), label); return store.name(conversation()); },
  tree: dir => store.tree(conversation(), dir),
});

export const workspaceHelp = '/workspace clear|name <name>|tree [dir]';

const files = (count: number) => `${count} file${count === 1 ? '' : 's'}`;

/** After /convo clear: files that stayed, and how to remove them. */
export const keptNote = (count: number): string | undefined =>
  count ? `note: the workspace still contains ${files(count)}.` : undefined;

/** Runs `/workspace …`; the reply to show, or undefined when the text is not a workspace command. */
export async function workspaceCommand(controls: WorkspaceControls | undefined, text: string): Promise<string | undefined> {
  const match = /^\/workspace(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return undefined;
  if (!controls) return 'This session has no workspace.';
  const [, action, rest = ''] = match;
  const argument = rest.trim().replace(/^(["'])(.*)\1$/, '$2');
  if (action === 'clear' && !argument) {
    const count = await controls.clearFiles();
    return count ? `Cleared the workspace (${files(count)}).` : 'The workspace was already empty.';
  }
  if (action === 'name') {
    if (!argument) return controls.name() ? `Workspace: ${controls.name()}` : 'the workspace has no name - use /workspace name <name>.';
    return `Workspace: ${controls.name(argument)}`;
  }
  if (action === 'tree') {
    const name = controls.name();
    const tree = controls.tree(argument || undefined);
    const body = tree ?? (argument ? 'No files there.' : 'No files yet.');
    return name ? `${name}\n${body}` : body;
  }
  return `Workspace commands: ${workspaceHelp}`;
}
