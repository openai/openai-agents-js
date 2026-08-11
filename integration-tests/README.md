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
- Hosted MCP coverage uses `OPENAI_AGENTS_INTEGRATION_MCP_SERVER_URL` when set and defaults to the public DeepWiki MCP endpoint. Hosted multi-agent coverage requires API project access to the beta and fails when that access is unavailable.
- Optional sandbox storage mount coverage requires Docker with FUSE support and is skipped unless `OPENAI_AGENTS_RUN_STORAGE_MOUNT_INTEGRATION=1` is set. It starts local Azurite and MinIO containers and removes them after the test.
- The React Native fixture copies the Expo example, installs the locally published packages, type-checks it, and creates an Android Metro bundle. Set `OPENAI_AGENTS_RUN_REACT_NATIVE_LIVE=1` to additionally build and run it against the Realtime API on an already-running Android emulator with `adb` available.

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

### Released package API contract

The released API contract uses the package versions and npm integrity hashes in `tests/fixtures/released-api-contract.json` as its immutable baseline. It validates current source separately from build output:

```sh
pnpm api-contract:source
pnpm build:ci
pnpm api-contract:dist
```

For the focused package profiles, reset the registry storage before starting Verdaccio:

```sh
pnpm local-npm:reset
pnpm local-npm:start
```

Keep Verdaccio running, then build and publish the workspace packages from another process before running the profile:

```sh
pnpm build
pnpm local-npm:publish
pnpm test:integration:api-contract
```

The package check first installs the package roots without optional provider peers to detect eager optional-provider loading. It then installs every optional peer declared by `@openai/agents-extensions` and checks all published subpaths, declarations, and supported ESM/CJS runtime bindings. Convenience exports are identity-checked against their owning packages in the same process, module format, and active export conditions. A module format that an optional peer does not export is not treated as a supported route. The check does not make OpenAI API calls and does not require `OPENAI_API_KEY`.

The declaration check preserves released binding spaces and declaration kinds, enum and literal members, public class constructibility, and the names, optional/readonly shape, and callable-versus-property kind of public named members on SDK-owned classes and object types. The selected Runloop facade list separately requires its named entries, including `platform()`, to remain present. The contract intentionally does not implement a separate compatibility system for other methods, constructor or callable parameters and returns, property types, index signatures, generics, or overloads. Existing TypeScript build checks and release review remain responsible for those deeper signature changes.

New package subpaths and exports on `main` are checked for source, build, and package parity, but they are not released guarantees until the corresponding npm release is promoted. After publishing and tagging a release, update the baseline explicitly from a clean checkout:

```sh
pnpm api-contract:promote -- --version <version>
```

Promotion first rejects incompatibility with the previous baseline. It then records every subpath and export condition from the integrity-pinned published packages, so newly released paths become protected automatically.

The SDK core profile covers Responses behavior, structured output, delegation, approval/resume, conversation state, and tracing. The SDK capabilities profile covers guardrails, execution controls, Responses/Chat Completions parity, hosted tools, deferred tool search, programmatic tool calling, and hosted multi-agent caller identity.
