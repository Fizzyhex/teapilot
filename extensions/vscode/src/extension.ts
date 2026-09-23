import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Client, requireSupported, supported, type WireEvent } from './client';

type Turn = { user: string; assistant: string };
type Context = { name: string; text: string; path?: string };
type Review = { id: string; root: string; changes: { path: string; index: number; kind: string }[]; skipped: string[] };
type Result = { requestId: string; success: boolean; status: string; text: string; spentUsd: number; check?: string; models?: string[]; review?: Review };
type Metadata = { workload?: 'ask' | 'coder'; root?: string; answer?: string; reviewId?: string };
type RunInput = { prompt: string; cwd: string; workload: 'ask' | 'coder'; web?: boolean; history?: Turn[]; context?: Context[] };
type DelegateInput = { task: string; context?: string; workspace?: string; web?: boolean };

export function encodeMessage(message: vscode.LanguageModelChatRequestMessage) {
  return {
    role: message.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant',
    content: message.content.map(part => {
      if (part instanceof vscode.LanguageModelTextPart) return { type: 'text', text: part.value };
      if (part instanceof vscode.LanguageModelToolCallPart) return { type: 'toolCall', id: part.callId, name: part.name, arguments: part.input };
      if (part instanceof vscode.LanguageModelToolResultPart) return { type: 'toolResult', id: part.callId, text: part.content.map(value => {
        if (!(value instanceof vscode.LanguageModelTextPart)) throw new Error('TeaPilot supports text tool results only');
        return value.value;
      }).join('\n') };
      throw new Error('TeaPilot supports text and tool calls/results; images and other content are unsupported.');
    }),
  };
}

