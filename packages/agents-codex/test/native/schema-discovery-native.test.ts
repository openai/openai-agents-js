import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, HttpMCP, NativeProvider, tool, toolRef } from '../../src';
import { jsonObject, type JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await ModelServer.closeAll();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, 'Schema discovery cleanup failed');
});

async function providerFor(model: ModelServer) {
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: jsonObject.parse(config['model_providers.fixture'])
      .base_url as string,
    apiKey: 'synthetic-discovery',
    supportsWebsockets: false,
  });
  cleanup.push(() => provider.close());
  return provider;
}

function search(query: string, callId: string): JsonObject {
  return {
    type: 'tool_search_call',
    call_id: callId,
    execution: 'client',
    arguments: { query, limit: 5 },
  };
}

function discovered(request: JsonObject, callId: string) {
  const result = (request.input as JsonObject[]).findLast(
    (item) => item.type === 'tool_search_output' && item.call_id === callId,
  );
  expect(result).toBeDefined();
  return JSON.stringify(result);
}

function declarations(request: JsonObject) {
  const result: Array<{
    namespace: string | null;
    name: string;
    schema: JsonObject;
  }> = [];
  function add(values: unknown, namespace: string | null = null) {
    if (!Array.isArray(values)) return;
    for (const raw of values) {
      const spec = jsonObject.parse(raw);
      if (spec.type === 'namespace') add(spec.tools, spec.name as string);
      else if (spec.type === 'function')
        result.push({ namespace, name: spec.name as string, schema: spec });
    }
  }
  add(request.tools);
  if (Array.isArray(request.input))
    for (const raw of request.input) {
      const item = jsonObject.parse(raw);
      if (item.type === 'additional_tools') add(item.tools);
    }
  return result;
}

function invoice(execute: (key: string) => string, deferLoading = false) {
  return tool({
    name: 'skylark_invoice',
    description: 'Find the current skylark accounting invoice',
    deferLoading,
    parameters: z.object({ key: z.string().min(2).describe('Invoice key') }),
    execute: ({ key }) => execute(key),
  });
}

it.each(['operation', 'beforeStep'] as const)(
  'discovers and executes only the selected function through %s narrowing',
  async (selection) => {
    const execute = vi.fn((key: string) => 'paid:' + key);
    const selected = invoice(execute, true);
    const destroy = vi.fn(() => 'destroyed');
    const omitted = tool({
      name: 'skylark_delete',
      description: 'Destroy skylark accounting invoices',
      deferLoading: true,
      parameters: z.object({ key: z.string() }),
      execute: destroy,
    });
    const model = new ModelServer([
      [search('skylark invoice', 'find-invoice')],
      [call('skylark_invoice', { key: 'A1' }, { callId: 'use-invoice' })],
      [call('skylark_delete', { key: 'A1' }, { callId: 'forbidden' })],
      [message('settled')],
    ]);
    await using session = await new Agent({
      instructions: 'Use the selected invoice.',
      model: 'gpt-5.5',
      provider: await providerFor(model),
      programmaticToolCalling: false,
      tools: [selected, omitted],
    }).session();
    const turn = await session.submit(
      'Find the invoice.',
      selection === 'operation'
        ? { tools: [selected] }
        : { beforeStep: () => [selected] },
    );
    expect((await turn.wait()).finalOutput).toBe('settled');
    expect(execute.mock.calls).toEqual([['A1']]);
    expect(destroy).not.toHaveBeenCalled();
    expect(JSON.stringify(model.requests[0].tools ?? [])).toContain(
      'tool_search',
    );
    expect(
      declarations(model.requests[0]).map((entry) => entry.name),
    ).not.toContain('skylark_invoice');
    const found = discovered(model.requests[1], 'find-invoice');
    expect(found).toContain('skylark_invoice');
    expect(found).toContain('minLength');
    expect(found).not.toContain('[agents-schema:');
    expect(found).not.toContain('skylark_delete');
    expect(JSON.stringify(model.requests[0].tools ?? [])).not.toContain(
      'skylark_delete',
    );
    model.assertExhausted();
  },
);

it.each(['operation', 'beforeStep'] as const)(
  'keeps an empty %s selection free of discovery authority',
  async (selection) => {
    const execute = vi.fn(() => 'unreachable');
    const selected = invoice(execute, true);
    const model = new ModelServer([[message('empty')]]);
    await using session = await new Agent({
      instructions: 'Answer without tools.',
      model: 'gpt-5.5',
      programmaticToolCalling: false,
      provider: await providerFor(model),
      tools: [selected],
    }).session();
    const turn = await session.submit(
      'Nothing selected.',
      selection === 'operation' ? { tools: [] } : { beforeStep: () => [] },
    );
    expect((await turn.wait()).finalOutput).toBe('empty');
    expect(JSON.stringify(model.requests[0].tools ?? [])).not.toContain(
      'tool_search',
    );
    expect(declarations(model.requests[0])).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    model.assertExhausted();
  },
);

