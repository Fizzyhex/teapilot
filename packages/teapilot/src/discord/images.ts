import { extname } from 'node:path';

type Canvas = typeof import('@napi-rs/canvas');
let loaded: Promise<Canvas> | undefined;
/** Generic CSS families, which the canvas library otherwise draws in one fallback face, mapped to fonts that exist here. */
const generic: Record<string, string[]> = {
  serif: ['Times New Roman', 'Georgia', 'Cambria', 'DejaVu Serif', 'Liberation Serif', 'Noto Serif', 'Times'],
  'sans-serif': ['Arial', 'Segoe UI', 'Helvetica', 'DejaVu Sans', 'Liberation Sans', 'Noto Sans'],
  monospace: ['Consolas', 'Courier New', 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono', 'Menlo'],
  cursive: ['Segoe Script', 'Comic Sans MS', 'URW Chancery L'],
  'system-ui': ['Segoe UI', 'Arial', 'DejaVu Sans', 'Noto Sans'],
};
/** The native canvas library, loaded on first use so only Discord work that touches images pays for it. */
export function canvasLibrary(): Promise<Canvas> {
  return loaded ??= import('@napi-rs/canvas').then(library => {
    const families = new Set(library.GlobalFonts.families.map(entry => entry.family));
    for (const [alias, fonts] of Object.entries(generic)) {
      const font = fonts.find(name => families.has(name));
      if (font) library.GlobalFonts.setAlias(font, alias);
    }
    return library;
  });
}

const signatures: Array<[string, (data: Buffer) => boolean]> = [
  ['image/png', data => data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', data => data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff],
  ['image/gif', data => data.subarray(0, 4).toString('latin1') === 'GIF8'],
  ['image/webp', data => data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP'],
  ['image/bmp', data => data.subarray(0, 2).toString('latin1') === 'BM'],
];
/** An image's type and size, read from its bytes; undefined for anything that is not a readable image. */
export async function imageInfo(data: Buffer): Promise<{ type: string; width: number; height: number } | undefined> {
  const type = signatures.find(([, test]) => test(data))?.[0];
  if (!type) return undefined;
  try {
    const image = await (await canvasLibrary()).loadImage(data);
    return { type, width: image.width, height: image.height };
  } catch { return undefined; }
}

export type ImageFormat = 'png' | 'jpeg' | 'webp';
/** The format a file name asks for, by extension. */
export function formatOf(name: string): ImageFormat | undefined {
  const extension = extname(name).toLowerCase();
  return extension === '.png' ? 'png' : extension === '.jpg' || extension === '.jpeg' ? 'jpeg' : extension === '.webp' ? 'webp' : undefined;
}
/** Quality as a percentage from 0–1 or 0–100, as models write it either way. */
export function percent(quality: number | undefined, fallback: number): number {
  if (quality === undefined || !Number.isFinite(quality)) return fallback;
  return Math.round(Math.min(100, Math.max(1, quality <= 1 ? quality * 100 : quality)));
}

/** A picture() as the runtime shows it; render.ts checks the fields. */
export interface PictureSpec { file: string; rotate: number; flip?: 'horizontal' | 'vertical' | 'both'; filter?: string; width?: number; name: string }

/** Draws `data` rotated, flipped, filtered and scaled into the format `spec.name` names. */
export async function renderPicture(data: Buffer, spec: PictureSpec): Promise<Buffer> {
  const { createCanvas, loadImage } = await canvasLibrary();
  const image = await loadImage(data);
  const scale = spec.width ? spec.width / image.width : Math.min(1, 1600 / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale)), height = Math.max(1, Math.round(image.height * scale));
  const radians = spec.rotate * Math.PI / 180;
  const cos = Math.abs(Math.cos(radians)), sin = Math.abs(Math.sin(radians));
  // Round away float noise so quarter turns swap the sides exactly.
  const canvas = createCanvas(Math.round(width * cos + height * sin) || 1, Math.round(width * sin + height * cos) || 1);
  const context = canvas.getContext('2d');
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(radians);
  context.scale(spec.flip === 'horizontal' || spec.flip === 'both' ? -1 : 1, spec.flip === 'vertical' || spec.flip === 'both' ? -1 : 1);
  if (spec.filter) context.filter = spec.filter;
  context.drawImage(image, -width / 2, -height / 2, width, height);
  return encode(canvas, formatOf(spec.name) ?? 'png');
}

/** Encodes a canvas; JPEG and WebP default to 90% quality. */
export async function encode(canvas: import('@napi-rs/canvas').Canvas, format: ImageFormat, quality?: number): Promise<Buffer> {
  return format === 'png' ? canvas.encode('png') : canvas.encode(format, percent(quality, 90));
}
