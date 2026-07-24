// A minimal stdio MCP server that emits `notifications/message` logging events
// while a long-running tool executes. Used by `logging-example.ts` to
// demonstrate subscribing to server logs from an Agent.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

async function main() {
  const server = new McpServer(
    { name: 'logging-demo-server', version: '1.0.0' },
    { capabilities: { logging: {} } },
  );

  server.tool(
    'analyze',
    'Pretend to analyze something, emitting progress logs along the way.',
    async () => {
      const steps = ['loading data', 'crunching numbers', 'finalizing report'];
      for (const [index, step] of steps.entries()) {
        await server.server.sendLoggingMessage({
          level: 'info',
          logger: 'analyze',
          data: `step ${index + 1}/${steps.length}: ${step}`,
        });
      }
      return { content: [{ type: 'text', text: 'Analysis complete.' }] };
    },
  );

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
