import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { TextDecoder } from 'node:util';
import { PlayError } from './render.js';

export const assetLimits = { files: 32, fileBytes: 256 * 1024, totalBytes: 1024 * 1024 };
export type AssetFiles = Record<string, string>;
export type AssetTexts = Record<string, string>;

/** Logical names are portable paths, never filesystem paths or URLs. */
export function checkAssetName(name: string): void {
  if (!name || name.length > 256 || /[\\:\x00-\x1f\x7f]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new PlayError(`invalid asset name ${JSON.stringify(name)}: use a relative forward-slash path without traversal.`);
  }
}

/** Also validate snapshots loaded from persistence or supplied directly to the runtime. */
export function checkAssetTexts(texts: AssetTexts): void {
  if (Object.keys(texts).length > assetLimits.files) throw new PlayError(`an app may select at most ${assetLimits.files} assets.`);
  let total = 0;
  for (const [name, text] of Object.entries(texts)) {
    checkAssetName(name);
    if (typeof text !== 'string' || text.includes('\0')) throw new PlayError(`asset ${JSON.stringify(name)} must be text without NUL bytes.`);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > assetLimits.fileBytes) throw new PlayError(`asset ${JSON.stringify(name)} exceeds ${assetLimits.fileBytes} bytes.`);
    total += bytes;
  }
  if (total > assetLimits.totalBytes) throw new PlayError(`app assets exceed ${assetLimits.totalBytes} bytes combined.`);
}

/** Resolve through the caller's access checks, then collect bounded UTF-8 data, never executable code. */
export async function collectAssets(files: AssetFiles, resolve: (file: string) => Promise<string>): Promise<AssetTexts> {
  const entries = Object.entries(files);
  if (entries.length > assetLimits.files) throw new PlayError(`an app may select at most ${assetLimits.files} assets.`);
  const texts: AssetTexts = Object.create(null);
  let total = 0;
  for (const [name, file] of entries) {
    checkAssetName(name);
    if (!file || file.includes('\0')) throw new PlayError(`asset ${JSON.stringify(name)} needs a file path.`);
    const path = await resolve(file);
    try {
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) throw new PlayError(`asset ${JSON.stringify(name)} must be a regular, unlinked file.`);
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink > 1 || info.dev !== before.dev || info.ino !== before.ino) throw new PlayError(`asset ${JSON.stringify(name)} must be a regular, unlinked file that did not change during loading.`);
        if (info.size > assetLimits.fileBytes) throw new PlayError(`asset ${JSON.stringify(name)} exceeds ${assetLimits.fileBytes} bytes.`);
        if (total + info.size > assetLimits.totalBytes) throw new PlayError(`app assets exceed ${assetLimits.totalBytes} bytes combined.`);
        // Bound the read even if the file grows after stat().
        const buffer = Buffer.alloc(assetLimits.fileBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > assetLimits.fileBytes) throw new PlayError(`asset ${JSON.stringify(name)} exceeds ${assetLimits.fileBytes} bytes.`);
        total += length;
        if (total > assetLimits.totalBytes) throw new PlayError(`app assets exceed ${assetLimits.totalBytes} bytes combined.`);
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)); }
        catch { throw new PlayError(`asset ${JSON.stringify(name)} must be valid UTF-8 text.`); }
        if (text.includes('\0')) throw new PlayError(`asset ${JSON.stringify(name)} must be text without NUL bytes.`);
        texts[name] = text;
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof PlayError) throw error;
      throw new PlayError(`could not read asset ${JSON.stringify(name)} from ${JSON.stringify(file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return texts;
}

/** Order-independent identity, including assets, for reload and rejected-app checks. */
export function sandboxIdentity(source: { code: string; assets?: AssetTexts }): string {
  return JSON.stringify([source.code.trim(), Object.entries(source.assets ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);
}
