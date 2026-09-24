import { opendir, readFile, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { ExecutionPolicy, PolicyDenied } from '../execution/policy.js';

// A repo_list output cap tuned for a small local model's context window: ~4 KB
// of JSON keeps one call well under a 16,384-token profile even before the
// conversation, system prompt, and other tool results are counted.
const LIST_OUTPUT_CAP = 4096;
// repo_search results are prose excerpts the model asked for by query, not an
// unbounded directory dump, so its existing generous cap is unchanged.
const SEARCH_OUTPUT_CAP = 24000;
// Above this many immediate subdirectories, a depth-first walk would exhaust
// the output cap inside the first subdirectory and never reveal the rest
// (e.g. 1 of 15 sibling repositories). Summarise instead of descending.
const MANY_SUBDIRECTORIES = 8;

function formatCount(count: number): string {
  return count === 0 ? 'empty' : `${count} file${count === 1 ? '' : 's'}`;
}

// Enumeration never invokes a shell. Every directory and file crosses the same
// boundary as read; linked/protected paths are omitted, not followed.
export function repositoryTools(policy: ExecutionPolicy): AgentTool[] {
  return ['repo_list', 'repo_search'].map(name => ({
    name, label: name === 'repo_list' ? 'List repository files' : 'Search repository text',
    description: `${name === 'repo_list' ? 'List files' : 'Search literal text with line references'} inside the repository without shell approval. Respects .gitignore, skips protected/linked/generated paths, and reports truncation. An empty list is a valid empty project. A root with many subdirectories is summarised as immediate children with per-directory file counts instead of a full recursive dump; list a specific subdirectory by path to see inside it.`,
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
      const outputCap = name === 'repo_list' ? LIST_OUTPUT_CAP : SEARCH_OUTPUT_CAP;
      const results: Array<string | { path: string; line: number; text: string }> = [];
      let visited = 0, bytes = 0, output = 0, truncated = false, skipped = 0, summaryDirCount = 0;
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
      // Yields entries of `directory` that survive the skip-list, .gitignore
      // rules, and the execution policy, consuming the shared visited/deadline
      // budget so every caller (listing, counting, searching) is bounded together.
      async function* scan(directory: string, rules: Rules): AsyncGenerator<{ name: string; path: string; isDir: boolean }> {
        const handle = await opendir(directory);
        for await (const entry of handle) {
          signal?.throwIfAborted();
          if (++visited > 5000 || Date.now() > deadline) { truncated = true; break; }
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
          yield { name: entry.name, path, isDir: entry.isDirectory() };
        }
      }
      async function countFiles(directory: string, inherited: Rules, depth: number): Promise<number> {
        if (depth > 32 || truncated) return 0;
        const rules = await rulesAt(directory, inherited);
        let count = 0;
        for await (const item of scan(directory, rules)) {
          if (item.isDir) count += await countFiles(item.path, rules, depth + 1);
          else count++;
        }
        return count;
      }
      async function walk(directory: string, inherited: Rules, depth = 0): Promise<void> {
        if (depth > 32) { truncated = true; return; }
        const rules = await rulesAt(directory, inherited);
        for await (const item of scan(directory, rules)) {
          if (item.isDir) {
            if (name === 'repo_list') {
              // Empty directories (including newly created ones) contribute no
              // file entries of their own; mark them explicitly so they are
              // still visible instead of silently vanishing from the listing.
              const before = results.length;
              await walk(item.path, rules, depth + 1);
              if (results.length === before && !truncated) {
                const label = slash(relative(policy.root, item.path));
                results.push(`${label}/ (empty)`); output += label.length + 9;
              }
            } else {
              await walk(item.path, rules, depth + 1);
            }
          } else {
            const label = slash(relative(policy.root, item.path));
            if (name === 'repo_list') { results.push(label); output += label.length; }
            else {
              const info = await stat(item.path);
              if (bytes + info.size > 8_000_000) { truncated = true; break; }
              bytes += info.size;
              const text = await readFile(await policy.path(item.path, false), 'utf8');
              if (text.includes('\0')) { skipped++; continue; }
              const query = args.caseSensitive ? args.query! : args.query!.toLowerCase();
              for (const [index, line] of text.split(/\r?\n/).entries()) {
                if (!(args.caseSensitive ? line : line.toLowerCase()).includes(query)) continue;
                const excerpt = line.slice(0, 500);
                results.push({ path: label, line: index + 1, text: excerpt }); output += label.length + excerpt.length;
                if (line.length > 500) truncated = true;
                if (results.length >= limit || output >= outputCap) break;
              }
            }
          }
          if (results.length >= limit || output >= outputCap || visited > 5000 || bytes >= 8_000_000 || Date.now() > deadline) { truncated = true; break; }
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
      if (name === 'repo_list') {
        // Cheap, side-effect-free probe (no ignore rules, no policy checks, no
        // shared budget consumed) purely to decide whether a full depth-first
        // walk would bury sibling directories under the cap.
        let dirCount = 0;
        const probe = await opendir(start);
        for await (const entry of probe) {
          if (['node_modules', 'dist', 'build', '.git'].includes(entry.name)) continue;
          if (entry.isDirectory()) dirCount++;
        }
        if (dirCount > MANY_SUBDIRECTORIES) {
          summaryDirCount = dirCount;
          const startRules = await rulesAt(start, rules);
          const children: Array<{ label: string; path: string; isDir: boolean }> = [];
          for await (const item of scan(start, startRules)) children.push({ label: slash(relative(policy.root, item.path)), path: item.path, isDir: item.isDir });
          children.sort((a, b) => a.label.localeCompare(b.label));
          for (const child of children) {
            if (results.length >= limit) break;
            const line = child.isDir ? `${child.label}/ (${formatCount(await countFiles(child.path, startRules, 0))})` : child.label;
            if (output + line.length > LIST_OUTPUT_CAP) break;
            results.push(line); output += line.length;
          }
          truncated = true;
        } else {
          await walk(start, rules);
        }
      } else {
        await walk(start, rules);
      }
      const note = summaryDirCount > 0
        ? `Root has ${summaryDirCount} subdirectories; showing immediate children with per-directory file counts instead of a full recursive listing. List a specific subdirectory (path: "<name>") to see inside it.`
        : truncated
          ? (name === 'repo_list' ? 'Output or scan limit reached; narrow the path or list a specific subdirectory.' : 'Output or scan limit reached; narrow the path/query. Long matching lines show their first 500 characters.')
          : 'Scan complete within scope; ignored, protected, linked, generated, and binary paths are omitted.';
      const result = { results, truncated, skipped, note };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
    },
  }));
}
