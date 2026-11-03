/* global require */
/* oxlint-disable typescript/no-require-imports -- This fixture verifies CommonJS loading. */
const process = require('node:process');
const console = require('node:console');
const { Response } = globalThis;
const assert = require('node:assert/strict');

async function main() {
  const sdk =
    process.argv[2] === 'cjs'
      ? require('@openai/agents/classic')
      : await import('@openai/agents/classic');
  const { ProtocolError, ProtocolErrorCode } =
    await import('@modelcontextprotocol/client');
  const requests = [];
  let paginate = false;
  let modern = false;
  const options = {
    url: 'https://example.test/mcp',
    maxListPages: 1,
    fetch: async (_url, init) => {
      if (init.method === 'DELETE') return new Response(null, { status: 200 });
      const message = JSON.parse(String(init.body));
      requests.push(message.method);
      if (message.id === undefined) return new Response(null, { status: 202 });
      let result;
      if (message.method === 'server/discover') {
        if (!modern)
          return Response.json({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Method not found' },
          });
        result = {
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {} },
        };
      } else if (message.method === 'initialize') {
        result = {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'legacy', version: '1.0.0' },
        };
      } else if (message.method === 'tools/call') {
        result = {
          content: [{ type: 'text', text: 'unexpected call' }],
          isError: false,
        };
      } else {
        assert.equal(message.method, 'tools/list');
        result = {
          tools: [
            {
              name: 'required-task',
              inputSchema: { type: 'object', properties: {} },
              execution: { taskSupport: 'required' },
            },
          ],
          ...(paginate ? { nextCursor: 'next' } : {}),
        };
      }
      return Response.json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          ...(modern
            ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private' }
            : {}),
          ...result,
        },
      });
    },
  };
  let server = new sdk.MCPServerStreamableHttp(options);
  try {
    await server.connect();
    await server.listTools();
    await assert.rejects(
      server.callTool('required-task', {}),
      (error) =>
        error instanceof ProtocolError &&
        error.code === ProtocolErrorCode.InvalidRequest,
    );
    const pendingCall = server.callTool('required-task', {});
    const invalidation = server.invalidateToolsCache();
    await Promise.all([
      assert.rejects(
        pendingCall,
        (error) =>
          error instanceof ProtocolError &&
          error.code === ProtocolErrorCode.InvalidRequest,
      ),
      invalidation,
    ]);
    assert.ok(!requests.includes('tools/call'));
  } finally {
    await server.close();
  }
  paginate = true;
  modern = true;
  server = new sdk.MCPServerStreamableHttp(options);
  try {
    await server.connect();
    await assert.rejects(
      server.listTools(),
      (error) =>
        error instanceof sdk.UserError && /maxListPages/.test(error.message),
    );
  } finally {
    await server.close();
  }
  console.log(`Packed classic ${process.argv[2]} MCP error identity passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
