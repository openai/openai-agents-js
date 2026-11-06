# Classic examples

These examples use the retained classic SDK. See the [classic API guide](../../packages/agents/CLASSIC.md) for its entry points.

Each example directory has its own `package.json` with setup and start commands. From the repository root, install dependencies and build the SDK:

```sh
pnpm install --frozen-lockfile
pnpm build
```

For example, run `pnpm examples:basic` for a basic agent or `pnpm examples:realtime-demo` for the Realtime demo. Check the selected example's README for credentials and other prerequisites.

For the native Codex runtime, use the [Codex examples](../codex/README.md).
