import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      '@openai/agents-core/_shims': path.resolve(
        rootDir,
        '../../packages/agents-core/dist/shims/shims-browser.js',
      ),
      '@openai/agents-realtime/_shims': path.resolve(
        rootDir,
        '../../packages/agents-realtime/dist/shims/shims-browser.js',
      ),
      '@openai/agents-realtime': path.resolve(
        rootDir,
        '../../packages/agents-realtime/dist',
      ),
      '@openai/agents-core': path.resolve(
        rootDir,
        '../../packages/agents-core/dist',
      ),
    },
  },
});
