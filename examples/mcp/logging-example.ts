import { Agent, run, MCPServerStdio, withTrace } from '@openai/agents';
import * as path from 'node:path';

async function main() {
  const serverPath = path.join(__dirname, 'logging-server.ts');
  const mcpServer = new MCPServerStdio({
    name: 'Logging Demo Server',
    command: 'pnpm',
    args: ['tsx', serverPath],
    // Subscribe to logs the server emits while tools run. `level` requests a
    // minimum severity from the server; `handler` receives each notification.
    serverLogging: {
      level: 'info',
      handler: ({ level, logger, data }) => {
        const source = logger ? `${logger}` : 'server';
        console.log(`[mcp:${level}] (${source}) ${JSON.stringify(data)}`);
      },
    },
  });

  await mcpServer.connect();

  try {
    await withTrace('MCP Server Logging Example', async () => {
      const agent = new Agent({
        name: 'MCP Assistant',
        instructions: 'Use the analyze tool to answer the user.',
        mcpServers: [mcpServer],
        modelSettings: { toolChoice: 'required' },
      });
      const result = await run(agent, 'Run an analysis and summarize it.');
      console.log(`\n${result.finalOutput}`);
    });
  } finally {
    await mcpServer.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
