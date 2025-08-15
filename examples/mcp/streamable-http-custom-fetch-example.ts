import { Agent, run, MCPServerStreamableHttp, withTrace } from '@openai/agents';

async function main() {
  // Example of using a custom fetch implementation
  const customFetch = async (url: string | URL, init?: RequestInit) => {
    console.log(`Custom fetch called for URL: ${url}`);
    // You could add custom headers, logging, retries, etc. here
    const response = await fetch(url, {
      ...init,
      headers: {
        ...init?.headers,
        'User-Agent': 'MyCustomAgent/1.0',
        'X-Custom-Header': 'custom-value',
      },
    });
    console.log(`Response status: ${response.status}`);
    return response;
  };

  const mcpServer = new MCPServerStreamableHttp({
    url: 'https://gitmcp.io/openai/codex',
    name: 'GitMCP Documentation Server',
    fetch: customFetch, // Pass custom fetch implementation
  });

  const agent = new Agent({
    name: 'GitMCP Assistant',
    instructions: 'Use the tools to respond to user requests.',
    mcpServers: [mcpServer],
  });

  try {
    await withTrace('GitMCP Documentation Server Example with Custom Fetch', async () => {
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
