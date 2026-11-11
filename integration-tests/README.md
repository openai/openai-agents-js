# Integration tests

The integration fixtures test installed SDK packages across runtimes. They install the packages from a local Verdaccio registry outside the `pnpm` workspace.

Each fixture declares npm in `packageManager` so Dependabot treats its manifest independently instead of adopting the ancestor pnpm workspace. This metadata does not change the Bun or Deno commands used by their runtime tests.

Committed fixture `.npmrc` files use public npm so Dependabot can resolve dependencies without registry credentials. The integration-test global setup temporarily routes `@openai` packages to the local Verdaccio registry and restores each original `.npmrc` during teardown, including after a partial setup failure. Run fixtures through the integration-test commands below to use locally published packages.

## How to run integration tests

### Prepare the host

- Put Node.js, Bun, and Deno on `PATH`. Run `pnpm exec playwright install` to install the test browsers.
- For tests that call the API, export `OPENAI_API_KEY` from a trusted service-account shell and set `OPENAI_API_KEY_SOURCE=service-account`. Use the service account's key.
- For storage-mount tests, use Docker with FUSE support. Set `OPENAI_AGENTS_RUN_STORAGE_MOUNT_INTEGRATION=1` for a manual run. The test starts local Azurite and MinIO containers and removes them during cleanup.

### Run the managed workflow

```bash
pnpm test:integration:managed
```

This command starts its own Verdaccio registry, builds and publishes the packages locally, and runs the full suite with storage-mount coverage. If another process owns the registry port, the command stops before using it. Only the integration-test process receives the validated API key.

The command cleans up after success, failure, `SIGINT`, or `SIGTERM`. It streams output and writes `pipeline.log` and `verdaccio.log` under a timestamped directory in `.tmp/integration-tests-managed/`. A cleanup or log-finalization failure fails the run.

### Run individual profiles

1. Start Verdaccio with `pnpm local-npm:start` and leave it running. If the local registry requires a login, run `npm adduser --registry http://localhost:4873/` with a local test account.
2. In a separate shell, run `pnpm build`, then `pnpm local-npm:publish`.
3. Run the suite or a focused profile:

   ```bash
   pnpm test:integration
   pnpm test:integration:sdk-core
   pnpm test:integration:sdk-capabilities
   ```

### Configure live and device tests

- The Node.js behavior fixture reads `OPENAI_AGENTS_INTEGRATION_MODEL` and defaults to `gpt-5.6`. The hosted multi-agent fixture reads `OPENAI_AGENTS_INTEGRATION_HOSTED_MODEL` and defaults to `gpt-5.6-sol`. The latter requires API project access to the beta.
- Hosted MCP tests read `OPENAI_AGENTS_INTEGRATION_MCP_SERVER_URL` and default to the public DeepWiki MCP endpoint.
- The suite temporarily writes the API key to `integration-tests/cloudflare-workers/worker/.dev.vars` and `integration-tests/vite-react/.env`. Cleanup restores existing files. The fixture processes use `NODE_ENV=development` to exercise normal server tracing.
- The React Native fixture installs the locally published packages, type-checks the Expo example, and builds an Android Metro bundle. To also test the Realtime API, start an Android emulator with `adb` available and set `OPENAI_AGENTS_RUN_REACT_NATIVE_LIVE=1`.

### Released package API contract

The released API contract uses the package versions and npm integrity hashes in `scripts/released-api-contract.json` as its immutable baseline. It validates current source separately from build output:

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

#### What the declaration check covers

The check preserves released binding spaces and declaration kinds, enum and literal members, and public class constructibility. For public named members of SDK-owned classes and object types, it preserves names, optional and readonly modifiers, and whether a member is callable or a property.

The contract can protect two kinds of signatures in more detail:

- Selected direct callable type aliases preserve their generic parameters, callable parameters, and return type.
- `selectedPublicObjectProperties` protects one inline object property of a function parameter, such as the image settings of `webSearchTool` in both public package roots. The function must have one non-generic signature. The object's immediate fields must have identifier names and number, boolean, or string types.

Register each selection in checker code and list it in the JSON policy. For a selected object, list every immediate field and its type, optionality, and readonly status, even before release. The checker reads the effective modifiers from TypeScript, including mapped utility types. It checks immediate fields only.

Add new optional fields to the policy. Removing a released field, changing its type or shape, or adding a required field breaks the released contract. The source, declaration, package, and promotion checks enforce these rules.

The contract intentionally does not implement a separate compatibility system for other methods, constructor or callable parameters and returns, unselected property types, index signatures, generics, overloads, or unselected callable type aliases. Existing TypeScript build checks and release review remain responsible for those deeper signature changes.

#### Promote a published release

The checks cover new subpaths and exports on `main` across source, build output, and installed packages. Promote a release to add its public surface to the compatibility baseline. After publishing and tagging the release, set `RELEASE_VERSION` to its npm version and run this command from a clean checkout:

```sh
pnpm api-contract:promote --version "${RELEASE_VERSION:?Set RELEASE_VERSION to the published npm version}"
```

Promotion first rejects incompatibility with the previous baseline. It then records every subpath and export condition from the integrity-pinned published packages, so newly released paths become protected automatically. Promotion preserves selection policies and requires complete selected-object coverage before writing the new baseline.

The SDK core profile covers Responses behavior, structured output, delegation, approval/resume, conversation state, and tracing. The SDK capabilities profile covers guardrails, execution controls, Responses/Chat Completions parity, hosted tools, deferred tool search, programmatic tool calling, and hosted multi-agent caller identity.
