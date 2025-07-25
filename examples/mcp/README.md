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
