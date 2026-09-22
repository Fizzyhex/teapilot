# TeaPilot for Visual Studio Code

Use local models or configured cloud models in VS Code chat. Requires **VS Code 1.138+, Windows or Linux desktop, and Node.js 22.19+**. TeaPilot itself is bundled.

Run **TeaPilot: Setup** from the Command Palette. Reuse a personal TeaPilot profile or create a managed profile. The wizard can configure Ollama, an existing compatible endpoint, or paid inference. Ollama installation and model downloads require confirmation. Local setup needs no API key and never silently enables cloud fallback.

## Three ways to use TeaPilot

- **`@teapilot /ask`** answers questions using TeaPilot's configuration. **`@teapilot /code`** runs TeaPilot's coding agent in one selected folder. Follow-ups retain the workload and bounded conversation history. The chat model dropdown does not choose this agent's model.
- Enable **Ask TeaPilot** or **Code with TeaPilot** in the tools picker to delegate independent tasks from another agent. Delegation uses TeaPilot's separate configuration and budget.
- Choose **TeaPilot Auto**, **Local**, **Economy**, or **Strong** in the model picker to supply inference to VS Code's agent. VS Code executes tools and owns edit permissions in this mode. Fixed tiers never substitute another model. Auto can select an eligible tier and fall back only before output starts.

## Spending and approvals

Default limits are $1 per TeaPilot agent request **or model-provider call**, and $5 per UTC day. A VS Code agent task can make many model calls. The daily ledger is shared with CLI requests using the same state directory. Unknown charges stay conservatively reserved; separately operated web search and other agents' inference are not included.

Shell commands, expensive routes, and significant overwrites use TeaPilot's approvals. Tool-level confirmation does not approve all nested actions. Choose **View full action details** to inspect the complete action before deciding. Cancelling a request denies pending approvals; interrupted actions are never replayed automatically.

## Context and changes

Attach local text files or selections explicitly. Ask has no repository tools. Coding applies edits directly and requires unsaved files to be saved first. Use **TeaPilot: View Changes** for before/after diffs relative to the run's starting state, including your pre-existing edits. Review coverage excludes protected paths, binary files, text files above 1 MiB, and content beyond the 100 MiB run budget. It is not an undo or rollback facility. Approved shell commands run with your OS user's permissions; this is not an OS sandbox.

Chat history is managed by VS Code. Old complete turns may be omitted with notice when they do not fit; an oversized current request is rejected. Large VS Code agent prompts and tool sets may not fit smaller local models even when TeaPilot's own coding loop does. Increase configured server context or select a suitable larger model.

Web search is off by default. **TeaPilot: Toggle Web Search** enables configured SearXNG search for participant requests. Images, external tool attachments to the participant, remote/virtual workspaces, macOS, browser clients, and shared CLI sessions are unsupported.

## Configuration and privacy

Use **TeaPilot: Manage Models** to inspect model/policy configuration and set API keys. Managed-profile keys use VS Code SecretStorage and are not available to a separately launched CLI. Imported profile files are not rewritten by setup. Repository `.env` files are never discovered automatically.

Prompts and tool output are not written to TeaPilot's operational event log. Chat content remains in VS Code history. Private change snapshots are stored under the profile's TeaPilot state directory for seven days; **TeaPilot: Clear Change Review History** removes them. Hosted routing retains JevRouter receipts. **TeaPilot: View Spending** and **Show Diagnostics Output** provide local status; the extension adds no remote telemetry.

Only configured inference/routing/search providers receive request data. Local-only configuration makes no inference/routing cloud requests. VS Code service-backed features have their own requirements.

If Node is not on PATH, set the **user** setting `teapilot.nodePath` to its executable. Concurrent requests in one extension window queue. Another process holding the state lock returns a busy error; after a crash, follow TeaPilot's existing lock-recovery instructions and never delete the spend ledger.

## Development and release

From the repository root, run `npm ci`, then `npm ci --prefix extensions/vscode`. Run `npm run check`, `npm run typecheck --prefix extensions/vscode`, and `npm run package --prefix extensions/vscode`. Install `extensions/vscode/teapilot.vsix` through **Extensions: Install from VSIX**.

Run `npm test --prefix extensions/vscode` for isolated extension-host tests after packaging. The first Marketplace release is a manual upload of the verified VSIX to the `fizzyhex` publisher account. Building a VSIX does not verify account ownership or publish anything.

TeaPilot is licensed under Apache-2.0. Dependencies retain their own licenses; see THIRD_PARTY_NOTICES.md and the bundled dependency license files.
