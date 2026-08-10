import { MCPServerStreamableHttp, connectMcpServers } from '@openai/agents';

async function main() {
  const servers = [
    new MCPServerStreamableHttp({
      url: 'https://your-mcp-server.invalid/mcp',
      name: 'Docs server',
    }),
  ];

  await using mcpServers = await connectMcpServers(servers);
  console.log(`Connected to ${mcpServers.active.length} MCP server(s).`);
}

main().catch(console.error);
