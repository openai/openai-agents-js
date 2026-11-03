'use strict';

/* global require, exports */
/* oxlint-disable typescript/no-require-imports -- This entry point supports CommonJS consumers. */

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

exports.MCPTasksProvider =
  require('../dist/experimental/mcp-tasks/provider.js').MCPTasksProvider;
exports.MCPInputReply =
  require('../dist/experimental/mcp-tasks/input-reply.js').MCPInputReply;
