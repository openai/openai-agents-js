import { expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent as ClassicAgent,
  RunContext,
  MCPServerStreamableHttp,
  type MCPToolFilterContext,
} from '@openai/agents/classic';
import { selectMcpTools, type Turn } from '../../src';
import {
  captureTools,
  invokeFunctionTool,
  tool,
  type ToolCallContext,
} from '../../src/runtime/tools';
import {
  BorrowedPeer,
  borrowedDeclaration,
  type MCPTool,
} from './fixtures/borrowed-mcp';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const invocation: ToolCallContext = {
  context: undefined,
  submission: {} as Turn<unknown>,
  threadId: 'root',
  turnId: 'turn',
  callId: 'call',
  signal: new AbortController().signal,
};
const invoke = (
  tool: Parameters<typeof invokeFunctionTool>[0],
  signal = invocation.signal,
  admission = () => {},
) =>
  invokeFunctionTool(
    tool,
    { value: 'ok' },
    { ...invocation, signal },
    () => {},
    admission,
  );

it('authenticates only the selected namespace and filters with captured real classic context', async () => {
  const context = { tenant: 'one' };
  const runContext = new RunContext(context);
  const agent = new ClassicAgent<typeof context>({ name: 'selector' });
  const server = new BorrowedPeer();
  server.declarations.push(borrowedDeclaration('hidden'));
  const other = new BorrowedPeer();
  const authenticate = vi.fn(async () => {});
  const filter = vi.fn(
    async (seen: MCPToolFilterContext, declaration: MCPTool) => {
      expect(seen).toEqual({ runContext, agent, serverName: server.name });
      expect(seen.runContext.context).toBe(context);
      const keep = declaration.name === 'lookup';
      declaration.name = 'mutated-filter-copy';
      return keep;
    },
  );
  server.toolFilter = filter;
  const selected = await selectMcpTools(
    { name: 'crm', server, authenticate },
    {
      context,
      filterContext: { runContext, agent },
    },
  );
  expect(authenticate).toHaveBeenCalledExactlyOnceWith(context, undefined);
  expect(server.invalidateToolsCache).toHaveBeenCalledTimes(1);
  expect(server.listTools).toHaveBeenCalledTimes(1);
  expect(other.listTools).not.toHaveBeenCalled();
  expect(selected.map((tool) => tool.name)).toEqual(['lookup']);
  expect(server.declarations[0].name).toBe('lookup');
  expect(server.connect).not.toHaveBeenCalled();
  expect(server.close).not.toHaveBeenCalled();
});

it('rejects missing filter context and unsupported hooks before authentication', async () => {
  const server = new BorrowedPeer();
  const authenticate = vi.fn();
  server.toolFilter = async () => true;
  await expect(
    selectMcpTools(
      { name: 'crm', server, authenticate },
      { context: undefined },
    ),
  ).rejects.toThrow('classic context');
  server.toolFilter = undefined;
  Object.assign(server, { toolMetaResolver: () => ({ private: 'metadata' }) });
  await expect(
    selectMcpTools(
      { name: 'crm', server, authenticate },
      { context: undefined },
    ),
  ).rejects.toThrow('do not support');
  expect(authenticate).not.toHaveBeenCalled();
  expect(server.listTools).not.toHaveBeenCalled();
});

it('uses blocked-wins filters and rejects a partial explicit selection', async () => {
  const server = new BorrowedPeer();
  server.declarations.push(borrowedDeclaration('blocked'));
  server.toolFilter = {
    allowedToolNames: ['lookup', 'blocked'],
    blockedToolNames: ['blocked'],
  };
  await expect(
    selectMcpTools(
      { name: 'crm', server },
      {
        context: undefined,
        toolNames: ['lookup', 'blocked'],
      },
    ),
  ).rejects.toThrow('filtered out');
  const selected = await selectMcpTools(
    { name: 'crm', server },
    { context: undefined },
  );
  expect(selected.map((tool) => tool.name)).toEqual(['lookup']);
});

