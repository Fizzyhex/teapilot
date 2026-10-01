import { readFileSync } from 'node:fs';
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSRuntime, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import { harness, maxSourceChars, parseResult, sdkPath, toJavaScript, type CallInput, type CallResult, type Method, type PlayEngine } from './engine.js';
import { PlayError } from './render.js';
import { checkAssetTexts, type AssetTexts } from './assets.js';

const sdkName = '@teapilot/discord-play';
const memoryBytes = 32 * 1024 * 1024;
const loadMs = 1000;
const callMs = 200;

let wasm: Promise<QuickJSWASMModule> | undefined;
/** QuickJS compiled to WebAssembly, loaded on first use, so Discord sessions that never run code never load it. */
export const quickjs = () => wasm ??= newQuickJSWASMModuleFromVariant(import('@jitl/quickjs-wasmfile-release-sync'));
let sdkSource: string | undefined;
const loadSdk = () => sdkSource ??= toJavaScript(readFileSync(sdkPath(), 'utf8'), 'discord-play.ts');
const sdkExports = () => [...loadSdk().matchAll(/^export (?:function|const) (\w+)/gm)].map(match => match[1]!);

/**
 * Runs model-written apps in QuickJS compiled to WebAssembly: no process, require, fetch, timers or
 * filesystem, and no imports but the SDK. Each app has its own runtime with a memory cap and a
 * deadline per call. After any failure the realm is rebuilt, so a half-finished call leaves nothing behind.
 */
class SandboxEngine implements PlayEngine {
  private realm?: { runtime: QuickJSRuntime; context: QuickJSContext };
  constructor(private readonly module: QuickJSWASMModule, private readonly code: string, private readonly assets: AssetTexts) {}

  load(): void {
    if (this.realm) return;
    const runtime = this.module.newRuntime();
    runtime.setMemoryLimit(memoryBytes);
    runtime.setMaxStackSize(512 * 1024);
    runtime.setModuleLoader(name => {
      if (name === sdkName) return loadSdk();
      if (name === 'app') return this.code;
      // Every SDK export is also a global, so an app that forgets an import still runs.
      if (name === 'prelude') return `import * as sdk from '${sdkName}';\nfor (const [key, value] of Object.entries(sdk)) if (!(key in globalThis)) globalThis[key] = value;`;
      return { error: new Error(`Sandboxed apps can import only "${sdkName}", not "${name}".`) };
    });
    const context = runtime.newContext();
    this.realm = { runtime, context };
    try {
      runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + loadMs));
      const result = context.evalCode(`import 'prelude';\nimport app from 'app';\n${harness(false, this.assets)}`, 'harness.js', { type: 'module' });
      if (result.error) { const error = context.dump(result.error); result.error.dispose(); throw new PlayError(`The app failed to load: ${message(error)}`); }
      result.value.dispose();
      const pending = runtime.executePendingJobs();
      if (pending.error) { const error = context.dump(pending.error); pending.error.dispose(); throw new PlayError(`The app failed to load: ${message(error)}`); }
    } catch (error) { this.dispose(); throw error; }
  }

  async call(method: Method, input: CallInput): Promise<CallResult> {
    this.load();
    const { runtime, context } = this.realm!;
    try {
      runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + callMs));
      const entry = context.getProp(context.global, '__play');
      const args = [context.newString(method), context.newString(JSON.stringify(input))];
      const result = context.callFunction(entry, context.undefined, ...args);
      entry.dispose(); for (const arg of args) arg.dispose();
      if (result.error) { const error = context.dump(result.error); result.error.dispose(); throw new PlayError(`${method}() threw: ${message(error)}`); }
      const output = context.dump(result.value); result.value.dispose();
      return parseResult(output);
    } catch (error) {
      this.dispose();
      if (error instanceof PlayError) throw error;
      throw new PlayError(`${method}() failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  dispose(): void {
    const realm = this.realm;
    this.realm = undefined;
    try { realm?.context.dispose(); realm?.runtime.dispose(); } catch { /* a realm that ran out of memory may not free cleanly */ }
  }
}

/** QuickJS errors dump as { name, message, stack }; interrupts mean the deadline passed. */
function message(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { name, message: text, stack } = error as { name?: string; message?: string; stack?: string };
    if (name === 'InternalError' && text === 'interrupted') return 'it ran too long (each call gets 200 ms; the app may be looping forever).';
    if (text === 'out of memory' || name === 'InternalError' && /memory/i.test(text ?? '')) return 'it ran out of memory (32 MB).';
    if (/export 'default'/.test(text ?? '')) return 'the app module must "export default app({ init, update, view })".';
    const missing = /Could not find export '([^']+)' in module '@teapilot\/discord-play'/.exec(text ?? '');
    if (missing) return `"${missing[1]}" is not part of @teapilot/discord-play. It exports ${sdkExports().join(', ')}.`;
    return `${name ?? 'Error'}: ${text ?? ''}${stack ? `\n${stack.trim().split('\n').slice(0, 4).join('\n')}` : ''}`;
  }
  return String(error);
}

/** Loads an app from TypeScript or JavaScript source; syntax and export mistakes surface here. */
export async function sandbox(source: string, assets: AssetTexts = {}): Promise<PlayEngine> {
  if (source.length > maxSourceChars) throw new PlayError(`The app source is ${source.length} characters; the limit is ${maxSourceChars}.`);
  checkAssetTexts(assets);
  const engine = new SandboxEngine(await quickjs(), toJavaScript(source), assets);
  engine.load();
  return engine;
}
