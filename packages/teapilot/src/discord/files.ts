import { renderPicture, type PictureSpec } from './images.js';
import { PlayError } from './play/render.js';
import type { Pictures } from './play/runtime.js';
import type { WorkspaceStore } from '../workspace/store.js';

/** picture() for discord.play: images from each app's conversation workspace, with recent renders kept in memory. */
export function pictures(store: WorkspaceStore): Pictures {
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
      const key = `${conversation}\0${file.name}\0${file.at}\0${file.mtimeMs ?? ''}\0${spec.name}`;
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
