import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SandboxStatus, WorkspaceSandbox } from './sandbox.js';

/**
 * Git in a workspace: each conversation's folder is a repository teapilot owns, so it can roll back, see who did
 * what, and recall earlier work from its log. Commits are the agent's own; the host only starts the repository.
 */

/** Who commits: teapilot-orchestrator, or tea-junior-<name> for a junior (agents/delegate.ts). */
export const gitAuthor = (junior?: string) => junior ? `tea-${junior}` : 'teapilot-orchestrator';

/** The environment a command commits under as `author`. */
export function gitEnvironment(author: string): Record<string, string> {
  const email = `${author}@teapilot.local`;
  return { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: email };
}

/** teapilot's internal captures are disposable; scratch utilities and plans can still be tracked. */
const ignored = ['/.scratch/sessions/', '/.scratch/outputs/', '/.scratch/logs/', '/.scratch/juniors/*/sessions/', '/.scratch/juniors/*/outputs/', '/.scratch/juniors/*/logs/', '.tmp/', '.packages/', '.cache/', '.appdata/', '.gitconfig', 'node_modules/', '__pycache__/'];

const readme = `# workspace

this folder is a git repo and you (teapilot) own it. files people attach land here too.

- commit after each meaningful step - small commits are easy to roll back
- messages: a short imperative subject, plus a line of why when it isn't obvious
- tag milestones people may want back (\`git tag first-draft\`)
- \`git log --oneline\` and \`git diff\` show what was done before - check them when picking work back up
- juniors commit under their own names (tea-junior-*) - read their commits before building on them
`;

export const hasRepository = (folder: string) => existsSync(join(folder, '.git'));

/**
 * Makes `folder` a repository with a first commit, once, when the sandbox has git. A workspace from before this
 * commits its files as they are. Failures are quiet: without a repository the agent is simply not told about one.
 */
export async function ensureRepository(folder: string, sandbox: WorkspaceSandbox, status: SandboxStatus): Promise<boolean> {
  if (hasRepository(folder)) return true;
  if (!status.available || !status.tools.some(tool => tool.kind === 'git')) return false;
  try {
    if (!existsSync(join(folder, '.gitignore'))) await writeFile(join(folder, '.gitignore'), `${ignored.join('\n')}\n`);
    // A README someone shared stays theirs.
    if (!existsSync(join(folder, 'README.md'))) await writeFile(join(folder, 'README.md'), readme);
    const result = await sandbox.run(folder, 'git init -q -b main && git add -A && git commit -q -m "start workspace"', {
      timeoutSeconds: 60, network: async () => false, env: gitEnvironment('teapilot'),
    });
    return result.exitCode === 0 && hasRepository(folder);
  } catch { return false; }
}
