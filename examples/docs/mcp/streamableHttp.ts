import { Agent, run, MCPServerStreamableHttp } from '@openai/agents';

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
    await mcpServer.connect();
    const result = await run(agent, 'Which language is this repo written in?');
    console.log(result.finalOutput);
  } finally {
    await mcpServer.close();
  }
}

main().catch(console.error);
