# Hosted Model Context Protocol Example

This example demonstrates how to use [OpenAI Hosted MCP](https://platform.openai.com/docs/guides/tools-remote-mcp) servers with the OpenAI Agents SDK.

The example shows two different scenarios:

- `simple.ts` - A basic example of connecting to a hosted MCP server with no approval required.
- `approvals.ts` - An example showing how to use an approvals workflow with a hosted MCP server.

Run the examples from the repository root:

### Simple

```bash
pnpm -F hosted-mcp start:simple
```

### Approvals

```bash
pnpm -F hosted-mcp start:approvals
```
