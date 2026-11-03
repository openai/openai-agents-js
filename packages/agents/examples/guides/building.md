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

Preparation downloads the exact revision in `packages/agents/native/CODEX_REVISION`. The build produces the Node-API addon and helper binaries for the current host. `pnpm native:audit` checks prepared source against its pin.

For the native suite, build the executor fixture with `node packages/agents/scripts/native.mjs build --test-fixture`, then run `pnpm test:native`. The regular native build can run application examples.
