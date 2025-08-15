import { Agent, run, MCPServerSSE, withTrace } from '@openai/agents';

async function main() {
  const mcpServer = new MCPServerSSE({
    url: 'https://gitmcp.io/openai/codex',
    name: 'SSE MCP Server',
  });

  const agent = new Agent({
    name: 'SSE Assistant',
    instructions: 'Use the tools to respond to user requests.',
    mcpServers: [mcpServer],
  });

  try {
    await withTrace('SSE MCP Server Example', async () => {
      await mcpServer.connect();
      const result = await run(
        agent,
        'Please help me with the available tools.',
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
