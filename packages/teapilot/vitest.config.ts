import { defineConfig } from 'vitest/config';
// `source` resolves workspace packages such as teachat to their TypeScript, so tests need no prior build.
const conditions = ['teapilot-source', 'import', 'module', 'node', 'default'];
export default defineConfig({ envDir: false, resolve: { conditions }, ssr: { resolve: { conditions, externalConditions: ['teapilot-source'] } }, test: { include: ['tests/**/*.test.ts'], testTimeout: 30000, hookTimeout: 30000 } });
