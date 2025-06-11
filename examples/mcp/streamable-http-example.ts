import { Agent, run, MCPServerStreamableHttp, withTrace } from '@openai/agents';

async function main() {
  const mcpServer = new MCPServerStreamableHttp({
    url: 'https://gitmcp.io/openai/codex',
    name: 'GitMCP Documentation Server',
  });
  const agent = new Agent({
    name: 'GitMCP Assistant',
    instructions: 'Use the tools to respond to user requests.',
    mcpServers: [mcpServer],
  });

  try {
    await withTrace('GitMCP Documentation Server Example', async () => {
      await mcpServer.connect();
      const result = await run(
        agent,
        'Which language is this repo written in?',
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
