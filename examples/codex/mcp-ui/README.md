# Run a native MCP app in a browser

This local counter shows two SDK features together. The official AI SDK client reads assistant text, the actual MCP tool arguments and result, and stream completion from `@openai/agents/ui` and `vercelResponse`. The official MCP Apps `AppBridge` then mounts the tool's HTML resource in a sandboxed iframe. Clicking **Increment** makes the iframe's `App` send `tools/call` through the same native `MCPApp` and updates its count.

The Responses model and MCP server are synthetic loopback fixtures. No API key or external service is required. This checks browser integration and native transport behavior; it does not test model quality or production authentication.

## Run

Use the source checkout prepared by [CONTRIBUTING.md](../../../CONTRIBUTING.md), with the native addon and SDK packages built from this source. This native example has been requiring Node.js 24 and the repository's pinned pnpm setup. This example uses the new `@openai/agents/ui` and `@openai/agents/mcp-apps` exports.

Run from the repository root after the contributor setup and package build:

```sh
npm --prefix examples/codex/mcp-ui ci --ignore-scripts
npm --prefix examples/codex/mcp-ui run build
NO_PROXY=127.0.0.1,localhost node_modules/.bin/tsx examples/codex/mcp-ui/server.ts 8081
```

Open [the counter](http://127.0.0.1:8081) and click **Open counter**. The page shows `Counter opened.`, tool input `{"amount":1}`, a result with count `1`, and status `Complete`. The iframe shows count `1`. Click **Increment** inside the iframe to show count `2`. Restart the server to open another counter.

## Check the browser flow

Install the pinned Playwright browser once, then run the test from the repository root:

```sh
cd examples/codex/mcp-ui
npx playwright install chromium
cd ../../..
OPENAI_AGENTS_BROWSER_TESTS=1 NO_PROXY=127.0.0.1,localhost OPENAI_AGENTS_NATIVE_TESTS=1 node node_modules/vitest/vitest.mjs run --project @openai/agents-codex packages/agents-codex/test/native/mcp-ui-browser.test.ts --maxWorkers 1
```

The test needs a host that supports Chromium's sandbox. It does not disable the sandbox. A container that blocks Chromium user namespaces may need a supported browser-test host. Set `CHROMIUM_PATH` to use another compatible Chromium executable. The test runs only when `OPENAI_AGENTS_BROWSER_TESTS=1`. Once enabled, missing frontend assets, a missing browser, or a failed launch fails the test.

The browser test checks text, actual tool data, completion, the iframe's action response, rejection of an incorrect view token, and rejection of messages from another window.

## Local fixture boundaries

The server listens only on `127.0.0.1`. Visiting its page selects one synthetic user with an HTTP-only cookie. Browser actions must match that user, the page's origin, and the random token for the opened view. `MCPApp` permits only the originating `increment` tool. The fixture accepts only an increment of `1` and one model turn per process.

The server sets `includeToolData: true` so the browser receives full tool arguments and results.

The iframe has `sandbox="allow-scripts"` without same-origin access. Its CSP permits only the local app script and denies network connections. The public script allows CORS so that the opaque iframe can load it. The official postMessage transport checks the sending window; only the host makes authenticated HTTP actions. Keep this example private. Replace its synthetic identity and fixed permissions before building a shared application.

Frontend dependencies are pinned in `package-lock.json`. `ai` consumes the UI stream; `@modelcontextprotocol/ext-apps` owns the iframe protocol. The SDK owns native tool execution. The example adds no competing client protocol.

The peer advertises `_meta.ui.resourceUri` in `tools/list` and returns ordinary text and structured tool data. `MCPApp.open` reads that exact HTML resource through the selected native connection. It captures current negotiated metadata when opened, rather than historical tool metadata; later remote metadata changes do not retarget the captured view. Without a declared URI, embedded or linked HTML results remain supported.
