import assert from 'node:assert/strict';
import {
  mcpToFunctionTool,
  RunContext,
  type MCPServer,
} from '@openai/agents/classic';

/** Exercise awaited observers with a local mock MCP client and no model calls. */
export async function observeLocalMcpCall() {
  const order: string[] = [];
  let connected = false;
  let calls = 0;
  const declaration = {
    name: 'read_note',
    description: 'Read a synthetic note.',
    inputSchema: {
      type: 'object' as const,
      properties: { name: { type: 'string' as const } },
      required: ['name'],
      additionalProperties: false,
    },
  };
  const server: MCPServer = {
    name: 'local-notes',
    cacheToolsList: false,
    async connect() {
      connected = true;
    },
    async close() {
      connected = false;
      order.push('closed');
    },
    async invalidateToolsCache() {},
    async listTools() {
      return [declaration];
    },
    async callTool(name, args) {
      assert.equal(connected, true);
      assert.equal(name, 'read_note');
      assert.equal(args?.name, 'welcome');
      calls += 1;
      order.push('client');
      return [{ type: 'text', text: 'Welcome to the local notebook.' }];
    },
    async onToolStart(event) {
      event.signal?.throwIfAborted();
      // Observers must settle or cooperate with cancellation. The SDK joins
      // this await before checking cancellation and allowing dispatch.
      await Promise.resolve();
      assert.equal(event.toolName, 'read_note');
      assert.equal(calls, 0);
      order.push('start');
    },
    async onToolEnd(event) {
      // Cancellation cannot undo the client call. This observer must also
      // settle before joined cleanup can finish or output can return.
      event.signal?.throwIfAborted();
      await Promise.resolve();
      assert.equal(calls, 1);
      assert.deepEqual(event.result.content, [
        { type: 'text', text: 'Welcome to the local notebook.' },
      ]);
      order.push('end');
    },
  };

  try {
    await server.connect();
    const [description] = await server.listTools();
    assert.ok(description);
    const tool = mcpToFunctionTool(description, server, true);
    // Direct invocation exercises the public classic conversion route. It does
    // not demonstrate Runner approval or a native Session's admission checks.
    const result = await tool.invoke(new RunContext(), '{"name":"welcome"}');
    order.push('returned');
    assert.deepEqual(result, {
      type: 'text',
      text: 'Welcome to the local notebook.',
    });
    assert.deepEqual(order, ['start', 'client', 'end', 'returned']);
    assert.equal(calls, 1);
  } finally {
    await server.close();
  }
  assert.equal(connected, false);
  return order;
}

if (require.main === module) {
  observeLocalMcpCall().then(
    (order) => console.log(order.join(' -> ')),
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
