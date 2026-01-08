# Realtime usage examples

This folder contains quick examples showing how to use the built `agents-realtime` bundles.

Files:
- `use-realtime-node.mjs` - Node (ESM) example that imports the ESM bundle.
- `use-realtime-browser.html` - Browser example that expects the UMD bundle to be served.

Notes:
- The examples import from `packages/agents-realtime/dist/bundle/` by default. If your build writes to a different path, update the script/import paths accordingly.
 - The examples import from `packages/agents-realtime/dist/bundle/` by default. Build produces:
	 - `packages/agents-realtime/dist/bundle/openai-realtime-agents.mjs` (ESM)
	 - `packages/agents-realtime/dist/bundle/openai-realtime-agents.umd.js` (UMD)
- Browser example expects an endpoint `/session-ephemeral-key` that returns a short-lived ephemeral key. Implement this endpoint in your server to avoid exposing long-lived keys.

Run Node example:
```bash
# set your API key and run
export OPENAI_API_KEY="sk-..."
node --experimental-specifier-resolution=node examples/realtime-usage/use-realtime-node.mjs
```

Run Browser example (serve the repo root) and open the HTML file in a browser:
```bash
# serve from repo root so the script path to packages/... resolves
npx http-server -p 5173 .
# open http://localhost:5173/examples/realtime-usage/use-realtime-browser.html
```

Quick smoke test (verify bundle loads):
```bash
node --input-type=module -e "import(new URL('./packages/agents-realtime/dist/bundle/openai-realtime-agents.mjs', import.meta.url)).then(m=>console.log(Object.keys(m))).catch(e=>{console.error(e); process.exit(1)})"
```

If you want, I can:
- Adjust these examples to use a different build path.
- Add a small express/fastify server that returns an ephemeral key for the browser example.
- Add TypeScript variants or tests.
