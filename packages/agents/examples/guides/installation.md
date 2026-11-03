# Install the native SDK

Install the preview from a release bundle. You can run the included starter or add the same SDK packages to an existing application.

## Preview availability

**The first release with the Codex harness is not available yet.** When it ships, follow the steps below using files from the matching [GitHub release](https://github.com/openai/openai-agents-js/releases).

## Requirements

Use Node.js 24 with its bundled npm. Choose a bundle for your operating system and architecture. The Linux x64 bundle requires glibc 2.39 or later and OpenSSL 3. On a minimal Ubuntu 24.04 system, install `libssl3t64`.

## Run the starter bundle

1. Download `agents-starter-<version>-<platform>.tar.gz` for your platform. It includes the prebuilt SDK, the native runtime, a lockfile, and a JavaScript example.
2. Verify the archive against `SHA256SUMS-<platform>` from the same release, then extract it. The release's `build-<platform>.json` records the package build.
3. Set `OPENAI_API_KEY` in your environment. Run these commands from the extracted `agents-starter` directory.

   ```sh
   npm ci --ignore-scripts
   node hello.mjs
   ```

The example makes a live model request and prints a greeting. npm reads the SDK packages from the bundle and downloads third-party dependencies from your configured registry. Keep the lockfile and bundled packages together.

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

## Deno and Bun

Deno needs a local `node_modules` directory to load the native addon. For a package installed with npm or pnpm, use `deno run --node-modules-dir=manual --allow-ffi --allow-read --allow-write --allow-env --allow-net app.ts`.

Scope file, environment, and network permissions to your application. Native addons run outside Deno's permission sandbox. The `--allow-ffi` flag grants native code access to the host. See [Deno's native-addon requirements](https://docs.deno.com/runtime/fundamentals/node/#use-packages-with-native-addons).

Bun loads the addon without an additional permission flag.

## Next steps

[Run an agent](../../README.md#run-an-agent) in your application or browse the [examples](../README.md). Use guides and examples from the same release as your SDK. To work on the SDK itself, see [Build the native SDK from source](building.md).
