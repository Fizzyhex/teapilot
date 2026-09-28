import { lstat, realpath, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Config } from '../config.js';
import type { Permission } from './grants.js';

export interface Approval { kind: 'route' | 'shell' | 'overwrite' | 'capability' | 'access' | 'play' | 'network'; summary: string; details?: string; signal?: AbortSignal; permissions?: Permission[]; cwd?: string; duration?: 'session' }
export type Approve = (approval: Approval) => Promise<boolean>;
export type BeforeMutation = (action: { tool: string; path?: string }, signal?: AbortSignal) => Promise<void>;
export class PolicyDenied extends Error {}

export function cleanChildEnvironment(env = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir', 'lang', 'lc_all', 'term']);
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toLowerCase())));
}

export function automaticCommand(command: string, trusted: string[]): boolean {
  if (trusted.includes(command)) return true;
  // Exact fixed commands only; no shell grammar, arbitrary flags, revisions,
  // paths, substitutions, git aliases, textconv, external diff, or pagers.
  return [
    'git status --short', 'git status --porcelain',
    'git --no-pager diff --no-ext-diff --no-textconv',
    'git --no-pager diff --no-ext-diff --no-textconv --stat',
    'git --no-pager log -5 --oneline', 'git ls-files',
  ].includes(command);
}

/** Whether `path` lies strictly inside `directory`, or is `directory` itself when `inclusive`. */
export function within(directory: string, path: string, inclusive = false): boolean {
  const rel = relative(directory, path);
  return rel ? rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) : inclusive;
}

