import { Agent, run, MCPServerStreamableHttp, withTrace } from '@openai/agents';

async function main() {
  const mcpServer = new MCPServerStreamableHttp({
    url: 'https://mcp.deepwiki.com/mcp',
    name: 'DeepWiki MCP Streamable HTTP Server',
    clientSessionTimeoutSeconds: 15,
    timeout: 15000,
    reconnectionOptions: {
      maxRetries: 2,
      initialReconnectionDelay: 2000,
      reconnectionDelayGrowFactor: 2,
      maxReconnectionDelay: 30000,
    },
  });
  const agent = new Agent({
    name: 'DeepWiki Assistant',
    instructions: 'Use the tools to respond to user requests.',
    mcpServers: [mcpServer],
  });

  try {
    await withTrace('DeepWiki Streamable HTTP Example', async () => {
      await mcpServer.connect();
      const result = await run(
        agent,
        'For the repository openai/codex, tell me the primary programming language.',
      );
      console.log(result.finalOutput);
    });
  } finally {
    await mcpServer.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
