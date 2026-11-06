# Realtime Demo

This example is a small [Vite](https://vitejs.dev/) application showcasing the realtime agent API.

1. Install dependencies in the repo root with `pnpm install`.
2. Generate an ephemeral API key:
   ```bash
   pnpm -F realtime-demo generate-token
   ```
   Copy the printed key.
3. Start the dev server:
   ```bash
   pnpm examples:realtime-demo
   ```
4. Open the printed localhost URL and paste the key when prompted.

Use `pnpm -F realtime-demo build` to create a production build.

## Runtime requirements

Use Node.js 22.18 or later within the 22.x line, Node.js 24.x, or Node.js 26 or later. The `generate-token` command executes TypeScript directly with Node.js.
