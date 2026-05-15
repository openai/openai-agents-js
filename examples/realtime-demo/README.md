# Realtime Demo

This example is a small [Vite](https://vitejs.dev/) application showcasing the realtime agent API.

1. Install dependencies in the repo root with `pnpm install`.
2. Generate an ephemeral API key:

   ```bash
   pnpm -F realtime-demo generate-token
   ```

   Copy the printed key.

   To override the client secret TTL, pass a value between 10 seconds and 2 hours:

   ```bash
   pnpm -F realtime-demo generate-token -- --ttl-seconds=1800
   ```

   You can also set `REALTIME_CLIENT_SECRET_TTL_SECONDS` instead of passing the flag.

3. Start the dev server:
   ```bash
   pnpm examples:realtime-demo
   ```
4. Open the printed localhost URL and paste the key when prompted.

Use `pnpm -F realtime-demo build` to create a production build.
