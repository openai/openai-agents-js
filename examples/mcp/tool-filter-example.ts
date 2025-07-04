import {
  Agent,
  run,
  MCPServerStdio,
  createStaticToolFilter,
  withTrace,
} from '@openai/agents';
import * as path from 'node:path';

async function main() {
  const samplesDir = path.join(__dirname, 'sample_files');
  const mcpServer = new MCPServerStdio({
    name: 'Filesystem Server with filter',
    fullCommand: `npx -y @modelcontextprotocol/server-filesystem ${samplesDir}`,
    toolFilter: createStaticToolFilter(
      ['read_file', 'list_directory'],
      ['write_file'],
    ),
  });

  await mcpServer.connect();

  try {
    await withTrace('MCP Tool Filter Example', async () => {
      const agent = new Agent({
        name: 'MCP Assistant',
        instructions:
          'Use the filesystem tools to answer questions. The write_file tool is blocked via toolFilter.',
        mcpServers: [mcpServer],
      });

      console.log('Listing sample files:');
      let result = await run(agent, 'List the files in the current directory.');
      console.log(result.finalOutput);

      console.log('\nAttempting to write a file (should be blocked):');
      result = await run(
        agent,
        'Create a file named test.txt with the text "hello"',
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
