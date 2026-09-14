# Model Context Protocol Example

This example demonstrates how to use the [Model Context Protocol](https://modelcontextprotocol.io/) with the OpenAI Agents SDK.

`filesystem-example.ts` starts a local MCP server exposing the files inside `sample_files/`. The agent reads those files through the protocol and can answer questions about them. The directory includes:

- `books.txt` – A list of favorite books.
- `favorite_songs.txt` – A list of favorite songs.

Run the example from the repository root:

```bash
pnpm -F mcp start:stdio
```

`tool-filter-example.ts` shows how to expose only a subset of server tools:

```bash
pnpm -F mcp start:tool-filter
```

`get-all-mcp-tools-example.ts` demonstrates how to use the `getAllMcpTools` function to fetch tools from multiple MCP servers:

```bash
pnpm -F mcp start:get-all-tools
```

`mcp-servers-example.ts` shows how to manage multiple servers with `MCPServers`:

```bash
pnpm -F mcp start:mcp-servers
```

## Runtime requirements

Use Node.js 22.18 or later within the 22.x line, Node.js 24.x, or Node.js 26 or later. The following commands execute TypeScript directly with Node.js: `start:stdio`, `start:streamable-http`, `start:hosted-mcp-on-approval`, `start:hosted-mcp-human-in-the-loop`, `start:hosted-mcp-simple`, `start:tool-filter`, `start:sse`, `start:get-all-tools`.
