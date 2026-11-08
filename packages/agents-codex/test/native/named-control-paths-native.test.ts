import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  HttpMCP,
  fileSearch,
  tool,
  toolRef,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
afterEach(() => ModelServer.closeAll());
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-named-key',
    supportsWebsockets: false,
  });
}
it('restores a captured named target and an explicit clear over Agent defaults', async () => {
  const selected = tool({
    name: 'selected',
    parameters: z.object({}),
    execute: () => 'selected',
  });
  const other = tool({
    name: 'other',
    parameters: z.object({}),
    execute: () => 'other',
  });
  const model = new ModelServer(
    Array.from({ length: 4 }, () => [message('finished')]),
  );
  await using provider = await providerFor(model);
  const agent = new Agent({
    model: 'fixture-unlisted-named',
    instructions: 'Answer.',
    tools: [selected, other],
    provider,
    modelSettings: { toolChoice: toolRef('selected') },
  });
  const session = await agent.session();
  let named;
  let cleared;
  try {
    await (await session.submit('capture')).wait();
    named = await session.saveState();
    await session.update({ modelSettings: { toolChoice: null } });
    await (await session.submit('clear')).wait();
    cleared = await session.saveState();
  } finally {
    await session.close();
  }
  {
    await using restored = await agent.session({ state: named! });
    await (await restored.submit('named')).wait();
  }
  {
    await using restored = await agent.session({ state: cleared! });
    await (await restored.submit('clear')).wait();
  }
  for (const index of [0, 2]) {
    expect(model.requests[index]?.tool_choice).toBe('required');
    expect(JSON.stringify(model.requests[index]?.tools)).not.toContain('other');
  }
  for (const index of [1, 3]) {
    expect(model.requests[index]?.tool_choice).toBe('auto');
    expect(JSON.stringify(model.requests[index]?.tools)).toContain('other');
  }
  model.assertExhausted();
}, 35_000);

it('forces only a currently admitted MCP leaf and executes it through native MCP', async () => {
  const calls: { name: string }[] = [];
  const failures: unknown[] = [];
  const peer = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result;
      if (rpc.method === 'initialize')
        result = {
          protocolVersion: rpc.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'named-fixture', version: '1' },
        };
      else if (rpc.method === 'tools/list')
        result = {
          tools: ['search', 'excluded'].map((name) => ({
            name,
            description: name,
            inputSchema: {
              type: 'object',
              properties: { key: { type: 'string' } },
              required: ['key'],
              additionalProperties: false,
            },
          })),
        };
      else if (rpc.method === 'tools/call') {
        calls.push(rpc.params);
        result = { content: [{ type: 'text', text: 'native-mcp-result' }] };
      } else result = {};
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  peer.listen(0, '127.0.0.1');
  await once(peer, 'listening');
  const address = peer.address();
  if (!address || typeof address === 'string') throw new Error('Expected port');
  try {
    const remote = new HttpMCP({
      name: 'docs',
      url: `http://127.0.0.1:${address.port}`,
      tools: ['search', 'excluded'],
    });
    const target = remote.tool('search');
    const model = new ModelServer([
      [
        call(
          target.name,
          { key: '43' },
          {
            callId: 'named-mcp-once',
            namespace: target.namespace ?? undefined,
          },
        ),
      ],
      [message('finished')],
    ]);
    await using provider = await providerFor(model);
    await new Agent({
      model: 'fixture-unlisted-named',
      instructions: 'Search.',
      tools: [remote],
      provider,
      modelSettings: { toolChoice: target },
    }).run('MCP');
    expect(calls.map((item) => item.name)).toEqual(['search']);
    expect(failures).toEqual([]);
    for (const request of model.requests) {
      expect(request.tool_choice).toBe('required');
      const [group] = request.tools as {
        name: string;
        tools: { name: string }[];
      }[];
      expect(group?.name).toBe(target.namespace);
      expect(group?.tools.map((item) => item.name)).toEqual([target.name]);
    }
    model.assertExhausted();
  } finally {
    peer.closeAllConnections();
    await new Promise<void>((resolve) => peer.close(() => resolve()));
  }
}, 35_000);

it('offers one captured hosted target without adding local tool authority', async () => {
  const model = new ModelServer([[message('finished')]]);
  await using provider = await providerFor(model);
  await new Agent({
    model: 'fixture-unlisted-named',
    instructions: 'Search.',
    tools: [fileSearch('synthetic-store')],
    provider,
    modelSettings: { toolChoice: toolRef('file_search', 'functions') },
  }).run('hosted');
  expect(model.requests[0]?.tool_choice).toBe('required');
  expect(model.requests[0]?.tools).toEqual([
    expect.objectContaining({
      type: 'file_search',
      vector_store_ids: ['synthetic-store'],
    }),
  ]);
  model.assertExhausted();
}, 30_000);

it('preserves native structured-output validation with a named leaf', async () => {
  const effects: string[] = [];
  const selected = tool({
    name: 'selected',
    parameters: z.object({}),
    execute: () => {
      effects.push('selected');
      return 'selected';
    },
  });
  const model = new ModelServer([
    [call('selected', {}, { callId: 'structured-selected' })],
    [message('{"answer":"validated"}')],
  ]);
  await using provider = await providerFor(model);
  const result = await new Agent({
    model: 'fixture-unlisted-named',
    instructions: 'Answer.',
    tools: [selected],
    outputType: z.object({ answer: z.string() }),
    provider,
    modelSettings: { toolChoice: toolRef('selected') },
  }).run('structured');
  expect(result.finalOutput).toEqual({ answer: 'validated' });
  expect(effects).toEqual(['selected']);
  for (const request of model.requests)
    expect((request.text as { format: { type: string } }).format.type).toBe(
      'json_schema',
    );
  model.assertExhausted();
}, 30_000);

it('rejects a named leaf that removes required Code Mode helpers', async () => {
  const selected = tool({
    name: 'selected',
    parameters: z.object({}),
    execute: () => {
      throw new Error('Missing helper profile executed');
    },
  });
  const model = new ModelServer([]);
  await using provider = await providerFor(model);
  await expect(
    new Agent({
      model: 'fixture-unlisted-named',
      instructions: 'Select.',
      tools: [selected],
      provider,
      programmaticToolCalling: true,
      modelSettings: { toolChoice: toolRef('selected') },
    }).run('helper conflict'),
  ).rejects.toThrow(/named tool choice/i);
  expect(model.requests).toEqual([]);
  model.assertExhausted();
}, 30_000);