export class ExecutionPolicy {
  denied = false;
  shellRan = false;
  /**
   * `scratch` is the session's scratchpad folder: files there are the agent's own working material, so reading and
   * writing them needs no repository permission or approval, and they never count as changes to the project.
   */
  constructor(readonly root: string, private readonly config: Config, private readonly approve: Approve, private readonly beforeMutation?: BeforeMutation, readonly scratch?: string) {}
  /** Whether `path` (relative to the root, or absolute) is in the scratchpad. */
  inScratch(path: string): boolean { return this.scratch !== undefined && within(this.scratch, resolve(this.root, path), true); }
  requireRead(path?: string): void {
    if (path !== undefined && this.inScratch(path)) return;
    if (!this.config.policy.permissions.includes('repository.read')) { this.denied = true; throw new PolicyDenied('Missing repository.read permission'); }
  }
  async path(path: string, mutation: boolean): Promise<string> {
    if (!path || path.includes('\0') || path.startsWith('~')) throw new PolicyDenied('Use repository-relative paths');
    const target = resolve(this.root, path);
    const scratch = this.inScratch(target);
    const base = scratch ? this.scratch! : this.root;
    const rel = relative(base, target);
    // A working root the operator placed inside the state directory (a Discord workspace, say) is the
    // repository; the rest of the state directory, and any configuration inside the root, stays protected.
    const configDir = this.config.source?.directory;
    const workspace = configDir !== undefined && within(this.config.stateDir, this.root) && !within(this.root, configDir, true);
    if (!scratch && within(this.config.stateDir, target, true) && !(workspace && within(this.root, target))) throw new PolicyDenied('Host state is protected');
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new PolicyDenied(scratch ? 'Path must be a file inside the scratchpad' : 'Path must be a file inside the working repository');
    const parts = rel.split(sep);
    if (parts.some(part => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new PolicyDenied('Ambiguous or reserved filesystem name');
    if (parts.some(part => /^(\.git|\.env(?:\..*)?|\.teapilot|\.jevrouter|\.ssh|\.aws|auth\.json)$/i.test(part) && part !== '.env.example')) throw new PolicyDenied('Credential and host state paths are protected');
    // Reject symlinks/junctions and hard-linked files instead of trusting string
    // prefixes. Check existing ancestors as well as the final path. The scratchpad
    // sits where sandboxed commands can write, so the folder itself is checked too.
    if (scratch && (await lstat(base).catch(() => undefined))?.isSymbolicLink()) throw new PolicyDenied('Linked paths are not allowed');
    let current = base;
    for (const part of parts) {
      if (part.includes(':')) throw new PolicyDenied('Alternate data streams are not allowed');
      current = resolve(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw new PolicyDenied('Linked paths are not allowed');
        const actual = relative(scratch ? await realpath(base) : this.root, await realpath(current));
        if (actual === '..' || actual.startsWith(`..${sep}`) || isAbsolute(actual)) throw new PolicyDenied(scratch ? 'Path resolves outside the scratchpad' : 'Path resolves outside repository');
        // Saved output in the scratchpad is read a window at a time, so its size is no reason to refuse it.
        if (current === target && info.isFile() && !mutation && !scratch && info.size > 1_000_000) throw new PolicyDenied('Read a smaller file (maximum 1 MB)');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return target;
  }
  wrap(tool: AgentTool): AgentTool {
    return { ...tool, execute: async (id, params, signal, update) => {
      try {
        signal?.throwIfAborted();
        const args = params as Record<string, unknown>;
        const shell = tool.name === 'bash' || tool.name === 'powershell';
        const mutation = tool.name === 'write' || tool.name === 'edit';
        const permission = shell ? 'repository.shell' : mutation ? 'repository.write' : 'repository.read';
        // The scratchpad is the agent's own: it needs no repository permission, and replacing a file there asks nobody.
        const scratch = !shell && typeof args.path === 'string' && Boolean(args.path) && this.inScratch(args.path);
        if (!scratch && !this.config.policy.permissions.includes(permission)) throw new PolicyDenied(`Missing ${permission} permission`);
        if (shell) {
          const command = String(args.command);
          if (!automaticCommand(command, this.config.policy.execution.trustedCommands)) {
            if (!await this.approve({ kind: 'shell', summary: `Run ${tool.name} in ${this.root}? This can have external or destructive effects.`, details: command, signal })) throw new PolicyDenied('Shell command was not approved');
          }
          if (automaticCommand(command, [])) {
            // Even inspection can execute configured helpers (fsmonitor or gpg).
            // Disable those for the small built-in Git inspection allowlist.
            args.command = command.replace(/^git /, 'git -c core.fsmonitor=false -c core.untrackedCache=false -c log.showSignature=false -c submodule.recurse=false --no-pager ');
          }
          args.timeout = Math.min(typeof args.timeout === 'number' ? args.timeout : Infinity, this.config.policy.limits.commandTimeoutSeconds);
          await this.beforeMutation?.({ tool: tool.name }, signal);
        } else {
          const target = await this.path(String(args.path), mutation);
          if (mutation && !scratch) {
            const old = await readFile(target, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
            const removed = tool.name === 'write' ? old : String(args.oldText ?? '');
            const replacement = String(tool.name === 'write' ? args.content : args.newText);
            if (Buffer.byteLength(removed) >= this.config.policy.execution.largeOverwriteBytes || (removed.length > 1024 && replacement.length < removed.length / 2)) {
              if (!await this.approve({ kind: 'overwrite', summary: `Replace significant content in ${target}?`, details: `Removed (${removed.length} chars):\n${removed.slice(0, 4000)}\nReplacement (${replacement.length} chars):\n${replacement.slice(0, 4000)}`, signal })) throw new PolicyDenied('Overwrite was not approved');
            }
          }
          // Pi's factories accept absolute paths; validate again just before use.
          args.path = await this.path(target, mutation);
          if (mutation && !scratch) await this.beforeMutation?.({ tool: tool.name, path: target }, signal);
        }
        signal?.throwIfAborted();
        if (shell) this.shellRan = true;
        return await tool.execute(id, params, signal, update);
      } catch (error) {
        if (error instanceof PolicyDenied) this.denied = true;
        throw error;
      }
    } };
  }
}