it('preserves raw schemas and emits one slot envelope for each tool in a namespace', async () => {
  const server = new BorrowedPeer();
  Object.assign(server.declarations[0].inputSchema, {
    $defs: { key: { type: 'string' } },
    'x-vendor': { mode: 'raw' },
  });
  server.declarations.push(borrowedDeclaration('save'));
  const selected = await selectMcpTools(
    { name: 'crm', description: 'CRM records', server },
    { context: undefined },
  );
  const specs: Array<{
    name: string;
    tools: Array<{ name: string; inputSchema: unknown }>;
  }> = JSON.parse(captureTools(selected).specsJson);
  expect(
    specs.map((spec) => [spec.name, spec.tools.map((tool) => tool.name)]),
  ).toEqual([
    ['crm', ['lookup']],
    ['crm', ['save']],
  ]);
  expect(specs[0].tools[0].inputSchema).toEqual(
    server.declarations[0].inputSchema,
  );
  server.declarations[0].inputSchema.properties.value = { type: 'number' };
  expect(
    JSON.parse(captureTools(selected).specsJson)[0].tools[0].inputSchema
      .properties.value.type,
  ).toBe('string');
  expect(Object.isFrozen(selected)).toBe(true);
  expect(Object.isFrozen(selected[0].parameters)).toBe(true);
});

it('normalizes implicit functions for collisions while allowing the same name in different namespaces', async () => {
  const server = new BorrowedPeer();
  const crm = await selectMcpTools(
    { name: 'crm', server },
    { context: undefined },
  );
  const functions = await selectMcpTools(
    { name: 'functions', server },
    { context: undefined },
  );
  const ordinary = tool({
    name: 'lookup',
    parameters: z.object({}),
    execute: () => 'ordinary',
  });
  expect(captureTools([ordinary, ...crm]).tools).toHaveLength(2);
  expect(() => captureTools([ordinary, ...functions])).toThrow(
    'Duplicate tool',
  );
  expect(() => captureTools([...crm, ...crm])).toThrow('Duplicate tool');
  server.declarations.push(borrowedDeclaration());
  await expect(
    selectMcpTools({ name: 'crm', server }, { context: undefined }),
  ).rejects.toThrow('unique');
});

it('refresh returns a new complete snapshot and preserves prior methods after failed discovery', async () => {
  const server = new BorrowedPeer();
  const oldCall = server.callTool;
  const old = await selectMcpTools(
    { name: 'crm', server },
    { context: undefined },
  );
  server.callTool = vi.fn(async () => [{ type: 'text', text: 'new' }]);
  server.declarations = [borrowedDeclaration('save')];
  const fresh = await selectMcpTools(
    { name: 'crm', server },
    { context: undefined },
  );
  server.declarations.push({
    ...borrowedDeclaration('bad'),
    inputSchema: {
      ...borrowedDeclaration().inputSchema,
      type: 'invalid' as 'object',
    },
  });
  await expect(
    selectMcpTools({ name: 'crm', server }, { context: undefined }),
  ).rejects.toThrow('object input schema');
  expect((await invoke(old[0])).contentItems[0]).toMatchObject({
    type: 'inputText',
    text: expect.stringContaining('lookup'),
  });
  expect((await invoke(fresh[0])).contentItems[0]).toEqual({
    type: 'inputText',
    text: 'new',
  });
  expect(oldCall).toHaveBeenCalledTimes(1);
  expect(server.callTool).toHaveBeenCalledTimes(1);
});

it('joins entered discovery after abort and never closes a borrowed connection', async () => {
  const server = new BorrowedPeer();
  const entered = deferred();
  const release = deferred();
  server.listTools.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return server.declarations;
  });
  const abort = new AbortController();
  let settled = false;
  const selected = selectMcpTools(
    { name: 'crm', server },
    { context: undefined, signal: abort.signal },
  );
  const rejected = expect(selected).rejects.toThrow('selection cancelled');
  void selected.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await entered.promise;
  abort.abort(new Error('selection cancelled'));
  expect(settled).toBe(false);
  release.resolve();
  await rejected;
  expect(server.close).not.toHaveBeenCalled();
});

it('joins entered calls and revokes result publication on abort', async () => {
  const server = new BorrowedPeer();
  const entered = deferred();
  const release = deferred();
  server.callTool.mockImplementation(async (_name, _args, _meta, options) => {
    entered.resolve();
    await release.promise;
    expect(options?.signal?.aborted).toBe(true);
    return [{ type: 'text', text: 'late' }];
  });
  const [selected] = await selectMcpTools(
    { name: 'crm', server },
    { context: undefined },
  );
  const abort = new AbortController();
  const result = invoke(selected, abort.signal);
  const rejected = expect(result).rejects.toThrow('call cancelled');
  await entered.promise;
  abort.abort(new Error('call cancelled'));
  release.resolve();
  await rejected;
  expect(server.callTool).toHaveBeenCalledTimes(1);
  expect(server.close).not.toHaveBeenCalled();
});