export function conversation(history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[], root: string | undefined): Turn[] {
  const turns: Turn[] = []; let user: string | undefined;
  for (const turn of history) {
    if (turn instanceof vscode.ChatRequestTurn) user = turn.prompt;
    else {
      const metadata = turn.result.metadata as Metadata | undefined;
      if (metadata?.root !== root) { turns.length = 0; user = undefined; continue; }
      if (user && metadata?.answer) turns.push({ user, assistant: metadata.answer });
      user = undefined;
    }
  }
  return turns.slice(-100);
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('TeaPilot');
  const client = new Client(context, output);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.text = '$(coffee) TeaPilot'; status.command = 'teapilot.spending'; status.show();
  const changedModels = new vscode.EventEmitter<void>();
  let latestReview = context.workspaceState.get<string>('latestReview');
  const reviews = new Map<string, Review>();
  const reviewText = new Map<string, string>();
  context.subscriptions.push(output, client, status, changedModels);
  void vscode.commands.executeCommand('setContext', 'teapilot.supported', supported());
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { void vscode.commands.executeCommand('setContext', 'teapilot.supported', supported()); }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { void vscode.commands.executeCommand('setContext', 'teapilot.supported', supported()); changedModels.fire(); }));

  const record = (event: WireEvent) => {
    if (event.type === 'model_selection' || event.type === 'attempt_start') {
      status.text = `$(coffee) TeaPilot · ${event.model}`;
      output.appendLine(`Model: ${event.model}; tier: ${event.tier}`);
    } else if (event.type === 'usage') output.appendLine(`Accounted $${Number(event.chargedUsd).toFixed(6)} (${event.basis}).`);
    else if (event.type === 'request_end') status.tooltip = `${event.status ?? (event.success ? 'completed' : 'incomplete')}; accounted $${Number(event.spentUsd ?? 0).toFixed(6)}. Model-provider caps apply per call, not per agent task.`;
    else if (event.type === 'progress') output.appendLine(String(event.text));
    else if (event.type === 'review') {
      const review = event.review as Review;
      reviews.set(review.id, review); latestReview = review.id;
      void context.workspaceState.update('latestReview', review.id);
    }
  };
  const folder = async (identifier?: string, previous?: string) => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (identifier) {
      const matches = folders.filter(f => f.uri.fsPath === identifier || f.name === identifier);
      if (matches.length !== 1) throw new Error('Specify the absolute path of one open workspace folder.');
      return matches[0]!;
    }
    const old = folders.find(f => f.uri.fsPath === previous);
    if (old) return old;
    if (folders.length === 1) return folders[0]!;
    if (!folders.length) throw new Error('Open a local workspace folder for coding or file attachments.');
    const choice = await vscode.window.showQuickPick(folders.map(f => ({ label: f.name, description: f.uri.fsPath, folder: f })), { title: 'TeaPilot working folder' });
    if (!choice) throw new vscode.CancellationError();
    return choice.folder;
  };
  const saved = async (root: string) => {
    const dirty = vscode.workspace.textDocuments.filter(d => d.isDirty && vscode.workspace.getWorkspaceFolder(d.uri)?.uri.fsPath === root);
    if (!dirty.length) return;
    const choice = await vscode.window.showWarningMessage('Save unsaved files before TeaPilot edits this folder?', { modal: true }, 'Save Files');
    if (choice !== 'Save Files') throw new vscode.CancellationError();
    if ((await Promise.all(dirty.map(d => d.save()))).some(ok => !ok)) throw new Error('Some files could not be saved.');
  };
  const run = async (input: RunInput, token: vscode.CancellationToken, stream?: vscode.ChatResponseStream): Promise<Result> => {
    requireSupported();
    if (input.workload === 'coder') await saved(input.cwd);
    let review: Review | undefined; let streamed = false;
    const result = await client.request<Result>('run', { ...input, review: input.workload === 'coder' }, token, event => {
      record(event);
      if (event.type === 'text') { streamed = true; stream?.markdown(String(event.text)); }
      else if (event.type === 'message_end') stream?.markdown('\n\n');
      else if (event.type === 'attempt_start') { streamed = false; stream?.progress(`Using ${event.model} (${event.tier}), attempt ${event.attempt}.`); }
      else if (event.type === 'attempt_end' && !event.success) stream?.markdown(`\n\n*Attempt stopped: ${event.stopped ?? event.reason ?? 'incomplete'}.*\n\n`);
      else if (event.type === 'progress') stream?.progress(String(event.text));
      else if (event.type === 'history_omitted') stream?.progress(`Omitted ${event.turns} older turns to fit the context budget.`);
      else if (event.type === 'tool_execution_start') stream?.progress(`Running ${event.tool}…`);
      else if (event.type === 'review') review = event.review;
    });
    if (!streamed) stream?.markdown(result.text);
    const summary = `${result.status}; checks: ${result.check ?? 'not observed'}; accounted $${result.spentUsd.toFixed(6)}; models: ${result.models?.join(', ') ?? 'none'}.`;
    stream?.markdown(`\n\n${summary}`); output.appendLine(summary);
    status.tooltip = `${summary}\nModel-provider limits apply per call, not per agent task.`;
    if (review) {
      stream?.markdown(`\n\n${review.changes.length} changed files.${review.skipped.length ? ` ${review.skipped.length} files or areas outside snapshot coverage.` : ''}`);
      for (const change of review.changes.slice(0, 50)) stream?.reference(vscode.Uri.file(join(review.root, change.path)));
      stream?.button({ command: 'teapilot.changes', title: 'Review Changes', arguments: [review.id] });
    }
    return { ...result, review };
  };
  const attachments = async (references: readonly vscode.ChatPromptReference[], root: string, token: vscode.CancellationToken): Promise<Context[]> => {
    const values: Context[] = [];
    for (const reference of references) {
      if (typeof reference.value === 'string') { values.push({ name: reference.id, text: reference.value }); continue; }
      const value = reference.value;
      const uri = value instanceof vscode.Uri ? value : value instanceof vscode.Location ? value.uri : undefined;
      if (!uri || uri.scheme !== 'file') throw new Error('Attach text or a local text file/selection. Images and other references are unsupported.');
      if (/\.(png|jpe?g|gif|webp|bmp|ico|pdf)$/i.test(uri.path)) throw new Error('TeaPilot accepts text attachments only.');
      await client.request('validatePath', { cwd: root, path: uri.fsPath }, token);
      const document = await vscode.workspace.openTextDocument(uri);
      values.push({ name: reference.id, path: uri.fsPath, text: document.getText(value instanceof vscode.Location ? value.range : undefined) });
    }
    return values;
  };
  const participant = vscode.chat.createChatParticipant('teapilot.chat', async (request, chat, stream, token) => {
    try {
      requireSupported();
      if (request.toolReferences.length) throw new Error('TeaPilot uses its own tools. External tool attachments are unsupported; attach their text results instead.');
      const previous = [...chat.history].reverse().find(t => t instanceof vscode.ChatResponseTurn) as vscode.ChatResponseTurn | undefined;
      const metadata = previous?.result.metadata as Metadata | undefined;
      const workload = request.command === 'code' ? 'coder' : request.command === 'ask' ? 'ask' : metadata?.workload ?? 'ask';
      const needsFolder = workload === 'coder' || request.references.some(r => typeof r.value !== 'string');
      const root = needsFolder ? (await folder(undefined, request.command === 'code' ? undefined : metadata?.root)).uri.fsPath : metadata?.root;
      const cwd = root ?? homedir();
      const result = await run({ prompt: request.prompt, cwd, workload, web: vscode.workspace.getConfiguration('teapilot').get('webSearch.enabled', false), history: conversation(chat.history, root), context: await attachments(request.references, cwd, token) }, token, stream);
      return { metadata: { workload, root, answer: result.text.slice(-20_000), reviewId: result.review?.id, requestId: result.requestId } };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'TeaPilot failed';
      stream.markdown(`\n\n${message}`);
      return { errorDetails: { message } };
    }
  });
  participant.iconPath = new vscode.ThemeIcon('coffee');
  context.subscriptions.push(participant);

  for (const workload of ['ask', 'coder'] as const) {
    context.subscriptions.push(vscode.lm.registerTool<DelegateInput>(workload === 'ask' ? 'teapilot_ask' : 'teapilot_code', {
      prepareInvocation(options) {
        requireSupported();
        return { invocationMessage: `Delegating to TeaPilot (${workload})`, confirmationMessages: { title: 'Delegate to TeaPilot?', message: new vscode.MarkdownString(`${workload === 'coder' ? 'TeaPilot applies file edits directly and requests shell approvals.' : 'TeaPilot receives the supplied text context.'} It uses separately configured models and budgets.\n\n${options.input.task}`) } };
      },
      async invoke(options, token) {
        const input = options.input;
        const cwd = workload === 'coder' ? (await folder(input.workspace)).uri.fsPath : homedir();
        const result = await run({ prompt: input.task, cwd, workload, web: input.web ?? false, context: input.context ? [{ name: 'Delegated context', text: input.context }] : [] }, token);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ ...result, text: result.text.slice(-12_000), review: result.review ? { id: result.review.id, changes: result.review.changes.slice(0, 100), skippedCount: result.review.skipped.length } : undefined }))]);
      },
    }));
  }

  const provider: vscode.LanguageModelChatProvider = {
    onDidChangeLanguageModelChatInformation: changedModels.event,
    async provideLanguageModelChatInformation(options, token) {
      if (!supported()) return [];
      if (!existsSync(join(client.profile().directory, '.env'))) {
        if (!options.silent) void vscode.window.showInformationMessage('Run TeaPilot: Setup to configure local or cloud models.');
        return [];
      }
      try { return await client.request('models', {}, token); }
      catch (error) { if (!options.silent) throw error; return []; }
    },
    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
      const request = { model: model.id, messages: messages.map(encodeMessage), tools: (options.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema ?? { type: 'object', properties: {} } })), toolMode: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto' };
      const result = await client.request('inference', request, token, event => {
        record(event);
        if (event.type === 'text') progress.report(new vscode.LanguageModelTextPart(event.text));
        if (event.type === 'tool_call') progress.report(new vscode.LanguageModelToolCallPart(event.id, event.name, event.arguments));
      });
      if (result.status === 'length') throw new Error('TeaPilot model reached its output limit; the response is incomplete.');
    },
    async provideTokenCount(_model, value) {
      return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(encodeMessage(value)), 'utf8') + 128;
    },
  };
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('teapilot', provider));
  const command = (name: string, handler: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(name, async (...args) => {
    try { return await handler(...args); } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'TeaPilot failed'); }
  }));
  command('teapilot.setup', async () => {
    requireSupported();
    const personal = join(homedir(), '.teapilot', 'config');
    const choice = await vscode.window.showQuickPick(['Reuse an existing profile', 'Create or update VS Code-managed profile'], { title: 'TeaPilot setup' });
    if (!choice) return;
    if (choice.startsWith('Reuse')) {
      const selected = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.Uri.file(personal), openLabel: 'Use TeaPilot profile' });
      if (!selected?.[0]) return;
      if (!existsSync(join(selected[0].fsPath, '.env'))) throw new Error('Select a TeaPilot profile directory containing .env.');
      await client.setProfile({ directory: selected[0].fsPath, managed: false });
    } else {
      await client.setProfile({ directory: join(context.globalStorageUri.fsPath, 'profile'), managed: true });
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'TeaPilot setup', cancellable: true }, async (progress, token) => client.request('setup', {}, token, event => { record(event); if (event.type === 'progress') progress.report({ message: event.text }); }));
    }
    changedModels.fire();
  });
  command('teapilot.doctor', async () => {
    const choice = await vscode.window.showQuickPick(['Configuration checks', 'Live model and coding checks'], { title: 'TeaPilot diagnostics' });
    if (!choice) return;
    output.show();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'TeaPilot diagnostics', cancellable: true }, (_progress, token) => client.request('doctor', { live: choice.startsWith('Live') }, token, record));
    changedModels.fire();
  });
  command('teapilot.manageModels', async () => {
    const choice = await vscode.window.showQuickPick(['Setup or change profile', 'Open model configuration', 'Open policy configuration', 'Set API key'], { title: 'TeaPilot model management' });
    if (!choice) return;
    if (choice.startsWith('Setup')) return vscode.commands.executeCommand('teapilot.setup');
    const info = await client.request('configuration');
    if (choice === 'Set API key') {
      const entries = Object.entries(info.models as Record<string, { id: string; apiKeyEnv: string }>);
      const tier = await vscode.window.showQuickPick(entries.map(([tier, model]) => ({ label: tier, description: model.id, key: model.apiKeyEnv })), { title: 'Credential to set' });
      if (!tier) return;
      const key = await vscode.window.showInputBox({ prompt: 'API key (stored in VS Code SecretStorage; not available to the CLI)', password: true, ignoreFocusOut: true });
      if (!key) return;
      const profile = client.profile();
      const credentials = JSON.parse(await context.secrets.get(`profile:${profile.directory}`) ?? '{}'); credentials[tier.key] = key;
      await context.secrets.store(`profile:${profile.directory}`, JSON.stringify(credentials));
      await client.setProfile(profile); changedModels.fire();
    } else {
      await vscode.window.showTextDocument(vscode.Uri.file(choice === 'Open model configuration' ? info.modelsFile : info.policyFile));
    }
  });
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => changedModels.fire()));
  command('teapilot.toggleWeb', async () => {
    const settings = vscode.workspace.getConfiguration('teapilot');
    const enabled = !settings.get('webSearch.enabled', false);
    await settings.update('webSearch.enabled', enabled, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`TeaPilot web search ${enabled ? 'enabled (requires configured SearXNG)' : 'disabled'}.`);
  });
  command('teapilot.askSelection', async () => {
    const editor = vscode.window.activeTextEditor; if (!editor || editor.selection.isEmpty) return;
    const root = vscode.workspace.getWorkspaceFolder(editor.document.uri); if (!root) throw new Error('Selection must be in an open workspace folder.');
    await client.request('validatePath', { cwd: root.uri.fsPath, path: editor.document.uri.fsPath });
    const selection = editor.document.getText(editor.selection);
    if (selection.length > 10_000) throw new Error('Select at most 10,000 characters.');
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: `@teapilot /ask Explain this selection from ${editor.document.fileName}:\n\n${selection}`, isPartialQuery: true });
  });
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('teapilot-review', { provideTextDocumentContent: async uri => {
    if (reviewText.has(uri.toString())) return reviewText.get(uri.toString())!;
    const [id, index, side] = uri.path.split('/').filter(Boolean);
    if (!id || !/^\d+$/.test(index ?? '') || !['before', 'after'].includes(side ?? '')) throw new Error('Invalid review URI');
    const text = await client.request<string>('review', { id, index: Number(index), side }); reviewText.set(uri.toString(), text); return text;
  } }));
  command('teapilot.changes', async (id?: string) => {
    id ??= latestReview; if (!id) throw new Error('No TeaPilot change review is available.');
    const review = reviews.get(id) ?? await client.request<Review>('review', { id });
    const change = await vscode.window.showQuickPick(review.changes.map(c => ({ label: c.path, description: c.kind, index: c.index })), { title: `TeaPilot changes (${review.skipped.length} outside coverage)` });
    if (!change) return;
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.parse(`teapilot-review:/${id}/${change.index}/before`), vscode.Uri.parse(`teapilot-review:/${id}/${change.index}/after`), `TeaPilot: ${change.label}`);
  });
  command('teapilot.clearReviews', async () => {
    await client.request('clearReviews'); reviews.clear(); reviewText.clear(); latestReview = undefined; await context.workspaceState.update('latestReview', undefined);
  });
  command('teapilot.spending', async () => {
    const spending = await client.request('spending');
    void vscode.window.showInformationMessage(`TeaPilot accounted today: $${spending.daily.toFixed(6)} / $${spending.limits.dailyUsd}. Agent request / model call cap: $${spending.limits.requestUsd}. A VS Code agent task can make multiple calls.`);
  });
  command('teapilot.logs', () => output.show());
  return { client, provider, run, participant };
}
