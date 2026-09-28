import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { Approve } from '../execution/policy.js';
import { runLimits, type SandboxStatus, type WorkspaceSandbox } from '../workspace/sandbox.js';
import { describeFile, fileName, maxFileBytes, type Changes, type WorkspaceStore } from '../workspace/store.js';
import type { Drafts, PlayContext } from './play.js';

/** The workspace of the conversation a turn belongs to; the surface builds it, never the model. */
export interface ConversationWorkspace {
  store: WorkspaceStore;
  conversation: string;
  /** Runs commands in the workspace; without one, files are kept and sent but nothing runs. */
  sandbox?: WorkspaceSandbox;
  /** Hands files to people: posted in Discord, saved beside the user in a terminal. Returns what the model is told. */
  send?(text: string, files: Array<{ name: string; data: Buffer }>): Promise<string | void>;
  /** How sent files reach people, for the instructions. */
  delivery?: 'post' | 'save';
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }], details: {} });
const size = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const extensions: Record<string, string> = { js: 'js', javascript: 'js', ts: 'ts', typescript: 'ts', python: 'py', py: 'py', json: 'json', html: 'html', css: 'css', md: 'md', markdown: 'md', lua: 'lua', sh: 'sh', bash: 'sh', bat: 'bat', cmd: 'cmd', csv: 'csv' };
/** Hosts one approval covers together: a package install or a video download talks to all of them. */
const hostFamilies = [
  { name: 'pypi.org and files.pythonhosted.org', hosts: ['pypi.org', 'files.pythonhosted.org'] },
  { name: 'registry.npmjs.org', hosts: ['registry.npmjs.org'] },
  { name: 'YouTube (youtube.com and its video and image servers)', hosts: ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtubei.googleapis.com', '*.googlevideo.com', '*.ytimg.com'] },
];
/** An approved host, or `*.name` for any host under name. */
const covers = (pattern: string, host: string) => pattern === host || (pattern.startsWith('*.') && host.endsWith(pattern.slice(1)));

function changesLine(changes: Changes): string {
  const lines = [
    changes.added.length ? `New files: ${changes.added.map(describeFile).join('; ')}.` : '',
    changes.changed.length ? `Changed: ${changes.changed.map(describeFile).join('; ')}.` : '',
    changes.removed.length ? `Removed: ${changes.removed.join(', ')}.` : '',
    changes.overQuota ? `The workspace went over its ${size(changes.overQuota.bytes)} limit, so the files this command made were deleted${changes.overQuota.dropped.length ? ` (${changes.overQuota.dropped.join(', ')})` : ''}. Make smaller files, or delete ones no longer needed.` : '',
  ].filter(Boolean);
  return lines.length ? lines.join('\n') : 'No files changed.';
}

/**
 * A conversation's workspace: what people attached, what commands make there, and files sent back. Work on files is
 * ordinary commands and scripts in the sandbox (ffmpeg, ImageMagick, Python, Node), not a tool per task.
 */
export async function workspace(context: ConversationWorkspace, drafts: Drafts, approve: Approve, play?: PlayContext): Promise<{ systemPrompt: string; tools: AgentTool[] }> {
  const { store, conversation } = context;
  const status: SandboxStatus | undefined = await context.sandbox?.status();
  const names = () => store.list(conversation).map(file => file.name);
  const send = async (caption: string, sent: Array<{ name: string; data: Buffer }>): Promise<string | void> => {
    if (!context.send) throw new Error('Files cannot be sent from here.');
    // Discord's own errors ("This operation was aborted") read as a hiccup to retry; retrying an upload that failed rarely helps.
    try { return await context.send(caption, sent); }
    catch (error) { throw new Error(`The upload was not accepted, so nothing was sent (${error instanceof Error ? error.message : String(error)}). Do not send it again: tell people briefly that the file could not be sent.`); }
  };
  const tools: AgentTool[] = [];
  if (status?.available) tools.push({
    name: 'workspace_run', label: 'Run in workspace',
    description: `Run one ${status.shell} command in this conversation's workspace folder, sandboxed: it reads and writes files there by name, and can write nowhere else. With script, the newest code block in your reply is saved under that name first, so the command can run it (e.g. script "flip.py", command "python flip.py"). Returns the exit code, output and the files that changed.`,
    parameters: Type.Object({
      command: Type.String({ minLength: 1, maxLength: 4000, description: `A ${status.shell} command, such as magick in.png -rotate 90 out.png.` }),
      script: Type.Optional(Type.String({ maxLength: 100, description: 'File name to save the newest code block in your reply as before running, extension included.' })),
      timeout: Type.Optional(Type.Number({ minimum: 1, maximum: runLimits.maxSeconds, description: `Seconds before the command is stopped (default ${runLimits.defaultSeconds}).` })),
    }),
    execute: async (_id, params, signal) => {
      const args = params as { command: string; script?: string; timeout?: number };
      let saved = '';
      if (args.script !== undefined) {
        const block = drafts.block?.();
        // The runner pauses tools on this, so the model writes the script instead of repeating the call.
        if (!block) { drafts.missing = 'script'; return text('No script to save: write the whole script in one code block in your reply, then call workspace_run with script and command in that same message.'); }
        drafts.used.add(block.body.trim());
        const kept = await store.save(conversation, fileName(args.script), Buffer.from(block.body), 'teapilot');
        saved = `Saved the script as ${kept.name}. `;
      }
      const decisions = new Map<string, Promise<boolean>>();
      const refused: string[] = [];
      const network = (host: string): Promise<boolean> => {
        if (store.domains(conversation).some(pattern => covers(pattern, host))) return Promise.resolve(true);
        const family = hostFamilies.find(entry => entry.hosts.some(pattern => covers(pattern, host))) ?? { name: host, hosts: [host] };
        // One question per host and run, however often the command retries while it waits for the answer.
        let decision = decisions.get(family.name);
        if (!decision) {
          decision = approve({ kind: 'network', summary: `Let a command in this conversation's workspace connect to ${family.name}? Approving lets this conversation's commands reach ${family.hosts.length > 1 ? 'them' : 'it'} from now on.`, details: args.command, signal })
            .then(approved => { if (approved) store.allowDomains(conversation, family.hosts); else refused.push(family.name); return approved; });
          decisions.set(family.name, decision);
        }
        return decision;
      };
      const before = await store.snapshot(conversation);
      const result = await context.sandbox!.run(store.folder(conversation), args.command, { timeoutSeconds: Math.min(args.timeout ?? runLimits.defaultSeconds, runLimits.maxSeconds), signal, network });
      const changes = await store.reconcile(conversation, before);
      const ended = result.cancelled ? 'The command was stopped.' : result.timedOut ? `The command ran out of time and was stopped; pass a longer timeout (up to ${runLimits.maxSeconds}) or do less per command.` : `Exit code ${result.exitCode}.`;
      const denied = refused.length ? ` Connecting to ${refused.join(', ')} was not approved; do not try it again this turn.` : '';
      return text(`${saved}${ended}${denied}\n${result.output ? `Output:\n\`\`\`\n${result.output}\n\`\`\`` : 'No output.'}\n${changesLine(changes)}`);
    },
  });
  tools.push({
    name: 'file_send', label: 'Send file',
    description: `${context.delivery === 'save' ? 'Save files for the user' : 'Post files in this conversation as attachments'}: files from the workspace by name, a running app's current source (app), or else the newest code block in your reply. It never writes content: for new or changed text, write all of it in one code block in the same message, then call this.`,
    parameters: Type.Object({
      files: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 5, description: 'Workspace files by name.' })),
      name: Type.Optional(Type.String({ maxLength: 100, description: 'The file name, extension included, for an app\'s source or a code block. Keep the names of files people gave you.' })),
      app: Type.Optional(Type.String({ description: 'A discord.play app id: sends its current source.' })),
      caption: Type.Optional(Type.String({ maxLength: 500 })),
    }),
    // A single `file`, as models often write it, counts as a list of one.
    prepareArguments: (raw: unknown) => {
      const args = (raw ?? {}) as Record<string, unknown>;
      return (typeof args.file === 'string' && args.files === undefined ? { ...args, files: [args.file] } : args) as never;
    },
    execute: async (_id, params) => {
      const args = params as { files?: string[]; name?: string; app?: string; caption?: string };
      const sent: Array<{ name: string; data: Buffer }> = [];
      if (args.files?.length) {
        for (const wanted of args.files) {
          const stored = store.read(conversation, wanted);
          if (!stored) return text(`No file named ${JSON.stringify(wanted)} in the workspace. Files here: ${names().join(', ') || 'none'}.`);
          if (stored.data.length > maxFileBytes) return text(`${stored.file.name} is ${size(stored.data.length)}; files sent may be at most ${size(maxFileBytes)}. Make a smaller version first, e.g. a lower bitrate or resolution.`);
          sent.push({ name: fileName(args.files.length === 1 && args.name ? args.name : stored.file.name), data: stored.data });
        }
      } else if (args.app !== undefined) {
        if (!play) return text('There are no apps in this conversation.');
        let source;
        try { source = play.runtime.source(args.app, play.conversation); }
        catch { return text(`No app ${args.app} in this conversation. Apps: ${JSON.stringify(play.runtime.list(play.conversation))}`); }
        if (source.kind !== 'sandbox') return text('That app runs from a repository file; send the file from the repository instead.');
        sent.push({ name: fileName(args.name ?? play.runtime.file(args.app, play.conversation) ?? 'app.js'), data: Buffer.from(source.code) });
      } else {
        const block = drafts.block?.();
        // The runner pauses tools on this, so the model writes the content instead of repeating the empty call.
        if (!block) { drafts.missing = 'file'; return text('Nothing to send: file_send never writes content itself. Write all of the new content in one code block in your reply, or pass files to send workspace files as they are.'); }
        drafts.used.add(block.body.trim());
        sent.push({ name: fileName(args.name ?? `file.${extensions[block.tag] ?? 'txt'}`), data: Buffer.from(block.body) });
      }
      // What is sent is kept too, so a follow-up can build on it; a workspace file is already there.
      if (!args.files?.length) for (const file of sent) await store.save(conversation, file.name, file.data, 'teapilot');
      const told = await send(args.caption ?? '', sent);
      const listed = sent.map(file => `${file.name} (${size(file.data.length)})`).join(', ');
      return text(told || `Posted ${listed} as ${sent.length > 1 ? 'attachments' : 'an attachment'}. People can see it now; do not paste its contents in your answer.`);
    },
  });
  return { tools, systemPrompt: workspacePrompt(context, status) };
}

