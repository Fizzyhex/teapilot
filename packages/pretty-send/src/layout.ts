import { chunk, fences } from './chunk.js';
import { parse, type Block, type MediaRef } from './parse.js';
import { codeTable, defaultViewSourcePrefix, tableEmbed, viewSourceRow, type Embed } from './table.js';

/** The message flag that turns on Components V2: no `content` or `embeds`, everything is a component. */
export const IS_COMPONENTS_V2 = 1 << 15;
/** What Discord allows in one Components V2 message. */
export const componentLimits = { components: 40, text: 4000, files: 10, gallery: 10, alt: 1024 };
/** A paragraph longer than this keeps its image under it, in a gallery, rather than beside it as a thumbnail. */
const thumbnailText = 1000;

export interface Upload { name: string; data: Buffer }
/** A reference the caller found: a file to upload, `image` when Discord can show it as a picture, or an image elsewhere. */
export type Resolved = { name: string; data: Buffer; image: boolean } | { url: string };
export interface LayoutOptions {
  /** Finds what `![alt](ref)` points at; undefined leaves the markdown as it is. http(s) image URLs are found without it. */
  resolve?(ref: string): Resolved | undefined | Promise<Resolved | undefined>;
  /** Starts the custom id of each table's "view source" button. */
  viewSourcePrefix?: string;
}
/** Raw Discord API JSON. */
export type Component = Record<string, unknown>;
/**
 * One message to send, as discord.js or the REST API takes it; `files` are uploaded under their names. `source` is the
 * markdown it shows, to send as text instead if Discord refuses it; it isn't part of the payload.
 */
export interface Message { content?: string; embeds?: Embed[]; components?: Component[]; flags?: number; files?: Upload[]; source: string }

type Item = { kind: 'image' | 'file'; url: string; alt?: string; upload?: Upload; source: string };
type Laid = Exclude<Block, { type: 'media' }> | { type: 'media'; items: Item[] };