it('uses full results once, preserves ordered blocks and keeps private metadata out of model content', async () => {
  const server = new BorrowedPeer();
  server.callToolResult = vi.fn(async () => ({
    isError: true,
    structuredContent: { private: 'not selected' },
    _meta: { token: 'synthetic-private' },
    content: [
      { type: 'text', text: 'denied' },
      { type: 'image', mimeType: 'image/png', data: 'AA==' },
      { type: 'audio', mimeType: 'audio/wav', data: 'AQ==' },
      {
        type: 'resource_link',
        uri: 'https://example.invalid/private',
        name: 'resource',
      },
    ],
  }));
  Object.assign(server, { useStructuredContent: true });
  const [selected] = await selectMcpTools(
    { name: 'crm', server },
    { context: undefined },
  );
  const result = await invoke(selected);
  expect(result.success).toBe(false);
  expect(result.contentItems).toEqual([
    { type: 'inputText', text: 'denied' },
    { type: 'inputImage', imageUrl: 'data:image/png;base64,AA==' },
    {
      type: 'inputText',
      text: JSON.stringify({
        type: 'audio',
        mimeType: 'audio/wav',
        data: 'AQ==',
      }),
    },
    {
      type: 'inputText',
      text: JSON.stringify({
        type: 'resource_link',
        uri: 'https://example.invalid/private',
        name: 'resource',
      }),
    },
  ]);
  expect(JSON.stringify(result)).not.toContain('synthetic-private');
  expect(server.callToolResult).toHaveBeenCalledTimes(1);
  expect(server.callTool).not.toHaveBeenCalled();
});

it('reads attached legacy metadata before cloning and treats empty structured objects as present', async () => {
  const server = new BorrowedPeer();
  Object.assign(server, { useStructuredContent: true });
  const content = [{ type: 'text' as const, text: 'unused' }];
  Object.defineProperties(content, {
    structuredContent: { value: {} },
    isError: { value: false },
  });
  server.callTool.mockResolvedValue(content);
  const [selected] = await selectMcpTools(
    { name: 'crm', server },
    { context: undefined },
  );
  expect(await invoke(selected)).toEqual({
    success: true,
    contentItems: [{ type: 'inputText', text: '{}' }],
  });
});

it('does not retry transport or post-effect conversion failures', async () => {
  const server = new BorrowedPeer();
  server.callTool.mockRejectedValue(new Error('transport failed'));
  const [selected] = await selectMcpTools(
    { name: 'crm', server },
    { context: undefined },
  );
  await expect(invoke(selected)).rejects.toThrow('transport failed');
  server.callTool.mockResolvedValue([{ type: 'text', text: 1 }] as never);
  await expect(invoke(selected)).rejects.toThrow('text must be a string');
  expect(server.callTool).toHaveBeenCalledTimes(2);
});

it('accepts actual classic server classes without taking their lifecycle', () => {
  const server = new MCPServerStreamableHttp({ url: 'http://127.0.0.1:1/mcp' });
  expectTypeOf(server).toExtend<
    Parameters<typeof selectMcpTools>[0]['server']
  >();
  // Construction is local; selection/connection is deliberately not entered here.
  expect(server.name).toBeTypeOf('string');
});

it('keeps overlapping authentication scopes separate when the caller supplies separate clients', async () => {
  const first = new BorrowedPeer();
  const second = new BorrowedPeer();
  const entered = deferred();
  const release = deferred();
  first.callTool.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return [{ type: 'text', text: 'first' }];
  });
  second.callTool.mockResolvedValue([{ type: 'text', text: 'second' }]);
  const firstAuth = vi.fn();
  const secondAuth = vi.fn();
  const firstContext = { tenant: 'first' };
  const secondContext = { tenant: 'second' };
  const [old] = await selectMcpTools(
    { name: 'crm', server: first, authenticate: firstAuth },
    { context: firstContext },
  );
  const held = invoke(old);
  try {
    await entered.promise;
    const [fresh] = await selectMcpTools(
      { name: 'crm', server: second, authenticate: secondAuth },
      { context: secondContext },
    );
    expect((await invoke(fresh)).contentItems).toEqual([
      { type: 'inputText', text: 'second' },
    ]);
    expect(firstAuth).toHaveBeenCalledExactlyOnceWith(firstContext, undefined);
    expect(secondAuth).toHaveBeenCalledExactlyOnceWith(
      secondContext,
      undefined,
    );
  } finally {
    release.resolve();
  }
  expect((await held).contentItems).toEqual([
    { type: 'inputText', text: 'first' },
  ]);
});
