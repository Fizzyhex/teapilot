import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten-core';
import { shouldInterruptAfterDeadline } from 'quickjs-emscripten-core';
import { maxFileBytes } from './files.js';
import { canvasLibrary, formatOf, percent } from './images.js';
import { toJavaScript } from './play/engine.js';
import { quickjs } from './play/sandbox.js';

/** A mistake in an image script, written for the model that wrote it. */
export class ScriptError extends Error {}

export const scriptLimits = { side: 4096, objects: 64, saves: 5, runMs: 15_000, memoryBytes: 256 * 1024 * 1024, logChars: 2000 };

// The CanvasRenderingContext2D surface scripts get; everything else on the native objects stays out of reach.
const contextMethods = ['arc', 'arcTo', 'beginPath', 'bezierCurveTo', 'clearRect', 'clip', 'closePath', 'createConicGradient', 'createLinearGradient', 'createPattern', 'createRadialGradient', 'drawImage', 'ellipse', 'fill', 'fillRect', 'fillText', 'getLineDash', 'getTransform', 'isPointInPath', 'isPointInStroke', 'lineTo', 'measureText', 'moveTo', 'quadraticCurveTo', 'rect', 'reset', 'resetTransform', 'restore', 'rotate', 'roundRect', 'save', 'scale', 'setLineDash', 'setTransform', 'stroke', 'strokeRect', 'strokeText', 'transform', 'translate'];
const contextProperties = ['direction', 'fillStyle', 'filter', 'font', 'fontKerning', 'fontStretch', 'fontVariantCaps', 'globalAlpha', 'globalCompositeOperation', 'imageSmoothingEnabled', 'imageSmoothingQuality', 'letterSpacing', 'lineCap', 'lineDashOffset', 'lineJoin', 'lineWidth', 'miterLimit', 'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY', 'strokeStyle', 'textAlign', 'textBaseline', 'textRendering', 'wordSpacing'];
const pathMethods = ['addPath', 'arc', 'arcTo', 'bezierCurveTo', 'closePath', 'ellipse', 'lineTo', 'moveTo', 'quadraticCurveTo', 'rect', 'roundRect'];
const methods: Record<string, string[]> = { context: contextMethods, path: pathMethods, gradient: ['addColorStop'], pattern: ['setTransform'] };