it('sends deferred function schemas directly with the default native model', async () => {
  const execute = vi.fn((key: string) => 'paid:' + key);
  const selected = invoice(execute, true);
  const model = new ModelServer([
    [call('skylark_invoice', { key: 'A1' }, { callId: 'direct-use' })],
    [message('paid')],
  ]);
  await using session = await new Agent({
    instructions: 'Use the invoice.',
    programmaticToolCalling: false,
    provider: await providerFor(model),
    tools: [selected],
  }).session();
  expect((await (await session.submit('Find it.')).wait()).finalOutput).toBe(
    'paid',
  );
  expect(
    declarations(model.requests[0]).find(
      (entry) => entry.name === selected.name,
    )?.schema.parameters,
  ).toEqual(selected.parameters);
  expect(JSON.stringify(model.requests[0].tools ?? [])).not.toContain(
    'tool_search',
  );
  expect(execute.mock.calls).toEqual([['A1']]);
  model.assertExhausted();
});

it('rejects new function discovery without an opening grant before provider I/O', async () => {
  const execute = vi.fn((key: string) => key);
  const selected = invoice(execute);
  const model = new ModelServer([
    [call('skylark_invoice', { key: 'A1' }, { callId: 'original' })],
    [message('original survived')],
  ]);
  await using session = await new Agent({
    instructions: 'Keep the opening authority.',
    model: 'gpt-5.5',
    programmaticToolCalling: false,
    provider: await providerFor(model),
    tools: [selected],
  }).session();
  await expect(
    session.update({ tools: [invoice(execute, true)] }),
  ).rejects.toThrow(/discovery|captured|opening/i);
  expect(model.requests).toEqual([]);
  expect(
    (await (await session.submit('Use original.')).wait()).finalOutput,
  ).toBe('original survived');
  expect(execute.mock.calls).toEqual([['A1']]);
  expect(JSON.stringify(model.requests[0].tools ?? [])).not.toContain(
    'tool_search',
  );
  model.assertExhausted();
});

it('retains the opening discovery grant after its anchor leaves the current roster', async () => {
  const execute = vi.fn((key: string) => key);
  const anchorExecute = vi.fn(() => 'unreachable');
  const anchor = tool({
    name: 'anchor',
    description: 'Separate opening discovery grant',
    deferLoading: true,
    parameters: z.object({}),
    execute: anchorExecute,
  });
  const selected = invoice(execute);
  const model = new ModelServer([
    [search('skylark invoice', 'rebound')],
    [call('skylark_invoice', { key: 'A1' }, { callId: 'current' })],
    [message('found')],
  ]);
  await using session = await new Agent({
    instructions: 'Use the current invoice.',
    model: 'gpt-5.5',
    programmaticToolCalling: false,
    provider: await providerFor(model),
    tools: [selected, anchor],
  }).session();
  await session.update({ tools: [selected] });
  await session.update({ tools: [invoice(execute, true)] });
  expect((await (await session.submit('Discover.')).wait()).finalOutput).toBe(
    'found',
  );
  expect(discovered(model.requests[1], 'rebound')).toContain('skylark_invoice');
  expect(discovered(model.requests[1], 'rebound')).not.toContain('anchor');
  expect(execute.mock.calls).toEqual([['A1']]);
  expect(anchorExecute).not.toHaveBeenCalled();
  model.assertExhausted();
});

