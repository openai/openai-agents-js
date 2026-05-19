import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// On GitHub Pages the app lives at /openai-agents-js/stormscope/
// Locally it lives at /
const base = process.env.GITHUB_ACTIONS ? '/openai-agents-js/stormscope/' : '/';

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
});