/** Runs inside QuickJS: the canvas API as scripts know it from node-canvas, backed by handles into the host. */
const shim = `
const handles = new Map();
const raw = (op, ...args) => JSON.parse(__host(op, JSON.stringify(args.map(encode))));
const host = (op, ...args) => decode(raw(op, ...args));
function encode(value) {
  if (value && typeof value === 'object') {
    if (typeof value.__h === 'number') return { $h: value.__h };
    if (ArrayBuffer.isView(value)) throw new TypeError('Pixel data goes only to putImageData().');
    if (Array.isArray(value)) return value.map(encode);
    const plain = {}; for (const key of Object.keys(value)) plain[key] = encode(value[key]); return plain;
  }
  return value;
}
function decode(value) {
  if (value && typeof value === 'object') {
    if (typeof value.$h === 'number') return handles.get(value.$h) ?? adopt(value);
    if (Array.isArray(value)) return value.map(decode);
  }
  return value;
}
class Handle { constructor(id) { Object.defineProperty(this, '__h', { value: id }); handles.set(id, this); } }
const kinds = { gradient: class CanvasGradient extends Handle {}, pattern: class CanvasPattern extends Handle {} };
function adopt({ $h, kind }) { return new (kinds[kind] ?? Handle)($h); }
const call = (target, name, args) => host('call', target.__h, name, args);
for (const [kind, names] of Object.entries(${JSON.stringify({ gradient: methods.gradient, pattern: methods.pattern })})) for (const name of names) kinds[kind].prototype[name] = function (...args) { return call(this, name, args); };

class Image extends Handle {
  constructor(id = raw('blank').id) { super(id); }
  set src(name) { const { width, height } = raw('image', this.__h, String(name)); Object.defineProperty(this, 'width', { value: width, configurable: true }); Object.defineProperty(this, 'height', { value: height, configurable: true }); }
  get naturalWidth() { return this.width; }
  get naturalHeight() { return this.height; }
  get complete() { return true; }
}
function loadImage(name) { const image = new Image(); image.src = name; return image; }

class ImageData {
  constructor(a, b, c) {
    if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
    else { this.data = a instanceof Uint8ClampedArray ? a : new Uint8ClampedArray(a); this.width = b; this.height = c ?? (this.data.length / 4 / b); }
    this.colorSpace = 'srgb';
  }
}

class Path2D extends Handle { constructor(from) { super(raw('path', from === undefined ? null : from instanceof Path2D ? from : String(from)).id); } }
for (const name of ${JSON.stringify(pathMethods)}) Path2D.prototype[name] = function (...args) { return call(this, name, args); };

class CanvasRenderingContext2D extends Handle {
  constructor(id, canvas) { super(id); Object.defineProperty(this, 'canvas', { value: canvas }); }
  getImageData(x, y, width, height) {
    const w = Math.trunc(width), h = Math.trunc(height);
    return new ImageData(new Uint8ClampedArray(__pixels(this.__h, x, y, w, h)), w, h);
  }
  putImageData(image, x, y, ...dirty) {
    const data = image.data;
    __put(this.__h, data.byteOffset || data.byteLength !== data.buffer.byteLength ? data.slice().buffer : data.buffer, image.width, image.height, x, y, ...dirty);
  }
  createImageData(a, b) { return typeof a === 'number' ? new ImageData(a, b) : new ImageData(a.width, a.height); }
}
for (const name of ${JSON.stringify(contextMethods)}) CanvasRenderingContext2D.prototype[name] = function (...args) { return call(this, name, args); };
for (const name of ${JSON.stringify(contextProperties)}) Object.defineProperty(CanvasRenderingContext2D.prototype, name, {
  get() { return host('get', this.__h, name); }, set(value) { host('set', this.__h, name, value); },
});

const keep = 'Keep an image with save(canvas, "name.png"): its extension picks png, jpg or webp, and { quality } sets jpg or webp quality.';
class Canvas extends Handle {
  constructor(width, height) { super(raw('canvas', width, height).id); this.__size = [Math.trunc(width), Math.trunc(height)]; }
  get width() { return this.__size[0]; }
  set width(value) { raw('resize', this.__h, value, this.__size[1]); this.__size = [Math.trunc(value), this.__size[1]]; this.__context = undefined; }
  get height() { return this.__size[1]; }
  set height(value) { raw('resize', this.__h, this.__size[0], value); this.__size = [this.__size[0], Math.trunc(value)]; this.__context = undefined; }
  getContext(type = '2d') {
    if (type !== '2d') throw new TypeError('Only getContext("2d") is available.');
    return this.__context ??= new CanvasRenderingContext2D(raw('context', this.__h).id, this);
  }
  toBuffer() { throw new TypeError(keep); }
  toDataURL() { throw new TypeError(keep); }
  encode() { throw new TypeError(keep); }
}
function createCanvas(width, height) { return new Canvas(width, height); }
function save(canvas, name, options = {}) {
  if (typeof canvas === 'string') [canvas, name] = [name, canvas];
  if (!(canvas instanceof Canvas)) throw new TypeError('save(canvas, name, options?) takes a canvas from createCanvas().');
  return raw('save', canvas.__h, String(name), options);
}
const console = { log: (...parts) => { __host('log', JSON.stringify([parts.map(part => typeof part === 'string' ? part : JSON.stringify(part)).join(' ')])); } };
Object.assign(globalThis, { Image, ImageData, Path2D, Canvas, CanvasRenderingContext2D, loadImage, createCanvas, save, console });
export { Image, ImageData, Path2D, Canvas, loadImage, createCanvas, save };
`;

interface Entry { kind: 'image' | 'canvas' | 'context' | 'gradient' | 'pattern' | 'path'; value: any; canvas?: number }
export interface ScriptFiles { read(name: string): Buffer | undefined; names(): string[] }
export interface ScriptResult { saved: Array<{ name: string; data: Buffer; width: number; height: number }>; logs: string }

/**
 * Runs an image script in QuickJS with a node-canvas style API. The script reaches images only by name
 * through `files`, and keeps what it makes only through save(); pixels, fonts and drawing run natively.
 */