it('adapts the current function and MCP roster when the model changes in both directions', async () => {
  const execute = vi.fn((key: string) => 'paid:' + key);
  const selected = invoice(execute, true);
  const omittedExecute = vi.fn(() => 'unreachable');
  const omitted = tool({
    name: 'skylark_delete',
    description: 'Destroy skylark invoices',
    deferLoading: true,
    parameters: z.object({}),
    execute: omittedExecute,
  });
  const peer = await mcpPeer(['lookup', 'hidden']);
  const remote = new HttpMCP({
    name: 'records',
    url: peer.url,
    tools: ['lookup', 'hidden'],
    approvalMode: 'preapproved',
    deferLoading: true,
  });
  const model = new ModelServer([
    [message('original model')],
    // Core compacts with the previous model after a model change.
    [message('Only selected invoice and records lookup are available.')],
    [search('skylark invoice', 'capable-search')],
    [call('skylark_invoice', { key: 'A1' }, { callId: 'capable-use' })],
    [message('capable')],
    [message('Only current records lookup remains selected.')],
    [
      call(
        'lookup',
        { key: 'A1' },
        { namespace: 'mcp__records', callId: 'fallback-use' },
      ),
    ],
    [message('back to default')],
  ]);
  await using session = await new Agent({
    instructions: 'Use only selected tools.',
    provider: await providerFor(model),
    programmaticToolCalling: false,
    tools: [selected, omitted, remote],
  }).session();
  const lookup = toolRef('lookup', 'mcp__records');
  expect(
    (
      await (
        await session.submit('Offered.', { tools: [selected, lookup] })
      ).wait()
    ).finalOutput,
  ).toBe('original model');
  const defaultModel = model.requests[0].model as string;
  expect(defaultModel).not.toBe('gpt-5.5');
  expect(
    declarations(model.requests[0])
      .map((entry) => entry.name)
      .sort(),
  ).toEqual(['lookup', 'skylark_invoice']);
  expect(declarations(model.requests[0])).toContainEqual(
    expect.objectContaining({ namespace: 'mcp__records', name: 'lookup' }),
  );
  expect(JSON.stringify(model.requests[0].tools ?? [])).not.toContain(
    'tool_search',
  );
  await session.update({ model: 'gpt-5.5' });
  expect(
    (
      await (
        await session.submit('Search.', { tools: [selected, lookup] })
      ).wait()
    ).finalOutput,
  ).toBe('capable');
  expect(model.requests[1].model).toBe(defaultModel);
  expect(model.requests[1].tools ?? []).toEqual([]);
  expect(model.requests[2].model).toBe('gpt-5.5');
  expect(JSON.stringify(model.requests[2].tools)).toContain('tool_search');
  expect(
    declarations(model.requests[2]).map((entry) => entry.name),
  ).not.toContain('skylark_invoice');
  expect(discovered(model.requests[3], 'capable-search')).toContain(
    'skylark_invoice',
  );
  expect(discovered(model.requests[3], 'capable-search')).not.toContain(
    'skylark_delete',
  );
  await session.update({ model: defaultModel });
  expect(
    (
      await (
        await session.submit('Current selection.', { tools: [lookup] })
      ).wait()
    ).finalOutput,
  ).toBe('back to default');
  expect(model.requests[5].model).toBe('gpt-5.5');
  expect(model.requests[5].tools ?? []).toEqual([]);
  expect(model.requests[6].model).toBe(defaultModel);
  expect(
    declarations(model.requests[6]).map(({ namespace, name }) => [
      namespace,
      name,
    ]),
  ).toEqual([['mcp__records', 'lookup']]);
  expect(JSON.stringify(model.requests[6].tools ?? [])).not.toContain(
    'tool_search',
  );
  expect(execute.mock.calls).toEqual([['A1']]);
  expect(omittedExecute).not.toHaveBeenCalled();
  expect(peer.calls.map((entry) => entry.name)).toEqual(['lookup']);
  model.assertExhausted();
});

