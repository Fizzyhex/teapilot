import { copyFile, mkdir } from 'node:fs/promises';

const destination = new URL('../dist/art/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ['typing', 'pawing', 'tea-break']) {
  await copyFile(new URL(`../src/art/ascii-${name}.json`, import.meta.url), new URL(`ascii-${name}.json`, destination));
}