export async function runImageScript(code: string, files: ScriptFiles): Promise<ScriptResult> {
  const library = await canvasLibrary();
  let source: string;
  try { source = toJavaScript(code, 'script.ts'); } catch (error) { throw new ScriptError((error instanceof Error ? error.message : String(error)).replace("the app's", "the script's")); }
  // Pixels decode asynchronously, and scripts run synchronously: decode each image the script names first.
  const images = new Map<string, InstanceType<typeof library.Image>>();
  for (const name of files.names().filter(name => source.includes(name))) {
    const data = files.read(name);
    if (data) images.set(name, await library.loadImage(data).catch(() => undefined as never));
  }
  const module = await quickjs();
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(scriptLimits.memoryBytes);
  runtime.setMaxStackSize(1024 * 1024);
  const entries = new Map<number, Entry>();
  const ids = new Map<unknown, number>();
  let next = 1, logs = '';
  const saved: ScriptResult['saved'] = [];
  const register = (entry: Entry) => {
    if (entries.size >= scriptLimits.objects) throw new ScriptError(`A script may make at most ${scriptLimits.objects} images, canvases, gradients and paths.`);
    const id = next++;
    entries.set(id, entry); ids.set(entry.value, id);
    return id;
  };
  const entry = (id: unknown, ...kinds: Entry['kind'][]) => {
    const found = typeof id === 'number' ? entries.get(id) : undefined;
    if (!found || (kinds.length && !kinds.includes(found.kind))) throw new ScriptError(`Expected ${kinds.join(' or ')}.`);
    return found;
  };
  /** Arguments from the script: handles become the native objects they stand for. */
  const resolve = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === 'object') {
      if ('$h' in value) {
        const found = entry((value as { $h: unknown }).$h);
        if (found.kind === 'context') throw new ScriptError('Pass a canvas, not its context.');
        return found.value;
      }
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, resolve(inner)]));
    }
    return value;
  };
  /** Results for the script: native objects become handles, everything else plain JSON. */
  const expose = (value: unknown): unknown => {
    if (value === undefined || value === null || typeof value !== 'object') return value ?? null;
    if (Array.isArray(value)) return value.map(expose);
    const known = ids.get(value);
    if (known !== undefined) return { $h: known, kind: entries.get(known)!.kind };
    const name = value.constructor?.name;
    if (name === 'CanvasGradient') return { $h: register({ kind: 'gradient', value }), kind: 'gradient' };
    if (name === 'CanvasPattern') return { $h: register({ kind: 'pattern', value }), kind: 'pattern' };
    // TextMetrics, DOMMatrix and the like: their numbers are what scripts read.
    const plain: Record<string, unknown> = {};
    for (const key in value) { const field = (value as Record<string, unknown>)[key]; if (typeof field !== 'function') plain[key] = expose(field); }
    return plain;
  };
  const side = (value: unknown, what: string) => {
    const number = Math.trunc(Number(value));
    if (!Number.isFinite(number) || number < 1 || number > scriptLimits.side) throw new ScriptError(`${what} must be 1–${scriptLimits.side} pixels, not ${String(value)}.`);
    return number;
  };
  const operations: Record<string, (...args: any[]) => unknown> = {
    blank: () => ({ id: register({ kind: 'image', value: undefined }) }),
    image(id: number, name: string) {
      if (!files.names().includes(name)) throw new ScriptError(`No file named ${JSON.stringify(name)}. Files here: ${files.names().join(', ') || 'none'}.`);
      if (!images.has(name)) throw new ScriptError(`Write the file name as a plain string in the script, as in loadImage(${JSON.stringify(name)}), so it is ready before the script runs.`);
      const image = images.get(name);
      if (!image?.width) throw new ScriptError(`${name} is not an image this can read (png, jpg, webp, gif or bmp).`);
      const found = entry(id, 'image');
      ids.delete(found.value); found.value = image; ids.set(image, id);
      return { width: image.width, height: image.height };
    },
    canvas: (width: unknown, height: unknown) => ({ id: register({ kind: 'canvas', value: library.createCanvas(side(width, 'Canvas width'), side(height, 'Canvas height')) }) }),
    resize(id: number, width: unknown, height: unknown) {
      const canvas = entry(id, 'canvas').value;
      canvas.width = side(width, 'Canvas width'); canvas.height = side(height, 'Canvas height');
      return null;
    },
    context: (id: number) => ({ id: register({ kind: 'context', value: entry(id, 'canvas').value.getContext('2d'), canvas: id }) }),
    path: (from: unknown) => ({ id: register({ kind: 'path', value: new library.Path2D(resolve(from) as never ?? undefined) }) }),
    call(id: number, name: string, args: unknown[]) {
      const found = entry(id);
      if (!methods[found.kind]?.includes(name)) throw new ScriptError(`${name}() is not available here.`);
      const decoded = resolve(args) as unknown[];
      if (found.kind === 'context' && name === 'drawImage' && decoded[0] === undefined) throw new ScriptError('drawImage() needs an image from loadImage() or a canvas.');
      return expose(found.value[name](...decoded));
    },
    get(id: number, name: string) {
      if (!contextProperties.includes(name)) throw new ScriptError(`${name} is not available here.`);
      return expose(entry(id, 'context').value[name]);
    },
    set(id: number, name: string, value: unknown) {
      if (!contextProperties.includes(name)) throw new ScriptError(`${name} is not available here.`);
      entry(id, 'context').value[name] = resolve(value);
      return null;
    },
    save(id: number, name: string, options: { quality?: number; format?: string } | null) {
      const canvas = entry(id, 'canvas').value;
      const format = formatOf(name) ?? formatOf(`.${String(options?.format ?? '').replace('image/', '')}`);
      if (!format) throw new ScriptError(`save() name ${JSON.stringify(name)} must end in .png, .jpg or .webp.`);
      if (saved.length >= scriptLimits.saves && !saved.some(entry => entry.name === name)) throw new ScriptError(`A script may save at most ${scriptLimits.saves} images.`);
      const data = format === 'png' ? canvas.encodeSync('png') : canvas.encodeSync(format, percent(options?.quality, 90));
      if (data.length > maxFileBytes) throw new ScriptError(`${name} would be ${Math.round(data.length / 1024 / 1024)} MB; the limit is 10 MB. Use a smaller canvas or jpg/webp.`);
      const kept = { name, data, width: canvas.width, height: canvas.height };
      const at = saved.findIndex(entry => entry.name === name);
      if (at >= 0) saved[at] = kept; else saved.push(kept);
      return { name, width: canvas.width, height: canvas.height, bytes: data.length };
    },
    log(text: string) { if (logs.length < scriptLimits.logChars) logs += `${String(text).slice(0, scriptLimits.logChars - logs.length)}\n`; return null; },
  };

  runtime.setModuleLoader(name => {
    if (['canvas', '@napi-rs/canvas', 'skia-canvas', 'teapilot:canvas'].includes(name)) return shim;
    if (name === 'script') return source;
    return { error: new Error(`Image scripts can import only "canvas", not "${name}". There is no filesystem or network: read files with loadImage(name) and keep images with save(canvas, name).`) };
  });
  const context = runtime.newContext();
  const fail = (vm: QuickJSContext, error: unknown) => ({ error: vm.newError(error instanceof Error ? error.message : String(error)) });
  const define = (name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle | { error: QuickJSHandle }) => {
    const handle = context.newFunction(name, (...args) => { try { return fn(...args); } catch (error) { return fail(context, error); } });
    context.setProp(context.global, name, handle);
    handle.dispose();
  };
  try {
    define('__host', (op, args) => {
      const operation = operations[context.getString(op)];
      if (!operation) throw new ScriptError('Unknown operation.');
      return context.newString(JSON.stringify(operation(...JSON.parse(context.getString(args)) as unknown[]) ?? null));
    });
    const numbers = (handles: QuickJSHandle[]) => handles.map(handle => context.getNumber(handle));
    define('__pixels', (id, ...rest) => {
      const [x, y, width, height] = numbers(rest);
      const image = entry(context.getNumber(id), 'context').value.getImageData(x, y, side(width, 'getImageData width'), side(height, 'getImageData height'));
      const bytes = image.data as Uint8ClampedArray;
      return context.newArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    });
    define('__put', (id, buffer, ...rest) => {
      const [width, height, x, y, ...dirty] = numbers(rest);
      const copy = context.getArrayBuffer(buffer);
      const pixels = new Uint8ClampedArray(copy.value.slice().buffer);
      copy.dispose();
      const w = side(width, 'ImageData width'), h = side(height, 'ImageData height');
      if (pixels.length !== w * h * 4) throw new ScriptError(`ImageData holds ${pixels.length} bytes, not width × height × 4 = ${w * h * 4}.`);
      entry(context.getNumber(id), 'context').value.putImageData(new library.ImageData(pixels, w, h), x, y, ...dirty);
      return context.undefined;
    });
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + scriptLimits.runMs));
    const result = context.evalCode(`import 'teapilot:canvas';\nimport 'script';`, 'run.js', { type: 'module' });
    const settle = (handle: QuickJSHandle) => { const error = context.dump(handle); handle.dispose(); throw new ScriptError(scriptMessage(error)); };
    if (result.error) settle(result.error);
    const value = (result as { value: QuickJSHandle }).value;
    const pending = runtime.executePendingJobs();
    if (pending.error) { value.dispose(); settle(pending.error); }
    const state = context.getPromiseState(value);
    value.dispose();
    if (state.type === 'rejected') settle(state.error);
    if (state.type === 'pending') throw new ScriptError('The script is still waiting on something that never finishes; image scripts run top to bottom without timers.');
    if ('value' in state && state.value.alive) state.value.dispose();
    return { saved, logs: logs.trim() };
  } finally {
    try { context.dispose(); runtime.dispose(); } catch { /* a realm that ran out of memory may not free cleanly */ }
  }
}

function scriptMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { name, message, stack } = error as { name?: string; message?: string; stack?: string };
    if (name === 'InternalError' && message === 'interrupted') return `The script ran longer than ${scriptLimits.runMs / 1000} s; per-pixel loops over large images are slow here, so prefer ctx.filter or a smaller canvas.`;
    if (message === 'out of memory') return 'The script ran out of memory.';
    const where = stack?.split('\n').find(line => line.includes('script'))?.trim();
    return `${name ?? 'Error'}: ${message ?? ''}${where ? ` (${where})` : ''}`;
  }
  return String(error);
}
