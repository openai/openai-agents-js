import { Agent, run, MCPServerStdio, withTrace } from '@openai/agents';
import { createRequire } from 'node:module';
import * as path from 'node:path';

async function main() {
  const require = createRequire(import.meta.url);
  const samplesDir = path.join(__dirname, 'sample_files');
  const mcpServer = new MCPServerStdio({
    name: 'Filesystem Server, via local package',
    command: process.execPath,
    args: [
      require.resolve('@modelcontextprotocol/server-filesystem/dist/index.js'),
      samplesDir,
    ],
  });

  await mcpServer.connect();

  try {
    await withTrace('MCP Filesystem Example', async () => {
      const agent = new Agent({
        name: 'MCP Assistant',
        instructions:
          'Use the tools to read the filesystem and answer questions based on those files. If you are unable to find any files, you can say so instead of assuming they exist.',
        mcpServers: [mcpServer],
      });
      // List the files it can read
      let message = 'Read the files and list them.';
      console.log(`Running: ${message}`);
      let result = await run(agent, message);
      console.log(result.finalOutput);

      // Ask about books
      message = 'What is my #1 favorite book?';
      console.log(`\nRunning: ${message}\n`);
      result = await run(agent, message);
      console.log(result.finalOutput);

      // Ask a question that reads then reasons
      message =
        'Look at my favorite songs. Suggest one new song that I might like.';
      console.log(`\nRunning: ${message}\n`);
      result = await run(agent, message);
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
