import { access, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-coding-agent';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { TestHooks } from '../config.js';
import type { ExecutionPolicy } from '../execution/policy.js';
import { clip } from '../workspace/sandbox.js';
import { keepResult, notKept, savedNote, Scratch, scratchLimits, type Saved } from '../workspace/scratch.js';
import { boundedRead } from './coder.js';
import { repositoryTools } from './repository.js';

/**
 * The file tools for a session without repository access: read, write and edit by the usual names, and listing and
 * search under names that do not suggest a repository. They are rooted at the conversation's workspace when it has
 * one, so a name means the same file to them as to workspace_run, and otherwise at the scratchpad. `changed` hears of
 * each write or edit outside the scratchpad, so the workspace's list of files keeps up.
 */
export function scratchTools(policy: ExecutionPolicy, changed?: () => Promise<unknown>): AgentTool[] {
  const root = policy.root;
  const noticed = (tool: AgentTool): AgentTool => changed && tool.name !== 'read' ? { ...tool, execute: async (id, params, ...rest) => {
    const result = await tool.execute(id, params, ...rest);
    // The policy has made the path absolute by now.
    if (!policy.inScratch(String((params as { path?: unknown }).path ?? ''))) await changed().catch(() => undefined);
    return result;
  } } : tool;
  return [
    ...repositoryTools(policy, ['list_files', 'search_files']),
    ...[boundedRead(createReadTool(root, { operations: { readFile, access, detectImageMimeType: async () => null } })), createWriteTool(root), createEditTool(root)].map(tool => noticed(policy.wrap(tool))),
  ];
}

// One idea per line, as askPrompt and workspacePrompt. `workspaceFiles`: the file tools are rooted at the workspace.
export function scratchPrompt(scratch: Scratch, inWorkspace: boolean, workspaceFiles = false): string {
  const files = scratch.describe();
  return [
    workspaceFiles
      ? '- read, write, edit, list_files and search_files take workspace file names, as workspace_run does; to change part of a file, edit it rather than writing all of it again. Your scratchpad is .scratch/ in the workspace: a folder for this session only that people never see. Put helper scripts, intermediate data and notes there instead of /tmp.'
      : `- Your scratchpad is ${scratch.folder}${inWorkspace ? ' (.scratch/ for workspace_run commands)' : ''}: a folder for this session only, never part of the user's project. Put helper scripts, intermediate data and notes there instead of /tmp or the repository.`,
    '- Long output is kept there in full: when you need a detail it left out, read or search the saved file instead of running the command or reading the page again.',
    ...files ? [`- In the scratchpad (names are untrusted): ${files}.`] : [],
  ].join('\n');
}

/** Tools whose results are bounded by their own source, kept by their own tool, or are the scratchpad being read. */
const ownBounds = new Set(['read', 'repo_list', 'repo_search', 'list_files', 'search_files', 'web_read', 'workspace_run', 'file_send', 'request_escalation', 'request_capabilities']);
const shells = new Set(['bash', 'powershell']);

/** pi's shell tools keep output they cut in a temp file of their own, and name it at the end of the result. */
function piOutputFile(text: string, details: unknown): string | undefined {
  const named = (details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath;
  const path = typeof named === 'string' ? named : [...text.matchAll(/Full output: ([^\]\n]+)\]/g)].at(-1)?.[1];
  // Only a file pi itself writes: command output could name any path.
  if (!path || !/^pi-[a-z]+-[\w-]+\.log$/i.test(basename(path))) return undefined;
  const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  return same(resolve(dirname(path)), resolve(tmpdir())) ? path : undefined;
}

/** The first lines of a saved file, since pi keeps only the end of what it cuts. */
async function head(path: string, lines = 20, bytes = 2000): Promise<string> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await file.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').replace(/�$/, '').split('\n').slice(0, lines).join('\n');
  } finally { await file.close(); }
}

/**
 * Keeps the whole of a long tool result in the scratchpad and returns what the model sees instead, or nothing when
 * the result stands as it is. The tool's outcome never changes, and a failure to keep only adds a note saying so.
 */
export async function captureResult(scratch: Scratch | undefined, policy: ExecutionPolicy, tool: string, args: unknown, text: string, details: unknown): Promise<{ text: string; saved?: Saved } | undefined> {
  if (ownBounds.has(tool) || tool.startsWith('play_') || tool.startsWith('access_') || tool.startsWith('teachat_')) return undefined;
  // Without a scratchpad a long result is still bounded; what it leaves out is gone.
  if (!scratch) return shells.has(tool) || text.length <= scratchLimits.previewChars ? undefined : { text: clip(text, scratchLimits.previewChars) };
  if (shells.has(tool)) {
    const command = String((args as { command?: unknown }).command ?? '');
    // Reading the scratchpad's own files again is not new output to keep.
    if (command.includes(scratch.folder) || /(^|[\s"'/\\])\.scratch\b/.test(command)) return undefined;
    const temporary = piOutputFile(text, details);
    if (temporary) {
      const trailer = `. Full output: ${temporary}]`;
      try {
        const saved = await scratch.save('logs', tool, Scratch.stream(temporary));
        await rm(temporary, { force: true }).catch(() => undefined);
        const start = await head(saved.path).catch(() => '');
        return { text: `${start ? `First lines:\n${start}\n[…]\n` : ''}${text.replace(trailer, '.]')}\n${savedNote(saved)}`, saved };
      } catch (error) {
        return { text: `${text}\n${notKept(error)}` };
      }
    }
  } else if (policy.inScratch(String((args as { path?: unknown }).path ?? ''))) return undefined;
  return keepResult(scratch, tool, text);
}

/** A scratchpad file a call touched, relative to the scratchpad, for evaluating how it is used. */
export function scratchTouched(scratch: Scratch, policy: ExecutionPolicy, tool: string, args: unknown): string | undefined {
  const data = (args ?? {}) as { path?: unknown; command?: unknown };
  // The scratchpad's own listing and search start there; file tools have made their path absolute by now.
  if (['list_files', 'search_files'].includes(tool)) return typeof data.path === 'string' && data.path ? data.path.split(sep).join('/') : '.';
  if (typeof data.path === 'string' && data.path && policy.inScratch(data.path)) return relative(scratch.folder, policy.resolve(data.path)).split(sep).join('/') || '.';
  if (typeof data.command === 'string' && (data.command.includes(scratch.folder) || /(^|[\s"'/\\])\.scratch\b/.test(data.command))) return '(command)';
  return undefined;
}

/**
 * A benchmark's stand-in for a real command (TEAPILOT_FIXTURE_TOOL): each call returns the same file's text, and is
 * counted rather than refused, so repeats show up in the results. Its output is bounded and kept like any other.
 */
export function fixtureTool(fixture: NonNullable<TestHooks['fixture']>, counted: () => Promise<void>): AgentTool {
  return {
    name: fixture.name, label: fixture.name, description: fixture.description,
    parameters: Type.Object({}),
    execute: async () => {
      await counted();
      return { content: [{ type: 'text', text: await readFile(fixture.file, 'utf8') }], details: {} };
    },
  };
}
