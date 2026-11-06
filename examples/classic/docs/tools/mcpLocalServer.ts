import { Agent, MCPServerStdio, run } from '@openai/agents/classic';

const server = new MCPServerStdio({
  command: 'npx',
  args: ['--no', 'mcp-server-filesystem', './sample_files'],
});

try {
  await server.connect();
  const agent = new Agent({
    name: 'Assistant',
    mcpServers: [server],
  });
  const result = await run(agent, 'List the sample files.');
  console.log(result.finalOutput);
} finally {
  await server.close();
}
