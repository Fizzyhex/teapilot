import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { z } from 'zod';
import { imageInfo, renderPicture, type PictureSpec } from './images.js';
import { PlayError } from './play/render.js';
import type { Pictures } from './play/runtime.js';

/** Discord's upload limit for bots in servers without boosts. */
export const maxFileBytes = 10 * 1024 * 1024;
export const fileLimits = { perConversation: 20, conversationBytes: 50 * 1024 * 1024, perMessage: 5 };

const entrySchema = z.object({
  name: z.string(), size: z.number(), type: z.string(), width: z.number().optional(), height: z.number().optional(),
  /** Who shared it: a person's name, or teapilot for what it made. */
  from: z.string(), at: z.number(),
});
export type StoredFile = z.infer<typeof entrySchema>;

/** A name safe on every filesystem and in attachment:// URLs, keeping its extension. */
export function fileName(name: string): string {
  const base = name.split(/[\\/]/).at(-1)!.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-100);
  return base || 'file';
}

const textTypes = /^(text\/|application\/(json|javascript|typescript|xml|x-sh|x-python|toml|yaml))/;
const textExtensions = new Set(['.txt', '.md', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.py', '.lua', '.css', '.html', '.xml', '.yml', '.yaml', '.toml', '.csv', '.sh', '.ps1', '.c', '.h', '.cpp', '.cs', '.java', '.go', '.rs', '.rb', '.php', '.sql', '.ini', '.cfg', '.log']);
/** Text a model can read: a known text type or extension, valid UTF-8 without NUL bytes. */
export function asText(name: string, data: Buffer, type?: string): string | undefined {
  if (!(type && textTypes.test(type)) && !textExtensions.has(extname(name).toLowerCase())) return undefined;
  const text = data.toString('utf8');
  return text.includes('\0') || text.includes('�') ? undefined : text;
}

const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
/** One line per file, as the model sees it. */
export function describeFile(file: StoredFile): string {
  const kind = file.width ? `${file.type.replace('image/', '').toUpperCase()} image ${file.width}×${file.height}` : file.type;
  return `${file.name} (${kind}, ${size(file.size)}, from ${file.from})`;
}

/**
 * Files shared in or made for each conversation: attachments people send, and images and files teapilot makes.
 * Apps show them with picture(), so they outlive a conversation's history and a restart. Each conversation keeps
 * its newest files within a count and size cap; a file saved under an existing name replaces it.
 */
export class FileStore {
  constructor(readonly directory: string) {}
  static at(stateDir: string): FileStore { return new FileStore(join(stateDir, 'discord-files')); }

  private folder(conversation: string): string { return join(this.directory, createHash('sha256').update(conversation).digest('hex').slice(0, 24)); }
  private index(conversation: string): StoredFile[] {
    try { return z.array(entrySchema).parse(JSON.parse(readFileSync(join(this.folder(conversation), 'index.json'), 'utf8'))); }
    catch { return []; }
  }
  private write(conversation: string, entries: StoredFile[]): void {
    const file = join(this.folder(conversation), 'index.json');
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(entries));
    renameSync(temporary, file);
  }

  list(conversation: string): StoredFile[] { return this.index(conversation); }
  get(conversation: string, name: string): StoredFile | undefined {
    const entries = this.index(conversation);
    return entries.find(entry => entry.name === name) ?? entries.find(entry => entry.name.toLowerCase() === fileName(name).toLowerCase());
  }
  read(conversation: string, name: string): { file: StoredFile; data: Buffer } | undefined {
    const file = this.get(conversation, name);
    if (!file) return undefined;
    try { return { file, data: readFileSync(join(this.folder(conversation), file.name)) }; } catch { return undefined; }
  }

  async save(conversation: string, name: string, data: Buffer, from: string, type?: string): Promise<StoredFile> {
    if (data.length > maxFileBytes) throw new Error(`${name} is ${size(data.length)}; files may be at most ${size(maxFileBytes)}.`);
    const clean = fileName(name);
    const image = await imageInfo(data);
    const entry: StoredFile = { name: clean, size: data.length, type: image?.type ?? type ?? 'application/octet-stream', ...(image ? { width: image.width, height: image.height } : {}), from, at: Date.now() };
    const folder = this.folder(conversation);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, clean), data);
    // Newest first within the caps; older files go.
    const entries = [entry, ...this.index(conversation).filter(existing => existing.name !== clean)];
    let total = 0;
    const kept = entries.filter((existing, index) => (total += existing.size) <= fileLimits.conversationBytes && index < fileLimits.perConversation);
    for (const dropped of entries.filter(existing => !kept.includes(existing))) rmSync(join(folder, dropped.name), { force: true });
    this.write(conversation, kept.reverse());
    return entry;
  }
}

/** picture() for discord.play: images from each app's conversation, with recent renders kept in memory. */
export function pictures(store: FileStore): Pictures {
  const cache = new Map<string, Buffer>();
  const image = (conversation: string, spec: PictureSpec) => {
    const file = store.get(conversation, spec.file);
    if (!file?.width) {
      const images = store.list(conversation).filter(entry => entry.width).map(entry => entry.name);
      throw new PlayError(`picture("${spec.file}"): ${file ? 'that file is not an image' : 'no file by that name here'}. ${images.length ? `Images here: ${images.join(', ')}.` : 'Nobody has shared an image in this conversation yet.'}`);
    }
    return file;
  };
  return {
    check: (conversation, spec) => { image(conversation, spec); },
    async render(conversation, spec) {
      const file = image(conversation, spec);
      const key = `${conversation}\0${file.name}\0${file.at}\0${spec.name}`;
      let data = cache.get(key);
      if (!data) {
        const stored = store.read(conversation, file.name);
        if (!stored) throw new Error(`${file.name} is no longer stored.`);
        data = await renderPicture(stored.data, spec);
        cache.set(key, data);
        if (cache.size > 32) cache.delete(cache.keys().next().value!);
      }
      return { name: spec.name, data };
    },
  };
}

/** The files of the conversation a turn belongs to; the bridge builds it, never the model. */
export interface ConversationFiles {
  store: FileStore;
  conversation: string;
  /** Posts files in the conversation, with a line of text. */
  send?(text: string, files: Array<{ name: string; data: Buffer }>): Promise<void>;
}