// The existing native MCP wire fixtures keep their peers private to each test.
// Use the same finite JSON-RPC exchange here to observe real native acquisition.
async function mcpPeer(names: string[]) {
  const requests: string[] = [];
  const calls: JsonObject[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rpc = jsonObject.parse(JSON.parse(Buffer.concat(chunks).toString()));
    requests.push(rpc.method as string);
    if (rpc.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: JsonObject = {};
    if (rpc.method === 'initialize')
      result = {
        protocolVersion: jsonObject.parse(rpc.params).protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'discovery-peer', version: '1' },
      };
    else if (rpc.method === 'tools/list')
      result = {
        tools: names.map((name) => ({
          name,
          description: 'Read the synthetic skylark record using ' + name,
          inputSchema: {
            type: 'object',
            properties: { key: { type: 'string' } },
            required: ['key'],
            additionalProperties: false,
          },
        })),
      };
    else if (rpc.method === 'tools/call') {
      calls.push(jsonObject.parse(rpc.params));
      result = { content: [{ type: 'text', text: 'current record' }] };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing MCP peer port');
  return { requests, calls, url: `http://127.0.0.1:${address.port}/mcp` };
}

it('keeps direct and deferred MCP aliases distinct and excludes omitted leaves from search', async () => {
  const lazyPeer = await mcpPeer(['lookup', 'destroy']);
  const directPeer = await mcpPeer(['search']);
  const invalidPeer = await mcpPeer(['lookup', 'destroy']);
  const lazy = new HttpMCP({
    name: 'lazy',
    url: lazyPeer.url,
    tools: ['lookup', 'destroy'],
    deferLoading: true,
    approvalMode: 'preapproved',
  });
  const direct = new HttpMCP({
    name: 'direct',
    url: directPeer.url,
    tools: ['search'],
    approvalMode: 'preapproved',
  });
  const model = new ModelServer([
    [search('synthetic skylark lookup', 'find-record')],
    [
      call(
        'lookup',
        { key: 'A1' },
        { namespace: 'mcp__lazy', callId: 'lazy-use' },
      ),
    ],
    [
      call(
        'search',
        { key: 'A1' },
        { namespace: 'mcp__direct', callId: 'direct-use' },
      ),
    ],
    [
      call(
        'destroy',
        { key: 'A1' },
        { namespace: 'mcp__lazy', callId: 'forbidden' },
      ),
    ],
    [message('finished')],
  ]);
  await using session = await new Agent({
    instructions: 'Read only selected records.',
    model: 'gpt-5.5',
    provider: await providerFor(model),
    programmaticToolCalling: false,
    tools: [lazy, direct],
  }).session();
  // Deferral changes schema presentation while native acquisition stays eager.
  expect(lazyPeer.requests).toContain('tools/list');
  expect(directPeer.requests).toContain('tools/list');
  await expect(
    session.update({
      tools: [
        new HttpMCP({
          name: 'lazy',
          url: invalidPeer.url,
          tools: ['lookup', 'destroy'],
          deferLoading: false,
        }),
        direct,
      ],
    }),
  ).rejects.toThrow(/MCP.*(discovery|opening)/i);
  await expect(
    session.update({
      tools: [
        lazy,
        new HttpMCP({
          name: 'direct',
          url: invalidPeer.url,
          tools: ['search'],
          deferLoading: true,
        }),
      ],
    }),
  ).rejects.toThrow(/MCP.*(discovery|opening)/i);
  expect(invalidPeer.requests).toEqual([]);
  expect(model.requests).toEqual([]);
  const turn = await session.submit('Read records.', {
    tools: [toolRef('lookup', 'mcp__lazy'), toolRef('search', 'mcp__direct')],
  });
  expect((await turn.wait()).finalOutput).toBe('finished');
  expect(declarations(model.requests[0])).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ namespace: 'mcp__direct', name: 'search' }),
    ]),
  );
  expect(
    declarations(model.requests[0]).some(
      (entry) => entry.namespace === 'mcp__lazy',
    ),
  ).toBe(false);
  const found = discovered(model.requests[1], 'find-record');
  expect(found).toContain('lookup');
  expect(found).not.toContain('destroy');
  expect(lazyPeer.calls.map((entry) => entry.name)).toEqual(['lookup']);
  expect(directPeer.calls.map((entry) => entry.name)).toEqual(['search']);
  expect(invalidPeer.requests).toEqual([]);
  model.assertExhausted();
});

it.each([false, true])(
  'preserves Code Mode calls while opting function schema deferral in or out (%s)',
  async (deferred) => {
    const execute = vi.fn((key: string) => 'paid:' + key);
    const selected = invoice(execute, deferred);
    const model = new ModelServer([
      [
        {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'code-invoice',
          input: 'text(await tools.skylark_invoice({key:"A1"}));',
        },
      ],
      [message('code finished')],
    ]);
    await using session = await new Agent({
      instructions: 'Use the admitted invoice in code.',
      model: 'gpt-5.5',
      provider: await providerFor(model),
      programmaticToolCalling: true,
      tools: [selected],
    }).session();
    expect((await (await session.submit('Read.')).wait()).finalOutput).toBe(
      'code finished',
    );
    const initialTools = JSON.stringify(model.requests[0].tools ?? []);
    expect(
      declarations(model.requests[0]).some(
        (entry) => entry.name === selected.name,
      ),
    ).toBe(!deferred);
    expect(initialTools.includes('tool_search')).toBe(deferred);
    expect(execute.mock.calls).toEqual([['A1']]);
    expect(JSON.stringify(model.requests[1].input)).toContain('paid:A1');
    model.assertExhausted();
  },
);

