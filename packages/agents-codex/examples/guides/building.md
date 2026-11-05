# Build the native SDK from source

Build the SDK from a checkout when you need to develop the SDK or run its source tests. For prebuilt release packages, see [Install the native SDK](installation.md).

## Build from source

Before building, install the tools for your host:

- Node.js 24, Rust 1.95, and the pnpm version pinned in `package.json`.
- Git, a C/C++ compiler and linker, CMake, and protoc.
- On Linux, pkg-config and the OpenSSL development libraries.

Run the following sequence from the repository root. Preparation downloads the pinned native source; the native build compiles it for your host, and the final build compiles the workspace packages.

```sh
pnpm install --frozen-lockfile
pnpm native:prepare
pnpm native:build
pnpm build
```

The native source pin lives in `packages/agents-codex/native/CODEX_REVISION`. The native build produces the Node-API addon and helper binaries for the current host. Use `pnpm native:audit` to check prepared source against that pin.

To try the build, set `OPENAI_API_KEY` and run `pnpm exec tsx packages/agents-codex/examples/basic.ts` from the repository root. The [greeting example](../basic.ts) asks the model to call a local tool and prints the final answer.

## Run the native tests

Build the executor test fixture before running the suite. The Linux tests need these host capabilities.

- Bubblewrap can create user and mount namespaces.
- The host executor can create or access `/tmp/codex-daemon-<uid>`. This directory must belong to the test user and have mode `0700`.
- HTTP clients can reach local listeners on `127.0.0.1`, `127.0.0.2`, and `127.0.0.3`.

```sh
node packages/agents-codex/scripts/native.mjs build --test-fixture
pnpm test:native
```

The regular native build is sufficient for application examples.

## Keep source-built packages together

The split source build places the Codex runtime in `@openai/agents-codex`. Build the starter or local release bundle with matching tarballs for `@openai/agents`, `@openai/agents-codex`, `@openai/agents-core`, `@openai/agents-openai`, and `@openai/agents-realtime`. Keep their versions, source revision, and target platform together. Include the Codex package when installing or overriding local SDK packages. Applications still import from `@openai/agents` and its supported subpaths.

The published `0.22.0-alpha.1` bundles predate this split and contain four tarballs. Follow their [release installation instructions](installation.md#add-the-sdk-to-an-existing-application) when using that release.
