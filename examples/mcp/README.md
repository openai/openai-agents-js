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

`agent-discovery-example.ts` connects to a remote registry of third-party agents and discovers, at runtime, which of them can do a task the user needs done. Since the candidates it turns up are agents the user has never worked with, it then checks the trust data the registry returns for each one before recommending any. The registry also exposes tools that mutate its state, so the example uses `createMCPToolStaticFilter` to allow only the read-only lookups:

```bash
pnpm -F mcp start:agent-discovery
```