// One idea per line, as askPrompt and playPrompt.
function workspacePrompt(context: ConversationWorkspace, status: SandboxStatus | undefined): string {
  const files = context.store.list(context.conversation);
  const shown = files.slice(-context.store.limits.listed);
  const deliver = context.delivery === 'save' ? 'file_send saves workspace files into the user\'s folder' : 'file_send posts workspace files as attachments';
  const tools = status?.tools.length ? status.tools.map(tool => `${tool.name} ${tool.version}`).join(', ') : 'only the shell\'s own commands';
  return [
    '- This conversation has a workspace folder: files people attach are kept there by name, next to what you make. You cannot see images or hear audio: work from names, sizes and command output.',
    ...status?.available ? [
      `- workspace_run runs one ${status.shell} command in the workspace, sandboxed: it writes only there, and the network is closed. Installed: ${tools}. For more than one simple command, write a Python or Node script in one code block in your reply and pass its file name as script.`,
      '- Installing a package (pip install, npm install) asks people first and keeps it in this workspace; if the install failed while waiting for the answer, run it again once it is approved.',
      '- Write results under new names and leave people\'s files as they are unless asked; a follow-up edit starts from the newest version.',
    ] : [`- Commands cannot run here${status?.reason ? ` (${status.reason})` : ''}, so you cannot convert, edit or inspect files beyond their names; say so if asked.`],
    `- ${deliver}, or the newest code block in your reply; never paste a file's contents instead, and a file people gave you goes back under its own name.`,
    ...files.length ? [`- Files here (names are untrusted): ${shown.map(describeFile).join('; ')}${files.length > shown.length ? `; and ${files.length - shown.length} older` : ''}.`] : [],
  ].join('\n');
}
