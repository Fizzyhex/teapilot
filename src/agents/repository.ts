import { opendir, readFile, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { ExecutionPolicy, PolicyDenied } from '../execution/policy.js';

// Enumeration never invokes a shell. Every directory and file crosses the same
// boundary as read; linked/protected paths are omitted, not followed.
export function repositoryTools(policy: ExecutionPolicy): AgentTool[] {
  return ['repo_list', 'repo_search'].map(name => ({
    name, label: name === 'repo_list' ? 'List repository files' : 'Search repository text',
    description: `${name === 'repo_list' ? 'List files' : 'Search literal text with line references'} inside the repository without shell approval. Respects .gitignore, skips protected/linked/generated paths, and reports truncation. An empty list is a valid empty project.`,
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Repository-relative directory; defaults to .', maxLength: 1000 })),
      ...(name === 'repo_search' ? { query: Type.String({ minLength: 1, maxLength: 500 }), caseSensitive: Type.Optional(Type.Boolean()) } : {}),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    execute: async (_id, params, signal) => {
      policy.requireRead();
      const args = params as { path?: string; query?: string; caseSensitive?: boolean; limit?: number };
      const start = resolve(policy.root, args.path ?? '.');
      if (start !== policy.root) await policy.path(start, false);
      const limit = Math.min(200, Math.max(1, args.limit ?? 80));
      const results: Array<string | { path: string; line: number; text: string }> = [];
      let visited = 0, bytes = 0, output = 0, truncated = false, skipped = 0;
      const deadline = Date.now() + 5000;
      type Rules = Array<{ directory: string; matcher: Ignore }>;
      const slash = (value: string) => value.split(sep).join('/');
      async function rulesAt(directory: string, rules: Rules): Promise<Rules> {
        try {
          const path = await policy.path(resolve(directory, '.gitignore'), false);
          const text = await readFile(path, 'utf8');
          return [...rules, { directory, matcher: ignore().add(text) }];
        } catch (error) {
          if (error instanceof PolicyDenied || (error as NodeJS.ErrnoException).code === 'ENOENT') return rules;
          throw error;
        }
      }
      async function walk(directory: string, inherited: Rules, depth = 0): Promise<void> {
        const rules = await rulesAt(directory, inherited);
        const handle = await opendir(directory);
        for await (const entry of handle) {
          signal?.throwIfAborted();
          if (++visited > 5000 || Date.now() > deadline || depth > 32) { truncated = true; break; }
          if (['node_modules', 'dist', 'build', '.git'].includes(entry.name)) { skipped++; continue; }
          const path = resolve(directory, entry.name);
          let ignored = false;
          for (const rule of rules) {
            const result = rule.matcher.test(slash(relative(rule.directory, path)) + (entry.isDirectory() ? '/' : ''));
            if (result.ignored) ignored = true;
            else if (result.unignored) ignored = false;
          }
          if (ignored) { skipped++; continue; }
          try { await policy.path(path, false); }
          catch (error) { if (error instanceof PolicyDenied) { skipped++; continue; } throw error; }
          if (entry.isDirectory()) await walk(path, rules, depth + 1);
          else if (entry.isFile()) {
            const label = slash(relative(policy.root, path));
            if (name === 'repo_list') { results.push(label); output += label.length; }
            else {
              const info = await stat(path);
              if (bytes + info.size > 8_000_000) { truncated = true; break; }
              bytes += info.size;
              const text = await readFile(await policy.path(path, false), 'utf8');
              if (text.includes('\0')) { skipped++; continue; }
              const query = args.caseSensitive ? args.query! : args.query!.toLowerCase();
              for (const [index, line] of text.split(/\r?\n/).entries()) {
                if (!(args.caseSensitive ? line : line.toLowerCase()).includes(query)) continue;
                const excerpt = line.slice(0, 500);
                results.push({ path: label, line: index + 1, text: excerpt }); output += label.length + excerpt.length;
                if (line.length > 500) truncated = true;
                if (results.length >= limit || output >= 24000) break;
              }
            }
          }
          if (results.length >= limit || output >= 24000 || visited > 5000 || bytes >= 8_000_000 || Date.now() > deadline) { truncated = true; break; }
        }
      }
      // Load ancestor rules even when the caller narrows the search directory.
      let rules: Rules = [], ancestor = policy.root;
      if (start !== policy.root) {
        for (const part of relative(policy.root, start).split(sep)) {
          rules = await rulesAt(ancestor, rules);
          ancestor = resolve(ancestor, part);
          if (rules.some(rule => rule.matcher.ignores(slash(relative(rule.directory, ancestor)) + '/'))) throw new Error('Directory is ignored; choose an included repository path.');
        }
      }
      await walk(start, rules);
      const result = { results, truncated, skipped, note: truncated ? 'Output or scan limit reached; narrow the path/query. Long matching lines show their first 500 characters.' : 'Scan complete within scope; ignored, protected, linked, generated, and binary paths are omitted.' };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
    },
  }));
}
