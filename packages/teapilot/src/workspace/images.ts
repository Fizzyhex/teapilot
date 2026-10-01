import type { ImageContent } from '@earendil-works/pi-ai';
import { canvasLibrary, encode } from '../discord/images.js';
import { IMAGE_MAX_BYTES, IMAGE_SIDE } from '../inference/context.js';
import type { WorkspaceStore } from './store.js';

/**
 * A picture as a model is sent it: at most IMAGE_SIDE pixels a side (a model reads in patches, so a larger picture costs
 * more and is no clearer) and IMAGE_MAX_BYTES, in a format every server reads. Undefined when it cannot be read.
 */
export async function modelImage(data: Buffer, type: string): Promise<ImageContent | undefined> {
  try {
    const { createCanvas, loadImage } = await canvasLibrary();
    const image = await loadImage(data);
    const scale = Math.min(1, IMAGE_SIDE / Math.max(image.width, image.height));
    // A PNG or JPEG that is small enough goes as it is.
    if (scale === 1 && data.length <= IMAGE_MAX_BYTES && (type === 'image/png' || type === 'image/jpeg')) return { type: 'image', data: data.toString('base64'), mimeType: type };
    const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    // JPEG stays JPEG; anything else, GIFs and transparency included, becomes PNG, and a PNG too large for a request a JPEG.
    const png = type === 'image/jpeg' ? undefined : await encode(canvas, 'png');
    const kept = png && png.length <= IMAGE_MAX_BYTES ? { bytes: png, mimeType: 'image/png' } : { bytes: await encode(canvas, 'jpeg', 85), mimeType: 'image/jpeg' };
    return kept.bytes.length <= IMAGE_MAX_BYTES ? { type: 'image', data: kept.bytes.toString('base64'), mimeType: kept.mimeType } : undefined;
  } catch { return undefined; }
}

/** The named workspace pictures as a model is sent them; those that cannot be read are left out. */
export async function workspaceImages(store: WorkspaceStore, conversation: string, names: string[]): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  for (const name of names) {
    const stored = store.read(conversation, name);
    const image = stored?.file.width ? await modelImage(stored.data, stored.file.type) : undefined;
    if (image) images.push(image);
  }
  return images;
}
