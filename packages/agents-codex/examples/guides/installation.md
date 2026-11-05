# Install the native SDK

Run the included starter or add the prebuilt SDK packages to an existing application.

## Requirements

Use Node.js 24 with its bundled npm. Choose a bundle for your operating system and architecture. The Linux x64 bundle requires glibc 2.39 or later and OpenSSL 3. On a minimal Ubuntu 24.04 system, install `libssl3t64`.

The Windows x64 bundle uses the Microsoft Visual C++ runtime. If Windows reports that `VCRUNTIME140.dll` is missing, install the [x64 Visual C++ Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist/).

## Run the starter bundle

Download the starter archive for the machine that will run your application from the [0.22.0-alpha.1 GitHub prerelease](https://github.com/openai/openai-agents-js/releases/tag/v0.22.0-alpha.1).

| Platform            | Starter archive                                     |
| ------------------- | --------------------------------------------------- |
| Linux x64           | `agents-starter-0.22.0-alpha.1-linux-x64.tar.gz`    |
| macOS Apple silicon | `agents-starter-0.22.0-alpha.1-darwin-arm64.tar.gz` |
| Windows x64         | `agents-starter-0.22.0-alpha.1-win32-x64.tar.gz`    |

Each archive includes the built SDK, the compiled Codex runtime, a lockfile, and a JavaScript example. Verify the archive against `SHA256SUMS-<platform>` from the same release, then extract it. The release's `build-<platform>.json` records the package build.

Set `OPENAI_API_KEY` in your environment and run these commands from the extracted `agents-starter` directory.

```sh
npm ci --ignore-scripts
node hello.mjs
```

The example makes a live model request and prints a greeting. npm installs the SDK packages from the bundle and downloads third-party dependencies from your configured registry. Keep the lockfile and bundled packages together.

If `npm ci` reports `ETARGET`, your registry may be missing a version from the lockfile. Ask your registry administrator to sync that version, or follow the [existing application setup](#add-the-sdk-to-an-existing-application) in a new directory to resolve compatible dependencies. Copy `hello.mjs` there and run `node hello.mjs` with `OPENAI_API_KEY` set.

## Add the SDK to an existing application

The starter contains four SDK tarballs in `vendor/agents/`. The release also provides them separately. Use all four from the same version and platform. They include the prebuilt native runtime.

Copy the four tarballs into your application's `vendor/agents/` directory. Merge these entries into your `package.json`. The example uses version `0.22.0-alpha.1` and platform `linux-x64`. Use the filenames from your download.

```json
{
  "dependencies": {
    "@openai/agents": "file:vendor/agents/openai-agents-0.22.0-alpha.1-linux-x64.tgz",
    "@openai/agents-core": "file:vendor/agents/openai-agents-core-0.22.0-alpha.1-linux-x64.tgz",
    "@openai/agents-openai": "file:vendor/agents/openai-agents-openai-0.22.0-alpha.1-linux-x64.tgz",
    "@openai/agents-realtime": "file:vendor/agents/openai-agents-realtime-0.22.0-alpha.1-linux-x64.tgz"
  },
  "overrides": {
    "@openai/agents-core": "$@openai/agents-core",
    "@openai/agents-openai": "$@openai/agents-openai",
    "@openai/agents-realtime": "$@openai/agents-realtime"
  }
}
```

The overrides keep transitive SDK dependencies on the same local packages. Run `npm install --ignore-scripts` from your application's directory to update its lockfile. Keep the lockfile and the four tarballs. For later installs, run `npm ci --ignore-scripts`.

## Run the classic extensions

The alpha bundle includes the core SDK packages. Run examples that use `@openai/agents-extensions` from a checkout of the `feat/codex-harness` branch so the SDK and extensions use the same revision.

Use Node.js 24 and the pnpm version pinned in `package.json`. From the repository root, install dependencies and build the TypeScript packages:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Then follow the setup for the [AI SDK examples](https://github.com/openai/openai-agents-js/tree/feat/codex-harness/examples/ai-sdk) or [Twilio example](https://github.com/openai/openai-agents-js/tree/feat/codex-harness/examples/realtime-twilio).

## Deno and Bun

Deno needs a local `node_modules` directory to load the native addon. For a package installed with npm or pnpm, use `deno run --node-modules-dir=manual --allow-ffi --allow-read --allow-write --allow-env --allow-net app.ts`.

Scope file, environment, and network permissions to your application. Native addons run outside Deno's permission sandbox. The `--allow-ffi` flag grants native code access to the host. See [Deno's native-addon requirements](https://docs.deno.com/runtime/fundamentals/node/#use-packages-with-native-addons).

Bun loads the addon without an additional permission flag.

## Next steps

[Run an agent](../../README.md#run-an-agent) in your application or browse the [examples](../README.md). Use guides and examples from the same release as your SDK. To work on the SDK itself, see [Build the native SDK from source](building.md).
