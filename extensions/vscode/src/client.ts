import * as vscode from 'vscode';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

export interface WireEvent { type: string; [key: string]: any }
export interface Profile { directory: string; managed: boolean }
interface Pending { resolve(value: any): void; reject(error: Error): void; event(event: WireEvent): Promise<void> | void; token: vscode.CancellationToken; events: Promise<void>; error?: Error }
const never = new vscode.CancellationTokenSource().token;
const exec = promisify(execFile);

export function supported(): boolean {
  return vscode.workspace.isTrusted && !vscode.env.remoteName && ['win32', 'linux'].includes(process.platform)
    && !(vscode.workspace.workspaceFolders ?? []).some(folder => folder.uri.scheme !== 'file');
}
export function requireSupported() {
  if (!supported()) throw new Error('TeaPilot requires a trusted Windows/Linux desktop workspace. Remote and virtual workspaces are not supported.');
}

export class Client implements vscode.Disposable {
  private child?: ChildProcessWithoutNullStreams;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Pending>();
  private queued = 0;
  private stopped = false;
  private profileUsed?: string;
  constructor(readonly context: vscode.ExtensionContext, readonly output: vscode.OutputChannel) {}
  profile(): Profile {
    const saved = this.context.globalState.get<Profile>('profile');
    if (saved) return saved;
    const personal = join(homedir(), '.teapilot', 'config');
    return existsSync(join(personal, '.env')) ? { directory: personal, managed: false } : { directory: join(this.context.globalStorageUri.fsPath, 'profile'), managed: true };
  }
  async setProfile(profile: Profile) {
    if (this.queued) throw new Error('Wait for active TeaPilot requests before changing profiles.');
    await this.context.globalState.update('profile', profile); this.stopChild();
  }
  private send(value: unknown) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('TeaPilot host is unavailable');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  private stopChild() { this.child?.stdin.end(); this.child = undefined; this.profileUsed = undefined; }
  private async start() {
    if (this.stopped) throw new Error('TeaPilot extension is stopped');
    const profile = this.profile();
    if (this.child && this.profileUsed === profile.directory) return;
    this.stopChild();
    const node = vscode.workspace.getConfiguration('teapilot').inspect<string>('nodePath')?.globalValue ?? 'node';
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    let version: string;
    try { version = (await exec(node, ['--version'], { env, windowsHide: true, timeout: 5000 })).stdout.trim(); }
    catch { throw new Error('Install Node.js >=22.19, or set the user setting teapilot.nodePath to its executable, then retry.'); }
    const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
    if (major < 22 || major === 22 && minor < 19) throw new Error(`TeaPilot needs Node >=22.19; found ${version}.`);
    const executable = join(this.context.extensionPath, 'runtime', 'node_modules', 'teapilot', 'dist', 'cli.js');
    const child = spawn(node, [executable, 'serve', '--stdio'], { env, cwd: this.context.extensionPath, windowsHide: true, stdio: 'pipe' });
    this.child = child; this.profileUsed = profile.directory;
    let buffer = ''; const decoder = new StringDecoder('utf8');
    const fail = () => {
      for (const pending of this.pending.values()) pending.reject(new Error('TeaPilot host stopped. Interrupted actions are not replayed; inspect changes and retry.'));
      this.pending.clear(); if (this.child === child) { this.child = undefined; this.profileUsed = undefined; }
    };
    child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
    child.stderr.on('data', () => { this.output.appendLine('TeaPilot host wrote a diagnostic to stderr (content withheld).'); });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (buffer.length > 10 * 1024 * 1024) { fail(); child.stdin.end(); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (value.version !== 1 || typeof value.id !== 'string') throw new Error('Protocol mismatch');
          const pending = this.pending.get(value.id); if (!pending) continue;
          if (value.event && typeof value.event.type === 'string') {
            // Interaction replies must not wait behind a long-running UI callback.
            pending.events = pending.events.then(async () => {
              if (value.event.type === 'interaction') await this.interact(value.id, value.event, pending);
              else await pending.event(value.event);
            }).catch(error => { pending.error = error; this.send({ version: 1, id: value.id, method: 'cancel' }); });
          } else {
            this.pending.delete(value.id);
            void pending.events.then(() => pending.error ? pending.reject(pending.error) : value.error ? pending.reject(new Error(String(value.error))) : pending.resolve(value.result));
          }
        } catch { fail(); child.stdin.end(); return; }
      }
    });
    const secrets = JSON.parse(await this.context.secrets.get(`profile:${profile.directory}`) ?? '{}');
    const hello = await this.raw('initialize', { configDir: profile.directory, managed: profile.managed, secrets }, never, () => {});
    if (hello.protocolVersion !== 1) throw new Error('TeaPilot runtime protocol mismatch; reinstall the extension.');
  }
  private async interact(id: string, event: WireEvent, pending: Pending) {
    let value: unknown = false;
    if (!pending.token.isCancellationRequested) {
      if (event.kind === 'checkpoint') {
        value = supported() && !vscode.workspace.textDocuments.some(document => document.isDirty && Boolean(vscode.workspace.getWorkspaceFolder(document.uri)));
      } else if (event.kind === 'credentials_save') {
        await this.context.secrets.store(`profile:${this.profile().directory}`, JSON.stringify(event.credentials)); value = true;
      } else if (event.kind === 'input') {
        value = await vscode.window.showInputBox({ prompt: event.message, value: event.fallback, password: event.secret, ignoreFocusOut: true }, pending.token);
      } else if (event.kind === 'choose') {
        const choice = await vscode.window.showQuickPick((event.choices as string[]).map((label, index) => ({ label, index })), { title: event.message, ignoreFocusOut: true }, pending.token);
        value = choice?.index;
      } else if (event.kind === 'approval') {
        // QuickPick supports cancellation and closes immediately when the run stops.
        for (;;) {
          const choice = await vscode.window.showQuickPick([{ label: 'Deny', approved: false }, { label: 'Approve', detail: event.details, approved: true }, { label: 'View full action details', approved: false }], { title: event.summary, placeHolder: event.details, ignoreFocusOut: true }, pending.token);
          if (choice?.label === 'View full action details') {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: `${event.summary}\n\n${event.details ?? ''}`, language: 'plaintext' }));
            continue;
          }
          value = choice?.approved === true; break;
        }
      }
    }
    this.send({ version: 1, id, method: 'respond', params: { interactionId: event.interactionId, value: value ?? false } });
  }
  private raw(method: string, params: unknown, token: vscode.CancellationToken, event: Pending['event']): Promise<any> {
    const id = randomUUID();
    return new Promise((resolvePromise, reject) => {
      const cancel = token.onCancellationRequested(() => { try { this.send({ version: 1, id, method: 'cancel' }); } catch {} });
      this.pending.set(id, { resolve: value => { cancel.dispose(); resolvePromise(value); }, reject: error => { cancel.dispose(); reject(error); }, event, token, events: Promise.resolve() });
      try { this.send({ version: 1, id, method, params }); } catch (error) { this.pending.delete(id); cancel.dispose(); reject(error); }
    });
  }
  request<T = any>(method: string, params: unknown = {}, token = never, event: Pending['event'] = () => {}): Promise<T> {
    requireSupported();
    if (this.queued++) void event({ type: 'progress', text: 'Queued behind another TeaPilot request.' });
    const next = this.tail.catch(() => {}).then(async () => {
      try {
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        requireSupported(); await this.start();
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        return await this.raw(method, params, token, event);
      } finally { this.queued--; }
    });
    this.tail = next.catch(() => {});
    return new Promise<T>((resolvePromise, reject) => {
      const cancel = token.onCancellationRequested(() => reject(new vscode.CancellationError()));
      if (token.isCancellationRequested) { cancel.dispose(); reject(new vscode.CancellationError()); }
      void next.then(resolvePromise, reject).finally(() => cancel.dispose());
    });
  }
  dispose() {
    this.stopped = true;
    for (const id of this.pending.keys()) { try { this.send({ version: 1, id, method: 'cancel' }); } catch {} }
    this.stopChild();
  }
}
