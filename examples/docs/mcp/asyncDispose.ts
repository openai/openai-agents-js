import { MCPServerStreamableHttp, connectMcpServers } from '@openai/agents';

async function main() {
  const servers = [
    new MCPServerStreamableHttp({
      url: 'https://your-own-domain-here/mcp',
      name: 'Docs server',
    }),
  ];

  await using mcpServers = await connectMcpServers(servers);
}

main().catch(console.error);