const imageUrl = /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp)(?:[?#]\S*)?$/i;
const safeName = (name: string) => name.split(/[\\/]/).at(-1)!.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '') || 'file';

/** Finds each reference, giving uploads names unique within the answer; the ones not found go back to being text. */
async function resolveAll(blocks: Block[], options: LayoutOptions): Promise<Laid[]> {
  const uploads = new Map<string, Upload>(); // by ref
  const taken = new Set<string>();
  const unique = (name: string) => {
    const dot = name.lastIndexOf('.');
    const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    let candidate = name;
    for (let count = 2; taken.has(candidate.toLowerCase()); count++) candidate = `${stem}-${count}${extension}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  };
  const find = async ({ ref, alt, source }: MediaRef): Promise<Item | undefined> => {
    const described = alt?.slice(0, componentLimits.alt);
    if (imageUrl.test(ref)) return { kind: 'image', url: ref, alt: described, source };
    const found = await options.resolve?.(ref);
    if (!found) return undefined;
    if ('url' in found) return { kind: 'image', url: found.url, alt: described, source };
    let upload = uploads.get(ref);
    if (!upload) uploads.set(ref, upload = { name: unique(safeName(found.name)), data: found.data });
    return { kind: found.image ? 'image' : 'file', url: `attachment://${upload.name}`, alt: described, upload, source };
  };
  const laid: Laid[] = [];
  const text = (value: string) => {
    const last = laid.at(-1);
    if (last?.type === 'text') last.text += `\n\n${value}`; else laid.push({ type: 'text', text: value });
  };
  for (const block of blocks) {
    if (block.type === 'text') text(block.text);
    else if (block.type !== 'media') laid.push(block);
    else for (const ref of block.items) {
      const item = await find(ref);
      const last = laid.at(-1);
      if (!item) text(ref.source);
      else if (last?.type === 'media') last.items.push(item);
      else laid.push({ type: 'media', items: [item] });
    }
  }
  return laid;
}

/** `text` split before its last paragraph, never inside a code fence. */
function lastParagraph(text: string): [string, string] {
  const lines = text.split('\n');
  const fenced = fences();
  let cut = -1;
  lines.forEach((line, index) => { if (!fenced.step(line) && !line.trim()) cut = index; });
  return [lines.slice(0, Math.max(0, cut)).join('\n').trim(), lines.slice(cut + 1).join('\n').trim()];
}

/** Components V2 messages, each started as soon as the last one is full. */
function packer(messages: Message[]) {
  let current: { components: Component[]; files: Upload[]; count: number; text: number; sources: string[] } | undefined;
  const flush = () => {
    if (current?.components.length) messages.push({ components: current.components, flags: IS_COMPONENTS_V2, ...(current.files.length ? { files: current.files } : {}), source: current.sources.join('\n\n') });
    current = undefined;
  };
  /** Adds `component`, which counts as `count` components, holds `text` characters, shows `uploads` and stands for `source`. */
  const add = (component: Component, source: string, count: number, text: number, uploads: Upload[] = []) => {
    const fresh = (files: Upload[]) => [...new Set(uploads)].filter(upload => !files.includes(upload));
    if (current && (current.count + count > componentLimits.components || current.text + text > componentLimits.text
      || current.files.length + fresh(current.files).length > componentLimits.files)) flush();
    current ??= { components: [], files: [], count: 0, text: 0, sources: [] };
    current.files.push(...fresh(current.files));
    current.components.push(component); current.sources.push(source); current.count += count; current.text += text;
  };
  const text = (value: string) => { for (const piece of chunk(value, componentLimits.text)) add({ type: 10, content: piece }, piece, 1, piece.length); };
  return { add, text, flush };
}

/**
 * A markdown answer as Discord messages, in order. Plain text is sent as it is, split as `chunk` splits it. Tables
 * become embeds of their own with a "view source" button, since Discord allows no embeds beside V2 components.
 * Dividers, and images or files on lines of their own, turn the rest into Components V2 messages.
 */
export async function layout(text: string, options: LayoutOptions = {}): Promise<Message[]> {
  const blocks = parse(text);
  const plain = (value: string) => chunk(value).map(content => ({ content, source: content }));
  if (blocks.every(block => block.type === 'text')) return plain(text);
  const resolved = await resolveAll(blocks, options);
  const rich = resolved.some(block => block.type === 'divider' || block.type === 'media');
  // Nothing was found to show, so the answer goes out as it was written.
  if (!rich && !resolved.some(block => block.type === 'table')) return plain(text);
  const laid = resolved.map((block): Laid => block.type !== 'table' || tableEmbed(block.table) ? block : { type: 'text', text: codeTable(block.table) });
  const messages: Message[] = [];
  const v2 = packer(messages);
  for (let index = 0; index < laid.length; index++) {
    const block = laid[index]!;
    if (block.type === 'table') {
      v2.flush();
      const { embed, layout: shape } = tableEmbed(block.table)!;
      messages.push({ embeds: [embed], components: [viewSourceRow(shape, options.viewSourcePrefix ?? defaultViewSourcePrefix)], source: block.table.source });
    } else if (block.type === 'divider') v2.add({ type: 14, divider: true, spacing: 1 }, '---', 1, 0);
    else if (block.type === 'text') {
      if (!rich) { v2.flush(); messages.push(...plain(block.text)); continue; }
      const next = laid[index + 1];
      const single = next?.type === 'media' && next.items.length === 1 && next.items[0]!.kind === 'image' ? next.items[0]! : undefined;
      const [before, paragraph] = single ? lastParagraph(block.text) : [block.text, ''];
      // One picture right after a paragraph sits beside it as a thumbnail.
      if (single && paragraph && paragraph.length <= thumbnailText) {
        if (before) v2.text(before);
        v2.add({ type: 9, components: [{ type: 10, content: paragraph }], accessory: { type: 11, media: { url: single.url }, ...(single.alt ? { description: single.alt } : {}) } },
          `${paragraph}\n${single.source}`, 3, paragraph.length, single.upload ? [single.upload] : []);
        index++;
      } else v2.text(block.text);
    } else {
      // Pictures next to each other share a gallery; other files are shown one by one.
      for (let at = 0; at < block.items.length;) {
        const item = block.items[at]!;
        if (item.kind === 'file') { v2.add({ type: 13, file: { url: item.url } }, item.source, 1, 0, [item.upload!]); at++; continue; }
        const run: Item[] = [];
        while (at < block.items.length && block.items[at]!.kind === 'image' && run.length < componentLimits.gallery) run.push(block.items[at++]!);
        v2.add({ type: 12, items: run.map(image => ({ media: { url: image.url }, ...(image.alt ? { description: image.alt } : {}) })) },
          run.map(image => image.source).join('\n'), 1, 0, run.flatMap(image => image.upload ? [image.upload] : []));
      }
    }
  }
  v2.flush();
  return messages;
}
