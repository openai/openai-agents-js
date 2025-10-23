import {
  Agent,
  run,
  MCPServerStdio,
  getAllMcpTools,
  withTrace,
} from '@openai/agents';
import * as path from 'node:path';

async function main() {
  const samplesDir = path.join(__dirname, 'sample_files');

  // Create multiple MCP servers to demonstrate getAllMcpTools
  const filesystemServer = new MCPServerStdio({
    name: 'Filesystem Server',
    fullCommand: `npx -y @modelcontextprotocol/server-filesystem ${samplesDir}`,
  });

  // Note: This example shows how to use multiple servers
  // In practice, you would have different servers with different tools
  const servers = [filesystemServer];

  // Connect all servers
  for (const server of servers) {
    await server.connect();
  }

  try {
    await withTrace('getAllMcpTools Example', async () => {
      console.log('=== Using getAllMcpTools to fetch all tools ===\n');

      // Method 1: Simple array of servers
      const allTools = await getAllMcpTools(servers);
      console.log(
        `Found ${allTools.length} tools from ${servers.length} server(s):`,
      );
      allTools.forEach((tool) => {
        const description =
          tool.type === 'function' ? tool.description : 'No description';
        console.log(`- ${tool.name}: ${description}`);
      });

      console.log('\n=== Using getAllMcpTools with options object ===\n');

      // Method 2: Using options object (recommended for more control)
      const allToolsWithOptions = await getAllMcpTools({
        mcpServers: servers,
        convertSchemasToStrict: true, // Convert schemas to strict mode
      });

      console.log(
        `Found ${allToolsWithOptions.length} tools with strict schemas:`,
      );
      allToolsWithOptions.forEach((tool) => {
        const description =
          tool.type === 'function' ? tool.description : 'No description';
        console.log(`- ${tool.name}: ${description}`);
      });

      console.log('\n=== Creating agent with pre-fetched tools ===\n');

      // Create agent using the pre-fetched tools
      const agent = new Agent({
        name: 'MCP Assistant with Pre-fetched Tools',
        instructions:
          'Use the available tools to help the user with file operations.',
        tools: allTools, // Use pre-fetched tools instead of mcpServers
      });

      // Test the agent
      const message = 'List the available files and read one of them.';
      console.log(`Running: ${message}\n`);
      const result = await run(agent, message);
      console.log(result.finalOutput);

      console.log(
        '\n=== Demonstrating tool filtering with getAllMcpTools ===\n',
      );

      // Add tool filter to one of the servers
      filesystemServer.toolFilter = {
        allowedToolNames: ['read_file'], // Only allow read_file tool
      };

      // Note: For callable filters to work, you need to pass runContext and agent
      // This is typically done internally when the agent runs
      const filteredTools = await getAllMcpTools({
        mcpServers: servers,
        convertSchemasToStrict: false,
        // runContext and agent would normally be provided by the agent runtime
        // For demo purposes, we're showing the structure
      });

      console.log(`After filtering, found ${filteredTools.length} tools:`);
      filteredTools.forEach((tool) => {
        console.log(`- ${tool.name}`);
      });
    });
  } finally {
    // Clean up - close all servers
    for (const server of servers) {
      await server.close();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
