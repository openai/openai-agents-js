# Install the native SDK

Run the included starter or add the prebuilt SDK packages to an existing application.

## Requirements

- To run a current source-built bundle, use Node.js 22 or later. For the build toolchain, see [Build from source](building.md#build-from-source).
- To use `SQLiteMemory`, use Node.js 22.13 or later, with [unflagged SQLite support](https://nodejs.org/en/blog/release/v22.13.0).
- To run the alpha.2 starter below, use Node.js 24 with its bundled npm.

Choose a bundle for your operating system and architecture. The Linux x64 bundle requires glibc 2.39 or later and OpenSSL 3. On a minimal Ubuntu 24.04 system, install `libssl3t64`.

The Windows x64 bundle uses the Microsoft Visual C++ runtime. If Windows reports that `VCRUNTIME140.dll` is missing, install the [x64 Visual C++ Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist/).

To run repository examples, build the SDK and examples from the same checkout using the [source-build guide](building.md). For the alpha.2 versions of those examples, check out the `v0.22.0-alpha.2` tag first. External applications need the matching five-package bundle. The alpha.2 starter below includes those five packages and a greeting example to check the installation.

## Run the starter bundle

Choose the starter archive for the machine that will run your application from the [0.22.0-alpha.2 GitHub prerelease](https://github.com/openai/openai-agents-js/releases/tag/v0.22.0-alpha.2). These prebuilt bundles and the current source checkout can expose different features. Use the [guides and examples at the alpha.2 tag](https://github.com/openai/openai-agents-js/blob/v0.22.0-alpha.2/README.md#sdk-guides) with this starter.

| Platform            | Starter archive                                     |
| ------------------- | --------------------------------------------------- |
| Linux x64           | `agents-starter-0.22.0-alpha.2-linux-x64.tar.gz`    |
| macOS Apple silicon | `agents-starter-0.22.0-alpha.2-darwin-arm64.tar.gz` |
| Windows x64         | `agents-starter-0.22.0-alpha.2-win32-x64.tar.gz`    |

Each archive includes the built SDK, the compiled Codex runtime, a lockfile, and a JavaScript example.

1. Verify the archive against `SHA256SUMS-<platform>` from the same release. The release's `build-<platform>.json` records the package build.
2. Extract the archive and open its `agents-starter` directory.
3. Set `OPENAI_API_KEY` in your environment, then install dependencies and run the greeting example below.

The greeting makes a live model request.

```sh
npm ci --ignore-scripts
node hello.mjs
```

The example prints a greeting. npm installs the SDK packages from the bundle and downloads third-party dependencies from your configured registry. Keep the lockfile and bundled packages together.

### If your registry is missing a dependency

If `npm ci` reports `ETARGET`, ask your registry administrator to sync the version named in the error.

To try the starter immediately, copy `package.json`, `hello.mjs`, and the entire `vendor/` directory into a new directory. Install and run the starter from there.

```sh
npm install --ignore-scripts
node hello.mjs
```

npm uses the five bundled SDK packages and resolves their third-party dependencies from your registry. Keep the new `package-lock.json` for later installs.

## Add the SDK to an existing application

The starter contains five SDK tarballs in `vendor/agents/`. The release also provides them separately. Use all five from the same version and platform. The `@openai/agents-codex` package includes the prebuilt native runtime. Applications continue to import from `@openai/agents` and its supported subpaths.

Copy the five tarballs into your application's `vendor/agents/` directory. Merge these entries into your `package.json`. The example uses version `0.22.0-alpha.2` and platform `linux-x64`. Use the filenames from your download.

```json
{
  "dependencies": {
    "@openai/agents": "file:vendor/agents/openai-agents-0.22.0-alpha.2-linux-x64.tgz",
    "@openai/agents-codex": "file:vendor/agents/openai-agents-codex-0.22.0-alpha.2-linux-x64.tgz",
    "@openai/agents-core": "file:vendor/agents/openai-agents-core-0.22.0-alpha.2-linux-x64.tgz",
    "@openai/agents-openai": "file:vendor/agents/openai-agents-openai-0.22.0-alpha.2-linux-x64.tgz",
    "@openai/agents-realtime": "file:vendor/agents/openai-agents-realtime-0.22.0-alpha.2-linux-x64.tgz",
    "zod": "^4.3.5"
  },
  "overrides": {
    "@openai/agents-codex": "$@openai/agents-codex",
    "@openai/agents-core": "$@openai/agents-core",
    "@openai/agents-openai": "$@openai/agents-openai",
    "@openai/agents-realtime": "$@openai/agents-realtime"
  }
}
```

The overrides keep transitive SDK dependencies on the same local packages. Run `npm install --ignore-scripts` from your application's directory to update its lockfile. Keep the lockfile and the five tarballs. For later installs, run `npm ci --ignore-scripts`.

### Keep native tool declarations with their SDK instance

In `0.22.0-alpha.2`, mixing ESM `import` and CommonJS `require` or loading separate installed copies has been creating separate SDK instances, even at the same version. Native Sessions have been accepting function declarations only from their own SDK instance.

Using the same module format and SDK installation for `Agent`, `tool()`, and helpers such as `SQLiteMemory` has been avoiding this problem in alpha.2. Passing your application's `tool` factory to a library has been keeping that library's declarations with the consuming Session.

The current [source build](building.md) has been sharing native v1 class and tool identity between ESM and CommonJS imports from one installed SDK on Node.js 24 with its default module settings. Separate installed copies have been retaining separate identities. Using one SDK installation has still been keeping declarations and Sessions together.

## Run the classic extensions

The alpha bundle includes the core SDK packages. Run examples that use `@openai/agents-extensions` from a checkout of the `v0.22.0-alpha.2` tag so the SDK and extensions use the same revision.

Use Node.js 24 and the pnpm version pinned in `package.json`. From the repository root, install dependencies and build the TypeScript packages:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Then follow the setup for the [AI SDK examples](https://github.com/openai/openai-agents-js/tree/v0.22.0-alpha.2/examples/classic/ai-sdk) or [Twilio example](https://github.com/openai/openai-agents-js/tree/v0.22.0-alpha.2/examples/classic/realtime-twilio).

## Deno and Bun

Deno needs a local `node_modules` directory to load the native addon. For a package installed with npm or pnpm, use `deno run --node-modules-dir=manual --allow-ffi --allow-read --allow-write --allow-env --allow-net app.ts`.

Scope file, environment, and network permissions to your application. Native addons run outside Deno's permission sandbox. The `--allow-ffi` flag grants native code access to the host. See [Deno's native-addon requirements](https://docs.deno.com/runtime/fundamentals/node/#use-packages-with-native-addons).

Bun loads the addon without an additional permission flag.

## Check the installed runtime

Run the [scripted native check](../../../packages/agents-codex/TESTING.md) from your application directory to exercise the addon, native runtime, and one local tool without a model key. The script exits silently when its assertions pass. It needs loopback HTTP access and the same platform prerequisites as a live run.

### Diagnose an addon load error

The current source build reports the Node.js platform and architecture when the addon fails to load. Read the original loader error included in that message.

- If Node.js cannot find `codex.node`, check that the lockfile selects the matching local SDK tarballs, including `@openai/agents-codex`. For a source build, follow the [five-package bundle procedure](building.md#build-a-local-bundle-for-an-application).
- If Node.js finds the addon but cannot load it, compare the bundle with the platform and architecture of the running Node.js process. Install any missing system library listed under [Requirements](#requirements).

If the scripted check passes but a live request fails, check credentials, endpoint access, and model availability in [session configuration](session-configuration.md#provider-connection-and-credentials).

## Next steps

[Run an agent](../../../packages/agents-codex/README.md#run-an-agent) in your application or browse the [examples](../README.md). Use guides and examples from the same release as your SDK. To work on the SDK itself, see [Build the native SDK from source](building.md).
