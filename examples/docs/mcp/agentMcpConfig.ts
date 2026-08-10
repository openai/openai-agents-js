import { Agent, MCPServerStreamableHttp } from '@openai/agents';

const server = new MCPServerStreamableHttp({
  url: 'https://your-mcp-server.invalid/mcp',
  name: 'Docs server',
});

const agent = new Agent({
  name: 'Assistant',
  mcpServers: [server],
  mcpConfig: {
    // Try to convert MCP tool schemas to strict JSON schema.
    convertSchemasToStrict: true,
    // Set to null to raise MCP tool failures instead of returning model-visible error text.
    errorFunction: null,
    // Prefix local MCP tool names with their server name.
    includeServerInToolNames: true,
  },
});
