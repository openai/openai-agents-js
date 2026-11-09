# Trusted stdio and programmatic tools

These two examples use synthetic data and native execution. They require Node.js 24, the checkout's pinned pnpm version, and [matching built packages and native products](../guides/building.md), including the bundled Code Mode host. Scripted mode uses a local Responses peer and needs no model key.

The catalog example lets the application choose `process.execPath`, the exact peer file, its working directory and the raw tool name `lookup`. The model cannot choose a process or grant launch authority through saved state. The peer uses Node's standard library and supports only initialization, ping, listing and a synthetic lookup. Its `readOnlyHint` is metadata. The peer still has the host permissions of its process. Treat choosing a peer as a trust decision.

## Run and check the results

Run from the repository root:

```sh
pnpm exec tsx examples/codex/stdio-programmatic/local-mcp.ts --mode scripted
pnpm exec tsx examples/codex/stdio-programmatic/programmatic-tools.ts --mode scripted
```

Each command validates actual tool output before printing its scripted answer. The catalog prints `It costs 5 dollars.` Sales prints `Paper sales total 50 dollars.` Their 20-second deadlines bound only result waits after submission, so opening and cleanup can take longer. Importing either module defines functions without opening a Session or model connection. The callback-scoped scripted provider owns provider cleanup. Each runner closes its Session before returning.

## Choose the execution route

Core starts the peer lazily. Keep its Session alive while calling it, then await Session cleanup before closing the provider or deleting audit files. A model failure also requires joined cleanup. The tests observe the specific peer's PID rather than inspecting or stopping unrelated processes.

The sales example admits only `regional_sales`, with north and south as accepted regions. Application callbacks return synthetic rows. Model-generated JavaScript calls these tools in the bundled V8 host, parses the JSON strings and sums the paper amounts to 50 dollars. Ordinary direct calls are sufficient for a single lookup. Code Mode is useful when results require aggregation.

V8 execution does not provide arbitrary Python, a shell or unrestricted Node access. Keep pending cells with their live Session. Saved conversation history does not preserve VM state, and this example makes no resume or fork promise. Neither example installs an elicitation handler. Use the [native interaction flow](../guides/interactions.md#native-questions) when your application needs to answer supported forms.
