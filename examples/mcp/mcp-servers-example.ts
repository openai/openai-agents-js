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
      name: 'DeepWiki MCP Streamable HTTP Server',
    }),
    new MCPServerStreamableHttp({
      url: 'http://localhost:8001/mcp',
      name: 'Inactive MCP Streamable HTTP Server',
    }),
  ];

  console.log(`Connecting MCP servers...`);
  const mcpServers = await connectMcpServers(servers, {
    connectInParallel: true,
  });

  // or using async disposal with tsconfig.json:
  // "compilerOptions": {
  //   "lib": ["ES2018", "DOM", "esnext.disposable"]
  // }
  // simply having the following line, no need to have the finally block:
  // await using mcpServers = await connectMcpServers(servers);

  console.log(`MCP servers connected: ${mcpServers.active.length}`);

  try {
    const agent = new Agent({
      name: 'Coding expert agent',
      instructions:
        'You are a coding expert. When you get a question, you should use the MCP tools to answer the question.',
      mcpServers: mcpServers.active,
    });
    const query =
      'For the repository openai/codex, tell me the primary programming language.';
    console.log(`> ${query}`);
    const result = await run(agent, query);
    console.log(result.finalOutput);
  } finally {
    await mcpServers.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