it('keeps search history after beforeStep fails and an idle update replaces the tool', async () => {
  const effects: string[] = [];
  const declaration = (minimum: number, label: string) =>
    tool({
      name: 'lookup',
      description: 'Lookup a synthetic record',
      deferLoading: true,
      parameters: z.object({ key: z.string().min(minimum) }),
      execute: ({ key }) => {
        effects.push(label + ':' + key);
        return label;
      },
    });
  const original = declaration(2, 'old');
  const model = new ModelServer([
    [search('synthetic record lookup', 'before-failure')],
    [search('synthetic record lookup', 'after-update')],
    [call('lookup', { key: 'B2222' }, { callId: 'updated-use' })],
    [message('continued')],
  ]);
  await using session = await new Agent({
    instructions: 'Read selected records.',
    model: 'gpt-5.5',
    provider: await providerFor(model),
    programmaticToolCalling: false,
    tools: [original],
  }).session();
  let steps = 0;
  const failed = await session.submit('Search first.', {
    beforeStep: () => {
      if (++steps === 2) throw new Error('stop after search');
      return [original];
    },
  });
  await expect(failed.wait()).rejects.toThrow('stop after search');
  expect(model.requests).toHaveLength(1);
  await session.update({ tools: [declaration(5, 'current')] });
  // Continue directly: exporting state here would mask the original lifetime gap.
  expect((await (await session.submit('Continue.')).wait()).finalOutput).toBe(
    'continued',
  );
  expect(discovered(model.requests[1], 'before-failure')).toContain(
    '"minLength":2',
  );
  expect(discovered(model.requests[2], 'after-update')).toContain(
    '"minLength":5',
  );
  expect(JSON.stringify(model.requests)).not.toContain('[agents-schema:');
  expect(effects).toEqual(['current:B2222']);
  model.assertExhausted();
});

it('preserves historical search schemas across updates and restores only current callbacks', async () => {
  const effects: string[] = [];
  const declaration = (minimum: number, description: string, label: string) =>
    tool({
      name: 'lookup',
      description,
      deferLoading: true,
      parameters: z.object({ key: z.string().min(minimum) }),
      execute: ({ key }) => {
        effects.push(label + ':' + key);
        return label;
      },
    });
  const old = declaration(2, 'Lookup the original synthetic record', 'old');
  const current = declaration(5, 'Lookup the updated synthetic record', 'new');
  const model = new ModelServer([
    [search('synthetic record lookup', 'old-search')],
    [call('lookup', { key: 'A1' }, { callId: 'old-use' })],
    [message('first')],
    [search('synthetic record lookup', 'new-search')],
    [call('lookup', { key: 'B2222' }, { callId: 'new-use' })],
    [message('second')],
    [search('synthetic record lookup', 'restored-search')],
    [call('lookup', { key: 'C3333' }, { callId: 'restored-use' })],
    [message('restored')],
  ]);
  const provider = await providerFor(model);
  const session = await new Agent({
    instructions: 'Read selected records.',
    model: 'gpt-5.5',
    provider,
    tools: [old],
  }).session();
  let saved: Awaited<ReturnType<typeof session.saveState>>;
  let historical: unknown;
  try {
    expect(
      (await (await session.submit('Read first.')).wait()).finalOutput,
    ).toBe('first');
    historical = JSON.parse(discovered(model.requests[1], 'old-search'));
    expect(JSON.stringify(historical)).toContain('"minLength":2');
    await session.update({ tools: [current] });
    expect(
      (await (await session.submit('Read updated.')).wait()).finalOutput,
    ).toBe('second');
    expect(JSON.parse(discovered(model.requests[3], 'old-search'))).toEqual(
      historical,
    );
    expect(discovered(model.requests[4], 'new-search')).toContain(
      '"minLength":5',
    );
    saved = await session.saveState();
    expect(JSON.stringify(saved)).not.toContain('[agents-schema:');
  } finally {
    await session.close();
  }
  await provider.close();
  const destination = declaration(5, current.description, 'destination');
  await using restored = await new Agent({
    instructions: 'Read selected records.',
    model: 'gpt-5.5',
    provider: await providerFor(model),
    tools: [destination],
  }).session({ state: saved });
  expect(
    (await (await restored.submit('Read restored.')).wait()).finalOutput,
  ).toBe('restored');
  expect(JSON.parse(discovered(model.requests[6], 'old-search'))).toEqual(
    historical,
  );
  expect(discovered(model.requests[7], 'restored-search')).toContain(
    '"minLength":5',
  );
  expect(JSON.stringify(model.requests)).not.toContain('[agents-schema:');
  expect(effects).toEqual(['old:A1', 'new:B2222', 'destination:C3333']);
  model.assertExhausted();
});
