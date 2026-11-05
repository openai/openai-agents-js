# Build the native SDK from source

Build the SDK from a checkout when you need to develop the SDK or run its source tests. For prebuilt release packages, see [Install the native SDK](installation.md).

## Build from source

Use Node.js 24, Rust 1.95, and the pnpm version pinned in `package.json`. Install Git, a C/C++ compiler and linker, CMake, and protoc. On Linux, install pkg-config and the OpenSSL development libraries. Run these commands from the repository root.

```sh
pnpm install --frozen-lockfile
pnpm native:prepare
pnpm native:build
pnpm build
```

Preparation downloads the exact revision in `packages/agents-codex/native/CODEX_REVISION`. The build produces the Node-API addon and helper binaries for the current host. `pnpm native:audit` checks prepared source against its pin.

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
