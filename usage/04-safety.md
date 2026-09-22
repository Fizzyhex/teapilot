# Permissions and execution boundaries

Pi supplies the agent loop, read/write/edit tools, platform shell tools, tool result handling, and project instruction loading. Ancestor/root `AGENTS.md`/`CLAUDE.md` files load through pi; the coder is instructed to inspect relevant nested instructions before editing. Global/project pi extensions, skills, hooks, and arbitrary agent packages are **not automatically loaded**.

## Files and shell commands

File tools are restricted to the selected directory. Traversal, symlinks/junctions, hard links, `.git`, `.env*` (except `.env.example`), credential directories, and host state paths are blocked. Large reads are bounded; significant overwrites need approval. Selected read-only Git commands run automatically. Arbitrary shell commands require explicit `yes` in an interactive terminal. A denial stops the attempt and does not trigger escalation; noninteractive approval defaults to denial.

## Trusted commands

To allow builds/tests automatically in a **trusted repository**, add exact commands such as `npm test`, `npm run build`, and `npm run typecheck` to `execution.trustedCommands` in your personal policy. This explicitly authorizes the code those commands run, including future edits to scripts. A matching string is not an OS sandbox. Use this only for repositories/scripts you trust. Every other shell command still needs approval, including commands that can delete data, send messages, purchase, publish, or alter accounts/system state.

## Isolation limits

Shell children receive a small environment allowlist rather than inference credentials. Approved shell code still has your OS user's file/network permissions and can read files outside the repository, including credentials on disk. Filesystem checks cannot protect against concurrent malicious filesystem changes. Use an isolated account/container for untrusted projects. The optional Docker image does not by itself restrict network access.

[Back to README](../README.md)
