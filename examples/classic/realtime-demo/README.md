# Realtime Demo

Follow the [classic example setup](../README.md) to install dependencies and build the SDK before running these commands.

This example is a small [Vite](https://vitejs.dev/) application showcasing the realtime agent API.

1. Set `OPENAI_API_KEY` in your server shell and generate a short-lived client secret:
   ```bash
   pnpm -F realtime-demo generate-token
   ```
   Copy the printed key.
2. Start the dev server:
   ```bash
   pnpm examples:realtime-demo
   ```
3. Open the printed localhost URL and paste the key when prompted.

Use `pnpm -F realtime-demo build` to create a production build.

## Runtime requirements

Use Node.js 22.18 or later within the 22.x line, Node.js 24.x, or Node.js 26 or later. The `generate-token` command executes TypeScript directly with Node.js.
