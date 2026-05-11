import { Agent, run, MCPServerStreamableHttp } from '@openai/agents';

async function main() {
  const mcpServer = new MCPServerStreamableHttp({
    url: 'https://mcp.deepwiki.com/mcp',
    name: 'DeepWiki MCP Server',
  });
  const agent = new Agent({
    name: 'DeepWiki Assistant',
    instructions: 'Use the tools to respond to user requests.',
    mcpServers: [mcpServer],
  });

  try {
    await mcpServer.connect();
    const result = await run(
      agent,
      'For the repository openai/codex, tell me the primary programming language.',
    );
    console.log(result.finalOutput);
  } finally {
    await mcpServer.close();
  }
}

main().catch(console.error);
