import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
try {
  require.resolve('@modelcontextprotocol/client');
  require.resolve('@modelcontextprotocol/core');
} catch (error) {
  if (error?.code === 'MODULE_NOT_FOUND') {
    throw new Error(
      'MCP Tasks requires optional dependencies. Install @modelcontextprotocol/client@2.0.0 and @modelcontextprotocol/core@2.0.0.',
    );
  }
  throw error;
}

const { MCPTasksProvider } =
  await import('../dist/experimental/mcp-tasks/provider.mjs');
const { MCPInputReply } =
  await import('../dist/experimental/mcp-tasks/input-reply.mjs');
export { MCPTasksProvider, MCPInputReply };
