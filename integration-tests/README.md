# Integration tests

This project hosts packages to test the different environments that the Agents SDK works in.

It is intentionally not part of the `pnpm` workspace and instead installs the packages from a local package registry using verdaccio.

## How to run integration tests

1. **Requirements:**

- Have Node.js, Bun, and Deno installed globally
- Have an `OPENAI_API_KEY` environment variable configured
- Run `pnpm exec playwright install` to install playwright
- `pnpm test:integration` will create temporary `integration-tests/cloudflare-workers/worker/.dev.vars` and `integration-tests/vite-react/.env` files from `OPENAI_API_KEY` and restore any pre-existing files during cleanup
- Integration test fixture subprocesses run with `NODE_ENV=development` so real-model SDK examples keep the normal server-runtime tracing behavior even though Vitest itself runs with `NODE_ENV=test`
- The Node.js published SDK behavior fixture uses `OPENAI_AGENTS_INTEGRATION_MODEL` when set and defaults to `gpt-5.6`. Hosted multi-agent coverage uses `OPENAI_AGENTS_INTEGRATION_HOSTED_MODEL` and defaults to `gpt-5.6-sol`.
- Hosted MCP coverage uses `OPENAI_AGENTS_INTEGRATION_MCP_SERVER_URL` when set and defaults to the public DeepWiki MCP endpoint. Hosted multi-agent is skipped with an explicit reason when the API project does not have beta access.
- Optional sandbox storage mount coverage requires Docker with FUSE support and is skipped unless `OPENAI_AGENTS_RUN_STORAGE_MOUNT_INTEGRATION=1` is set. It starts local Azurite and MinIO containers and removes them after the test.

2. **Local npm registry**

   We will publish packages in a local registry to emulate a real environment.

   Run in one process `pnpm run local-npm:start` and keep it running until you are done with your test.

   **Hint:** The first time you might have to run `npm adduser --registry http://localhost:4873/` (you can use any fake data)

3. **Publish your packages to run the tests**

   In order to test the packages first build them (`pnpm build`) and then run `pnpm local-npm:publish`.

4. **Run your tests**

   You can now run your integration tests:

   ```bash
   pnpm test:integration
   ```

   The published-package semantic profiles can also be run independently:

   ```bash
   pnpm test:integration:sdk-core
   pnpm test:integration:sdk-capabilities
   ```

   The SDK core profile covers Responses behavior, structured output, delegation, approval/resume, conversation state, and tracing. The SDK capabilities profile covers guardrails, execution controls, Responses/Chat Completions parity, hosted tools, deferred tool search, programmatic tool calling, and hosted multi-agent caller identity.
