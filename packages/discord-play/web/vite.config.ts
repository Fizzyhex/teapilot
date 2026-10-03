import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [svelte({ configFile: false })],
  build: { outDir: '../dist/web', emptyOutDir: true, license: { fileName: 'licenses.md' } },
});
