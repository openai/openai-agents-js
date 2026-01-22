import {
  Agent,
  MCPServerStreamableHttp,
  connectMcpServers,
  run,
} from '@openai/agents';

async function main() {
  const servers = [
    new MCPServerStreamableHttp({
      url: 'https://mcp.deepwiki.com/mcp',
      name: 'DeepWiki MCP Server',
    }),
    new MCPServerStreamableHttp({
      url: 'http://localhost:8001/mcp',
      name: 'Local MCP Server',
    }),
  ];

  const mcpServers = await connectMcpServers(servers, {
    connectInParallel: true,
  });

  try {
    console.log(`Active servers: ${mcpServers.active.length}`);
    console.log(`Failed servers: ${mcpServers.failed.length}`);
    for (const [server, error] of mcpServers.errors) {
      console.warn(`${server.name} failed to connect: ${error.message}`);
    }

    const agent = new Agent({
      name: 'MCP lifecycle agent',
      instructions: 'Use MCP tools to answer user questions.',
      mcpServers: mcpServers.active,
    });

    const result = await run(
      agent,
      'Which language is the openai/codex repository written in?',
    );
    console.log(result.finalOutput);
  } finally {
    await mcpServers.close();
  }
}

main().catch(console.error);
