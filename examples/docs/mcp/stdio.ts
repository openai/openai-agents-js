import { Agent, run, MCPServerStdio } from '@openai/agents';
import * as path from 'node:path';

async function main() {
  const samplesDir = path.join(__dirname, 'sample_files');
  const mcpServer = new MCPServerStdio({
    name: 'Filesystem MCP Server, via npx',
    fullCommand: `npx -y @modelcontextprotocol/server-filesystem ${samplesDir}`,
  });
  await mcpServer.connect();
  try {
    const agent = new Agent({
      name: 'FS MCP Assistant',
      instructions:
        'Use the tools to read the filesystem and answer questions based on those files. If you are unable to find any files, you can say so instead of assuming they exist.',
      mcpServers: [mcpServer],
    });
    const result = await run(agent, 'Read the files and list them.');
    console.log(result.finalOutput);
  } finally {
    await mcpServer.close();
  }
}

main().catch(console.error);
