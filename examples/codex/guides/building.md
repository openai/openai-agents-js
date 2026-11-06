# Build the native SDK from source

Build the SDK from a checkout when you need current source features, develop the SDK, or run its source tests. For prebuilt release packages, see [Install the native SDK](installation.md).

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

To try the build, set `OPENAI_API_KEY` and run `pnpm exec tsx examples/codex/basic.ts` from the repository root. The [greeting example](../basic.ts) asks the model to call a local tool and prints the final answer.

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

### Qualify the OTLP collectors

The native tracing tests use optional Python collectors to decode OTLP payloads. Without `grpcio` and `opentelemetry-proto`, collector cases skip during an ordinary native test run. TLS collector cases also need the `openssl` executable. A passing suite with those skips does not qualify the decoded OTLP transports.

To run the Linux CI qualification locally, create a test-only virtual environment outside the checkout. In a POSIX shell, run the following commands from the repository root:

```sh
OTLP_DIRECTORY=$(mktemp -d)
python3 -m venv "$OTLP_DIRECTORY"
"$OTLP_DIRECTORY/bin/python" -m pip install grpcio==1.85.0 opentelemetry-proto==1.45.1
AGENTS_REQUIRE_TRACING_QUALIFICATION=1 OPENAI_AGENTS_NATIVE_TESTS=1 OTLP_TEST_PYTHON="$OTLP_DIRECTORY/bin/python" pnpm exec vitest run --project @openai/agents-codex packages/agents-codex/test/native/tracing-parity.test.ts packages/agents-codex/test/native/telemetry-transports.test.ts
```

`OTLP_TEST_PYTHON` selects the collector interpreter. `AGENTS_REQUIRE_TRACING_QUALIFICATION=1` makes missing collector dependencies or TLS tooling fail instead of skipping. These dependencies belong to the test environment; application installations do not need them. The [alpha artifact workflow](https://github.com/openai/openai-agents-js/blob/feat/codex-harness/.github/workflows/alpha-release-artifacts.yml) owns the package versions and qualification command.

## Keep source-built packages together

The current source build places the Codex runtime in `@openai/agents-codex`. Its local bundle contains five matching tarballs: `@openai/agents`, `@openai/agents-codex`, `@openai/agents-core`, `@openai/agents-openai`, and `@openai/agents-realtime`. Applications import from `@openai/agents` and its supported subpaths.

### Build a local bundle for an application

The existing bundle producer supports Linux x64, macOS Apple silicon, and Windows x64. Build on the platform that will run the application. Use a POSIX shell, such as Git Bash on Windows, with the host build tools available on `PATH`.

Start from a clean, committed source checkout. The producer records its commit and rejects uncommitted source changes. Complete the source prerequisites above, then run these commands from the repository root. The native `package` command prepares the pinned source and creates the release build required by the producer; the ordinary debug `native:build` is insufficient for packaging.

```sh
pnpm install --frozen-lockfile
node packages/agents-codex/scripts/native.mjs package
pnpm build
BUNDLE_DIRECTORY=$(node -p "require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'agents-bundle-'))")
node scripts/alpha-package.mjs --version 0.22.0-alpha.2 --output "$BUNDLE_DIRECTORY"
node scripts/verify-alpha-package.mjs --directory "$BUNDLE_DIRECTORY"
```

The version argument labels your local artifacts and must have the form `X.Y.Z-alpha.N`. `BUNDLE_DIRECTORY` is an absolute, initially empty directory outside the checkout. Keep that path for the next steps. The producer writes five SDK tarballs, a starter archive, checksums, and a build record there. The verifier installs the bundle into temporary external applications and checks public ESM/CommonJS imports, TypeScript declarations, native helpers, and scripted tool/session behavior without a model key.

Extract the generated starter into the same output directory:

```sh
PLATFORM=$(node -p "process.platform + '-' + process.arch")
tar -xzf "$BUNDLE_DIRECTORY/agents-starter-0.22.0-alpha.2-$PLATFORM.tar.gz" -C "$BUNDLE_DIRECTORY"
```

To add this build to an existing application, copy the extracted `agents-starter/vendor/agents/` directory into the application's `vendor/agents/` directory. Merge the generated `agents-starter/package.json` **dependencies** and **overrides** into the application's manifest, preserving its other entries. Include all five SDK dependencies and all four SDK overrides, including `@openai/agents-codex`, from that generated file. This keeps transitive imports on the same local packages.

From the application directory, run `npm install --ignore-scripts` and retain its new lockfile together with all five tarballs. This flag disables lifecycle scripts for the whole installation; complete any application-owned dependency setup separately. For later installs, use `npm ci --ignore-scripts`. Run the [scripted native check](../../../packages/agents-codex/TESTING.md) in that application before making a live request. It verifies the installed native tool loop without model credentials.

The published `0.22.0-alpha.1` bundles predate this split and contain four tarballs. Follow their [release installation instructions](installation.md#add-the-sdk-to-an-existing-application) when using that release.
