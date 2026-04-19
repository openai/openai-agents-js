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
