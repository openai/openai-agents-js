import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  jsonObject,
  type JsonObject,
  type NativeThread,
} from '../../src/runtime/binding';
import {
  Agent,
  NativeProvider,
  Runner,
  ToolOutput,
  tool,
  manualTool,
  toolRef,
  HostedVerificationMCP,
  InteractionRequired,
  HttpMCP,
  localStorage,
} from '@openai/agents-codex';
import type { PreparedRequestData } from '@openai/agents-codex';
import { ModelServer, call, message } from './fixtures/model-server';

// This fixture observes actual HTTP bytes and native tool execution, not a mock model loop.
const closePeers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closePeers.splice(0).map((close) => close()));
  await ModelServer.closeAll();
});
async function peer() {
  const calls: JsonObject[] = [];
  const effects: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rpc = jsonObject.parse(JSON.parse(Buffer.concat(chunks).toString()));
    if (rpc.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: JsonObject = {};
    if (rpc.method === 'initialize')
      result = {
        protocolVersion: jsonObject.parse(rpc.params).protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'editor-peer', version: '1' },
      };
    else if (rpc.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'lookup',
            description: 'Original remote description.',
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string', enum: ['allowed'] } },
              required: ['value'],
              additionalProperties: false,
            },
          },
        ],
      };
    else if (rpc.method === 'tools/call') {
      calls.push(jsonObject.parse(rpc.params));
      effects.push(calls.at(-1)!.arguments);
      result = { content: [{ type: 'text', text: 'MCP_RESULT' }] };
    }
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closePeers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing peer address');
  return { url: `http://127.0.0.1:${address.port}/mcp`, calls, effects };
}
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-editor',
    supportsWebsockets: false,
  });
}

it('combines prepared edits, argument correction and result shaping through public Runner.run', async () => {
  const remote = await peer();
  const effects: string[] = [];
  const stages: string[] = [];
  const reserve = tool({
    name: 'reserve',
    description: 'Original declaration.',
    parameters: z.object({ value: z.enum(['allowed', 'corrected']) }),
    before: ({ callId, originalArguments }) => {
      expect(callId).toBe('first');
      expect(originalArguments).toEqual({ value: 'allowed' });
      stages.push('before');
      return {
        action: 'replaceArguments',
        arguments: { value: 'corrected' as const },
      };
    },
    execute: ({ value }) => {
      stages.push('execute');
      effects.push(value);
      return 'RAW_FUNCTION_RESULT';
    },
    after: (output, { callId, effectiveArguments }) => {
      expect(callId).toBe('first');
      expect(effectiveArguments).toEqual({ value: 'corrected' });
      expect(output.contentItems).toEqual([
        { type: 'inputText', text: 'RAW_FUNCTION_RESULT' },
      ]);
      stages.push('after');
      return new ToolOutput([
        { type: 'inputText', text: 'SHAPED_FUNCTION_RESULT' },
      ]);
    },
  });
  const mcp = new HttpMCP({
    name: 'records',
    url: remote.url,
    tools: ['lookup'],
    approvalMode: 'approve',
    approval: ({ call, effectiveArguments }) => {
      expect(call.callId).toBe('remote');
      expect(effectiveArguments).toEqual({ value: 'allowed' });
      stages.push('mcp-approval');
      return effectiveArguments.value === 'allowed';
    },
  });
  const server = new ModelServer([
    [call('reserve', { value: 'allowed' }, { callId: 'first' })],
    [
      call(
        'lookup',
        { value: 'allowed' },
        { callId: 'remote', namespace: 'mcp__records' },
      ),
    ],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  const snapshots: PreparedRequestData[] = [];
  const context = { callback: () => 'resource' };
  const result = await Runner.run(
    new Agent<typeof context>({
      model: 'gpt-5.5',
      instructions: 'Original instructions.',
      provider,
      tools: [reserve, mcp],
    }),
    'go',
    {
      context,
      returnState: true,
      prepareRequest({
        request,
        preparationIndex,
        recoveryAttempt,
        context: supplied,
      }) {
        expect(supplied).toBe(context);
        expect(recoveryAttempt).toBe(0);
        expect(preparationIndex).toBe(snapshots.length);
        snapshots.push(structuredClone(request));
        const input = z.array(jsonObject).parse(request.input);
        if (
          !input.some(
            (item) =>
              item.type === 'function_call_output' && item.call_id === 'first',
          )
        )
          return;
        request.instructions = 'Edited after the tool.';
        request.input.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'sampling-only-note' }],
        });
        for (const presentation of request.tools) {
          presentation.description = 'Sampled widened presentation.';
          presentation.parameters = {
            type: 'object',
            properties: {
              value: {
                type: 'string',
                enum: ['allowed', 'corrected', 'forbidden'],
              },
            },
            required: ['value'],
            additionalProperties: false,
          };
        }
        return request;
      },
    },
  );
  expect(result.finalOutput).toBe('done');
  expect(effects).toEqual(['corrected']);
  expect(stages).toEqual(['before', 'execute', 'after', 'mcp-approval']);
  expect(remote.calls).toHaveLength(1);
  expect(remote.calls[0].name).toBe('lookup');
  expect(remote.calls[0].arguments).toEqual({ value: 'allowed' });
  expect(remote.effects).toEqual([{ value: 'allowed' }]);
  expect(snapshots).toHaveLength(3);
  const functionOutput = z
    .array(jsonObject)
    .parse(server.requests[1].input)
    .filter(
      (item) =>
        item.type === 'function_call_output' && item.call_id === 'first',
    );
  expect(functionOutput).toHaveLength(1);
  expect(JSON.stringify(functionOutput[0].output)).toContain(
    'SHAPED_FUNCTION_RESULT',
  );
  expect(JSON.stringify(functionOutput[0].output)).not.toContain(
    'RAW_FUNCTION_RESULT',
  );
  const mcpOutput = z
    .array(jsonObject)
    .parse(server.requests[2].input)
    .filter(
      (item) =>
        item.type === 'function_call_output' && item.call_id === 'remote',
    );
  expect(mcpOutput).toHaveLength(1);
  expect(JSON.stringify(mcpOutput[0].output)).toContain('MCP_RESULT');
  for (const request of server.requests.slice(1)) {
    expect(JSON.stringify(request)).toContain('sampling-only-note');
    expect(JSON.stringify(request.input)).toContain('Edited after the tool.');
    const selected = JSON.stringify(request.tools);
    expect(selected).toContain('Sampled widened presentation.');
    expect(selected).toContain('reserve');
    expect(selected).toContain('lookup');
    expect(selected).toContain('forbidden');
    expect(request).not.toHaveProperty('previous_response_id');
  }
  expect(JSON.stringify(result.state)).not.toContain('sampling-only-note');
  expect(reserve.description).toBe('Original declaration.');
});

it.each(['none', 'description', 'partial'] as const)(
  'preserves raw managed schemas through %s preparation',
  async (edit) => {
    const execute = vi.fn(() => 'unused');
    const lookup = tool({
      name: 'lookup',
      description: 'Original lookup.',
      parameters: z.object({ value: z.string().min(3) }),
      execute,
    });
    const server = new ModelServer([[message('done')]]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      model: 'fixture-standard',
      instructions: 'Answer.',
      provider,
      tools: [lookup],
    });
    const result = await agent.run('go', {
      prepareRequest({ request }) {
        expect(request.tools[0].parameters).toMatchObject({
          properties: { value: { minLength: 3 } },
        });
        if (edit === 'description')
          request.tools[0].description = 'Edited lookup.';
        if (edit === 'partial') {
          const properties = jsonObject.parse(
            request.tools[0].parameters.properties,
          );
          request.tools[0].parameters = {
            ...request.tools[0].parameters,
            properties: {
              ...properties,
              value: { ...jsonObject.parse(properties.value), maxLength: 9 },
            },
          };
        }
        return request;
      },
    });
    expect(result.finalOutput).toBe('done');
    expect(server.requests).toHaveLength(1);
    const declarations = JSON.stringify(server.requests[0].tools);
    expect(declarations).toContain('"minLength":3');
    if (edit === 'partial') expect(declarations).toContain('"maxLength":9');
    if (edit === 'description')
      expect(declarations).toContain('Edited lookup.');
    expect(execute).not.toHaveBeenCalled();
  },
);

it('keeps the original function validator when a sampled enum is widened', async () => {
  const execute = vi.fn(() => 'effect');
  const reserve = tool({
    name: 'reserve',
    parameters: z.object({ value: z.enum(['allowed']) }),
    execute,
  });
  const server = new ModelServer([
    [call('reserve', { value: 'forbidden' }, { callId: 'widened' })],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    model: 'gpt-5.5',
    instructions: 'Use reserve.',
    provider,
    tools: [reserve],
  });
  await expect(
    agent.run('go', {
      prepareRequest({ request }) {
        request.tools[0].parameters = {
          type: 'object',
          properties: {
            value: { type: 'string', enum: ['allowed', 'forbidden'] },
          },
          required: ['value'],
          additionalProperties: false,
        };
        return request;
      },
    }),
  ).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  expect(server.requests).toHaveLength(1);
  expect(JSON.stringify(server.requests[0])).toContain('forbidden');
}, 10_000);

it('fails callback errors before dispatch, then permits a fresh operation', async () => {
  const server = new ModelServer([[message('fresh')]]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    model: 'gpt-5.5',
    instructions: 'Answer.',
    provider,
  }).session();
  const failed = await session.submit('first', {
    prepareRequest() {
      throw new Error('synthetic callback failure');
    },
  });
  await expect(failed.wait()).rejects.toThrow('synthetic callback failure');
  expect(server.requests).toHaveLength(0);
  const fresh = await session.submit('next', {
    prepareRequest: () => undefined,
  });
  expect((await fresh.wait()).finalOutput).toBe('fresh');
});

it('joins a cancelled uncooperative callback before admitting the next root', async () => {
  const server = new ModelServer([[message('fresh')]]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    model: 'gpt-5.5',
    instructions: 'Answer.',
    provider,
  }).session();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let signal!: AbortSignal;
  const first = await session.submit('old', {
    async prepareRequest(context) {
      signal = context.signal;
      entered.resolve();
      await release.promise;
      return context.request;
    },
  });
  let cancellation: Promise<void> | undefined;
  try {
    await entered.promise;
    let joined = false;
    cancellation = first.cancel().then(() => {
      joined = true;
    });
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect(joined).toBe(false);
    expect(server.requests).toHaveLength(0);
  } finally {
    release.resolve();
    await cancellation;
    await first.cancel();
  }
  await expect(first.wait()).rejects.toThrow();
  expect(server.requests).toHaveLength(0);
  const next = await session.submit('fresh', {
    prepareRequest: () => undefined,
  });
  expect((await next.wait()).finalOutput).toBe('fresh');
});

it.each(['empty', 'eager-reference'] as const)(
  'prepares the selected %s roster when the opening catalog has a deferred tool',
  async (selection) => {
    const eager = tool({
      name: 'eager',
      parameters: z.object({}),
      execute: () => 'unused',
    });
    const deferred = tool({
      name: 'deferred',
      parameters: z.object({}),
      deferLoading: true,
      execute: () => 'unused',
    });
    const server = new ModelServer([[message('done')]]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      model: 'gpt-5.5',
      instructions: 'Answer.',
      provider,
      tools: [eager, deferred],
    }).session();
    const editor = vi.fn(({ request }: { request: PreparedRequestData }) => {
      expect(request.tools.map((tool) => tool.name)).toEqual(
        selection === 'empty' ? [] : ['eager'],
      );
      return request;
    });
    const turn = await session.submit('go', {
      tools: selection === 'empty' ? [] : [toolRef('eager')],
      prepareRequest: editor,
    });
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(editor).toHaveBeenCalledTimes(1);
    expect(server.requests[0].tools).toEqual(
      selection === 'empty'
        ? []
        : [expect.objectContaining({ type: 'function', name: 'eager' })],
    );
  },
);

it('refuses a selected deferred tool before the editor, HTTP and tool effects', async () => {
  const execute = vi.fn(() => 'unused');
  const deferred = tool({
    name: 'deferred',
    parameters: z.object({}),
    deferLoading: true,
    execute,
  });
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    model: 'gpt-5.5',
    instructions: 'Answer.',
    provider,
    tools: [deferred],
  }).session();
  const editor = vi.fn(() => undefined);
  const turn = await session.submit('go', {
    tools: [toolRef('deferred')],
    prepareRequest: editor,
  });
  await expect(turn.wait()).rejects.toThrow(/prepare_request.*eager/i);
  expect(editor).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(server.requests).toHaveLength(0);
});

it('checks the roster after beforeStep and preserves effects before a later deferred selection', async () => {
  const execute = vi.fn(() => 'original effect');
  const eager = tool({ name: 'eager', parameters: z.object({}), execute });
  const deferredExecute = vi.fn(() => 'unused');
  const deferred = tool({
    name: 'deferred',
    parameters: z.object({}),
    deferLoading: true,
    execute: deferredExecute,
  });
  const server = new ModelServer([[call('eager', {}, { callId: 'effect' })]]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    model: 'gpt-5.5',
    instructions: 'Call eager.',
    provider,
    tools: [eager, deferred],
  }).session();
  const editor = vi.fn(({ request }: { request: PreparedRequestData }) => {
    expect(request.tools.map((tool) => tool.name)).toEqual(['eager']);
    return request;
  });
  const beforeStep = vi.fn(({ stepIndex }: { stepIndex: number }) => [
    toolRef(stepIndex === 0 ? 'eager' : 'deferred'),
  ]);
  const turn = await session.submit('go', {
    beforeStep,
    prepareRequest: editor,
  });
  await expect(turn.wait()).rejects.toThrow(/prepare_request.*eager/i);
  expect(beforeStep).toHaveBeenCalledTimes(2);
  expect(editor).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(deferredExecute).not.toHaveBeenCalled();
  expect(server.requests).toHaveLength(1);
  expect(server.requests[0].tools).toEqual([
    expect.objectContaining({ type: 'function', name: 'eager' }),
  ]);
});

it('keeps the operation ceiling when beforeStep tries to select an excluded deferred tool', async () => {
  const eager = tool({
    name: 'eager',
    parameters: z.object({}),
    execute: () => 'unused',
  });
  const deferred = tool({
    name: 'deferred',
    parameters: z.object({}),
    deferLoading: true,
    execute: () => 'unused',
  });
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    model: 'gpt-5.5',
    instructions: 'Answer.',
    provider,
    tools: [eager, deferred],
  }).session();
  const editor = vi.fn(() => undefined);
  const turn = await session.submit('go', {
    tools: [toolRef('eager')],
    beforeStep: () => [toolRef('deferred')],
    prepareRequest: editor,
  });
  await expect(turn.wait()).rejects.toThrow();
  expect(editor).not.toHaveBeenCalled();
  expect(server.requests).toHaveLength(0);
});

it('keeps fixed hosted MCP registration outside the editor profile even with no selected tools', async () => {
  const remote = await peer();
  const hosted = new HostedVerificationMCP({
    url: remote.url,
    tools: ['lookup'],
    deferLoading: false,
  });
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    model: 'gpt-5.5',
    instructions: 'Answer.',
    provider,
    tools: [hosted],
  }).session();
  const editor = vi.fn(() => undefined);
  await expect(
    session.submit('go', { tools: [], prepareRequest: editor }),
  ).rejects.toThrow(/eager function/i);
  expect(editor).not.toHaveBeenCalled();
  expect(remote.effects).toHaveLength(0);
  expect(server.requests).toHaveLength(0);
});

it.each([false, true])(
  'requires a one-shot interaction handler with an editor and manual tools (handler=%s)',
  async (handled) => {
    const approval = manualTool({
      name: 'approval',
      description: 'Wait.',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      [call('approval', {}, { callId: 'manual' })],
      [message('continued')],
    ]);
    await using provider = await providerFor(server);
    const editor = vi.fn(() => undefined);
    const result = new Agent({
      model: 'gpt-5.5',
      instructions: 'Ask.',
      provider,
      tools: [approval],
    }).run('go', {
      prepareRequest: editor,
      ...(handled
        ? {
            onInteraction: (action: Parameters<typeof approval.match>[0]) =>
              approval.match(action)!.reply('approved'),
          }
        : {}),
    });
    if (handled) {
      await expect(result).resolves.toMatchObject({ finalOutput: 'continued' });
      expect(editor).toHaveBeenCalledTimes(2);
      expect(server.requests).toHaveLength(2);
    } else {
      await expect(result).rejects.toBeInstanceOf(InteractionRequired);
      expect(editor).not.toHaveBeenCalled();
      expect(server.requests).toHaveLength(0);
    }
  },
);

it('rejects a new request editor before restoring an admitted manual turn', async () => {
  const approval = manualTool({
    name: 'approval',
    description: 'Wait.',
    parameters: z.object({}),
    result: z.string(),
  });
  const server = new ModelServer([
    [call('approval', {}, { callId: 'manual' })],
    [message('continued')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    model: 'gpt-5.5',
    instructions: 'Ask.',
    provider,
    tools: [approval],
  });
  await using session = await agent.session();
  const turn = await session.submit('go');
  const pending = await turn.wait({ until: 'request' });
  expect(pending).toHaveProperty('requests');
  const state = await session.suspend();
  await session.close();
  const editor = vi.fn(() => undefined);
  const onInteraction = vi.fn((action: Parameters<typeof approval.match>[0]) =>
    approval.match(action)!.reply('approved'),
  );
  await expect(
    agent.run(null, { state, prepareRequest: editor, onInteraction }),
  ).rejects.toThrow('Cannot add prepareRequest when resuming a run');
  expect(editor).not.toHaveBeenCalled();
  expect(onInteraction).not.toHaveBeenCalled();
  expect(server.requests).toHaveLength(1);
  await expect(
    agent.run(null, { state, onInteraction }),
  ).resolves.toMatchObject({
    finalOutput: 'continued',
  });
  expect(server.requests).toHaveLength(2);
  expect(JSON.stringify(server.requests[1]!.input)).toContain('approved');
});

it('refuses active manual checkpoint readiness and export after preparation settles', async () => {
  const approval = manualTool({
    name: 'approval',
    description: 'Wait.',
    parameters: z.object({}),
    result: z.string(),
  });
  const server = new ModelServer([
    [call('approval', {}, { callId: 'manual' })],
    [message('continued')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    model: 'gpt-5.5',
    instructions: 'Ask.',
    provider,
    tools: [approval],
  }).session();
  const indices: number[] = [];
  const turn = await session.submit('go', {
    prepareRequest: ({ preparationIndex }) => {
      indices.push(preparationIndex);
      return undefined;
    },
  });
  const pending = await turn.wait({ until: 'request' });
  if (!('requests' in pending)) throw new Error('Expected manual request');
  expect((await session.checkpointStatus({ kind: 'manualWait' })).status).toBe(
    'notReady',
  );
  await expect(session.suspend()).rejects.toThrow(
    'callback-selected operation',
  );
  await session.respond(approval.match(pending.requests[0])!.reply('approved'));
  expect((await turn.wait()).finalOutput).toBe('continued');
  expect(indices).toEqual([0, 1]);
});

it('edits the combined function/MCP conversation after both results while original MCP policy blocks widened arguments before RPC', async () => {
  const remote = await peer();
  const approvals: unknown[] = [];
  const mcp = new HttpMCP({
    name: 'records',
    url: remote.url,
    tools: ['lookup'],
    approvalMode: 'approve',
    approval: ({ effectiveArguments }) => {
      approvals.push(effectiveArguments.value);
      return effectiveArguments.value === 'allowed'
        ? true
        : { action: 'stop' as const };
    },
  });
  let effects = 0;
  const local = tool({
    name: 'reserve',
    parameters: z.object({ value: z.enum(['allowed']) }),
    execute: () => {
      effects++;
      return 'FUNCTION_RESULT';
    },
  });
  const server = new ModelServer([
    [call('reserve', { value: 'allowed' }, { callId: 'local' })],
    [
      call(
        'lookup',
        { value: 'allowed' },
        { namespace: 'mcp__records', callId: 'remote' },
      ),
    ],
    [
      call(
        'lookup',
        { value: 'forbidden' },
        { namespace: 'mcp__records', callId: 'denied' },
      ),
    ],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    model: 'gpt-5.5',
    instructions: 'Use the selected tools.',
    provider,
    tools: [local, mcp],
  }).session();
  const turn = await session.submit('go', {
    prepareRequest({ request, preparationIndex }) {
      if (preparationIndex < 2) return;
      const history = JSON.stringify(request.input);
      expect(history).toContain('FUNCTION_RESULT');
      expect(history).toContain('MCP_RESULT');
      request.instructions = 'Edited combined request.';
      request.input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'sampling-only-combined-note' }],
      });
      for (const presentation of request.tools.filter((tool) =>
        ['reserve', 'lookup'].includes(tool.name),
      )) {
        presentation.description = 'Edited selected description.';
        presentation.parameters = {
          type: 'object',
          properties: {
            value: { type: 'string', enum: ['allowed', 'forbidden'] },
          },
          required: ['value'],
          additionalProperties: false,
        };
      }
      return request;
    },
  });
  await expect(turn.wait()).rejects.toThrow();
  expect(effects).toBe(1);
  expect(approvals).toEqual(['allowed', 'forbidden']);
  expect(remote.calls).toHaveLength(1);
  expect(server.requests).toHaveLength(3);
  const edited = JSON.stringify(server.requests[2]);
  expect(edited).toContain('sampling-only-combined-note');
  expect(edited).toContain('Edited selected description.');
  expect(edited).toContain('forbidden');
  expect(server.requests[2]).not.toHaveProperty('previous_response_id');
});

it('uses one captured edit for an HTTP retry and detaches retained callback objects', async () => {
  const server = new ModelServer([
    { status: 500, body: 'synthetic retry' },
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  const lookup = tool({
    name: 'lookup',
    description: 'Original lookup.',
    parameters: z.object({ value: z.string().min(3) }),
    execute: () => 'unused',
  });
  let preparations = 0;
  let retained!: PreparedRequestData;
  const result = await new Agent({
    model: 'gpt-5.5',
    instructions: 'Answer.',
    provider,
    tools: [lookup],
  }).run('go', {
    prepareRequest({ request }) {
      preparations++;
      request.instructions = 'Captured edit.';
      request.tools[0].description = 'Captured description.';
      retained = request;
      setTimeout(() => {
        retained.instructions = 'Late retained mutation.';
        retained.tools[0].description = 'Late description mutation.';
      }, 0);
      return request;
    },
  });
  expect(result.finalOutput).toBe('done');
  expect(preparations).toBe(1);
  expect(server.requests).toHaveLength(2);
  for (const request of server.requests) {
    expect(JSON.stringify(request)).toContain('Captured edit.');
    expect(JSON.stringify(request)).not.toContain('Late retained mutation.');
    expect(JSON.stringify(request.tools)).toContain('Captured description.');
    expect(JSON.stringify(request.tools)).toContain('minLength');
    expect(JSON.stringify(request.tools)).not.toContain(
      'Late description mutation.',
    );
  }
});

it('exports idle canonical history and requires a fresh editor after restore', async () => {
  const server = new ModelServer([[message('first')], [message('second')]]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    model: 'gpt-5.5',
    instructions: 'Answer.',
    provider,
  });
  const first = await agent.run('go', {
    returnState: true,
    prepareRequest({ request }) {
      request.input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'ephemeral-note' }],
      });
      return request;
    },
  });
  expect(JSON.stringify(first.state)).not.toContain('ephemeral-note');
  const editor = vi.fn(() => undefined);
  const second = await agent.run('next', {
    state: first.state,
    prepareRequest: editor,
  });
  expect(second.finalOutput).toBe('second');
  expect(editor).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(server.requests[1])).not.toContain('ephemeral-note');
});

it.each([true, false])(
  'refuses hidden model-change compaction only with editor=%s',
  async (edited) => {
    const server = new ModelServer([
      [message('original')],
      [message('summary')],
      [message('changed')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session();
    await (await session.submit('establish history')).wait();
    await session.update({ model: 'gpt-5.5' });
    const editor = vi.fn(() => undefined);
    const turn = await session.submit(
      'change model',
      edited ? { prepareRequest: editor } : undefined,
    );
    if (edited) {
      await expect(turn.wait()).rejects.toThrow(/compaction/i);
      const terminals = [];
      for await (const event of turn.events())
        if (event.type === 'turn_finished') terminals.push(event);
      expect(terminals).toHaveLength(1);
      expect(terminals[0].status).toBe('failed');
      expect(server.requests).toHaveLength(1);
      expect(editor).not.toHaveBeenCalled();
    } else {
      expect((await turn.wait()).finalOutput).toBe('changed');
      expect(server.requests).toHaveLength(3);
    }
  },
);

it.each([true, false])(
  'refuses post-tool rollover before hidden dispatch only with editor=%s',
  async (edited) => {
    // The native factory is the existing low-level capacity seam. The public operation and all HTTP/tool work remain real.
    const { binding } = await import('../../src/runtime/binding');
    const native = await binding();
    const nativeErrors: unknown[] = [];
    const nextEvent = native.NativeThread.prototype._next_session_event;
    const observer = vi
      .spyOn(native.NativeThread.prototype, '_next_session_event')
      .mockImplementation(async function (this: NativeThread) {
        const raw = await nextEvent.call(this);
        const event = JSON.parse(raw);
        if (
          event.msg.type === 'error' &&
          String(event.msg.message).includes('automatic compaction')
        )
          nativeErrors.push(event.msg);
        return raw;
      });
    const create = native.create_engine;
    const spy = vi
      .spyOn(native, 'create_engine')
      .mockImplementation((config, ...args) => {
        const parsed = JSON.parse(config);
        return create(
          JSON.stringify({
            ...parsed,
            model_context_window: 200000,
            model_auto_compact_token_limit: 10000,
          }),
          ...args,
        );
      });
    let effects = 0;
    const reserve = tool({
      name: 'reserve',
      parameters: z.object({}),
      execute: () => {
        effects++;
        return 'completed tool effect';
      },
    });
    const server = new ModelServer(
      [
        [call('reserve', {}, { callId: 'effect' })],
        [message('summary')],
        [message('done')],
      ],
      ['{"input_tokens":12000,"output_tokens":1,"total_tokens":12001}'],
    );
    try {
      await using provider = await providerFor(server);
      await using session = await new Agent({
        model: 'gpt-5.5',
        instructions: 'Use reserve once.',
        provider,
        tools: [reserve],
      }).session();
      const editor = vi.fn(() => undefined);
      const turn = await session.submit(
        'go',
        edited ? { prepareRequest: editor } : undefined,
      );
      if (edited) {
        await expect(turn.wait()).rejects.toThrow(/compaction/i);
        const terminals = [];
        for await (const event of turn.events())
          if (event.type === 'turn_finished') terminals.push(event);
        expect(terminals).toHaveLength(1);
        expect(terminals[0].status).toBe('failed');
        expect(nativeErrors).toHaveLength(1);
        expect(server.requests).toHaveLength(1);
        expect(editor).toHaveBeenCalledTimes(1);
      } else {
        expect((await turn.wait()).finalOutput).toBe('done');
        expect(nativeErrors).toHaveLength(0);
        expect(server.requests).toHaveLength(3);
      }
      expect(effects).toBe(1);
    } finally {
      observer.mockRestore();
      spy.mockRestore();
    }
  },
);

it('rejects a retired native reply capability while a later root awaits its own callback', async () => {
  const { binding } = await import('../../src/runtime/binding');
  const native = await binding();
  const original = native.NativeThread.prototype._reply_prepared_request;
  let retained:
    | { owner: typeof native.NativeThread.prototype; receipt: string }
    | undefined;
  const spy = vi
    .spyOn(native.NativeThread.prototype, '_reply_prepared_request')
    .mockImplementation(function (
      this: typeof native.NativeThread.prototype,
      receipt,
    ) {
      retained ??= { owner: this, receipt };
      return original.call(this, receipt);
    });
  const release = Promise.withResolvers<void>();
  try {
    const server = new ModelServer([[message('old')], [message('new')]]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      model: 'gpt-5.5',
      instructions: 'Answer.',
      provider,
    }).session();
    await (
      await session.submit('old', { prepareRequest: () => undefined })
    ).wait();
    const entered = Promise.withResolvers<void>();
    const next = await session.submit('new', {
      async prepareRequest() {
        entered.resolve();
        await release.promise;
        return undefined;
      },
    });
    try {
      await entered.promise;
      expect(retained).toBeDefined();
      expect(() => original.call(retained!.owner, retained!.receipt)).toThrow(
        /Expired prepared request/,
      );
      expect(server.requests).toHaveLength(1);
    } finally {
      release.resolve();
    }
    expect((await next.wait()).finalOutput).toBe('new');
    expect(server.requests).toHaveLength(2);
  } finally {
    release.resolve();
    spy.mockRestore();
  }
});

it('reopens completed idle LocalStorage history with only a freshly supplied editor', async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-editor-storage-'));
  try {
    const storage = localStorage(join(home, 'profile'));
    const server = new ModelServer([
      [message('persisted answer')],
      [message('fresh answer')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      model: 'gpt-5.5',
      instructions: 'Canonical instructions.',
      provider,
    });
    const oldEditor = vi.fn(({ request }: { request: PreparedRequestData }) => {
      request.instructions = 'Old sampling instructions.';
      request.input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'sampling-only-local-note' }],
      });
      return request;
    });
    let id!: string;
    let canonical!: unknown[];
    {
      await using first = await agent.session({ storage });
      id = first.id;
      expect(
        (
          await (
            await first.submit('original user input', {
              prepareRequest: oldEditor,
            })
          ).wait()
        ).finalOutput,
      ).toBe('persisted answer');
      canonical = [];
      for await (const item of first.items()) canonical.push(item);
      expect(JSON.stringify(canonical)).not.toContain(
        'sampling-only-local-note',
      );
      expect(JSON.stringify(canonical)).not.toContain(
        'Old sampling instructions.',
      );
    }
    await using reopened = await agent.session({ storage, resume: id });
    expect(reopened.id).toBe(id);
    const restored = [];
    for await (const item of reopened.items()) restored.push(item);
    expect(restored).toEqual(canonical);
    const freshEditor = vi.fn(
      ({
        request,
        preparationIndex,
        recoveryAttempt,
      }: {
        request: PreparedRequestData;
        preparationIndex: number;
        recoveryAttempt: number;
      }) => {
        expect(preparationIndex).toBe(0);
        expect(recoveryAttempt).toBe(0);
        expect(JSON.stringify(request)).not.toContain(
          'sampling-only-local-note',
        );
        expect(request.instructions).not.toContain(
          'Old sampling instructions.',
        );
        request.instructions = 'Fresh sampling instructions.';
        return request;
      },
    );
    const next = await reopened.submit('next user input', {
      prepareRequest: freshEditor,
    });
    expect((await next.wait()).finalOutput).toBe('fresh answer');
    expect(oldEditor).toHaveBeenCalledTimes(1);
    expect(freshEditor).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(server.requests[1])).toContain('original user input');
    expect(JSON.stringify(server.requests[1])).toContain('persisted answer');
    expect(JSON.stringify(server.requests[1])).toContain(
      'Fresh sampling instructions.',
    );
    expect(JSON.stringify(server.requests[1])).not.toContain(
      'sampling-only-local-note',
    );
    server.assertExhausted();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('prepares again when outer stream recovery rebuilds the prompt', async () => {
  // A failed event on a successful HTTP response exercises outer stream recovery.
  const failure = JSON.stringify({
    type: 'response.failed',
    response: {
      error: {
        type: 'server_error',
        code: 'server_error',
        message: 'retry synthetic stream',
      },
    },
  });
  const server = new ModelServer([
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: `data: ${failure}\n\n`,
    },
    [message('recovered')],
  ]);
  await using provider = await providerFor(server);
  const indices: [number, number][] = [];
  const result = await new Agent({
    model: 'gpt-5.5',
    instructions: 'Answer.',
    provider,
  }).run('Try', {
    prepareRequest({ request, preparationIndex, recoveryAttempt }) {
      indices.push([preparationIndex, recoveryAttempt]);
      return request;
    },
  });
  expect(result.finalOutput).toBe('recovered');
  expect(indices).toEqual([
    [0, 0],
    [1, 1],
  ]);
  expect(server.requests).toHaveLength(2);
  expect(
    server.requests.every((request) => !('previous_response_id' in request)),
  ).toBe(true);
  server.assertExhausted();
}, 30_000);

it('rejects correction-enabled Session defaults and per-operation overrides before native submission', async () => {
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const outputType = {
    mode: 'prompted' as const,
    schema: z.object({ answer: z.string() }),
    maxRetries: 1,
  };
  const editor = vi.fn(() => undefined);
  await using repairing = await new Agent({
    model: 'gpt-5.5',
    instructions: 'Answer.',
    provider,
    outputType,
  }).session();
  await expect(
    repairing.submit('default', { prepareRequest: editor }),
  ).rejects.toThrow('output correction attempts');
  await using plain = await new Agent({
    model: 'gpt-5.5',
    instructions: 'Answer.',
    provider,
  }).session();
  await expect(
    plain.submitWithOutput('override', outputType, { prepareRequest: editor }),
  ).rejects.toThrow('output correction attempts');
  await expect(
    plain.enqueue('queued override', outputType, { prepareRequest: editor }),
  ).rejects.toThrow('output correction attempts');
  expect(server.requests).toHaveLength(0);
  expect(editor).not.toHaveBeenCalled();
});

it.each(['native', 'prompted-zero'] as const)(
  'supports edited %s output without correction requests',
  async (profile) => {
    const server = new ModelServer([[message('{"answer":"valid"}')]]);
    await using provider = await providerFor(server);
    const schema = z.object({ answer: z.string() });
    const outputType =
      profile === 'native'
        ? { mode: 'native' as const, schema }
        : { mode: 'prompted' as const, schema, maxRetries: 0 };
    const editor = vi.fn(() => undefined);
    const result = await new Agent({
      model: 'gpt-5.5',
      instructions: 'Answer.',
      provider,
      outputType,
    }).run('go', { prepareRequest: editor });
    expect(result.finalOutput).toEqual({ answer: 'valid' });
    expect(editor).toHaveBeenCalledTimes(1);
    expect(server.requests).toHaveLength(1);
  },
);

it('preserves ordinary output correction when prepareRequest is omitted', async () => {
  const server = new ModelServer([
    [message('invalid output')],
    [message('{"answer":"corrected"}')],
  ]);
  await using provider = await providerFor(server);
  const outputType = {
    mode: 'prompted' as const,
    schema: z.object({ answer: z.string() }),
    maxRetries: 1,
  };
  const result = await new Agent({
    model: 'gpt-5.5',
    instructions: 'Answer.',
    provider,
    outputType,
  }).run('go');
  expect(result.finalOutput).toEqual({ answer: 'corrected' });
  expect(server.requests).toHaveLength(2);
});

it.each(['no-edit', 'unchanged', 'description', 'parameters', 'both'] as const)(
  'keeps clean presentation and field-specific schema fidelity for %s',
  async (edit) => {
    const selected = tool({
      name: 'lookup',
      description: 'Original raw-schema description.',
      parameters: z.object({ value: z.string().min(3) }),
      execute: () => 'unused',
    });
    const server = new ModelServer([[message('done')]]);
    await using provider = await providerFor(server);
    const replacement = {
      type: 'object',
      properties: { value: { type: 'string', enum: ['allowed', 'wider'] } },
      required: ['value'],
      additionalProperties: false,
    };
    const result = await new Agent({
      model: 'gpt-5.5',
      instructions: 'Answer.',
      provider,
      tools: [selected],
    }).run('go', {
      prepareRequest({ request }) {
        expect(request.tools[0].description).toBe(
          'Original raw-schema description.',
        );
        expect(request.tools[0].description).not.toContain('[agents-schema:');
        if (edit === 'no-edit') return;
        if (edit === 'description' || edit === 'both')
          request.tools[0].description = 'Edited clean description.';
        if (edit === 'parameters' || edit === 'both')
          request.tools[0].parameters = replacement;
        return request;
      },
    });
    expect(result.finalOutput).toBe('done');
    const declaration = z
      .array(jsonObject)
      .parse(server.requests[0].tools)
      .find((tool) => tool.name === 'lookup');
    expect(declaration).toBeDefined();
    expect(declaration!.description).toBe(
      edit === 'description' || edit === 'both'
        ? 'Edited clean description.'
        : 'Original raw-schema description.',
    );
    expect(JSON.stringify(declaration)).not.toContain('[agents-schema:');
    expect(declaration!.parameters).toEqual(
      edit === 'parameters' || edit === 'both'
        ? replacement
        : selected.parameters,
    );
    expect(server.requests).toHaveLength(1);
  },
);

it('preserves raw edited bounds and null schema keys while original execution validation remains authoritative', async () => {
  const effects: number[] = [];
  const selected = tool({
    name: 'lookup',
    parameters: z.object({ value: z.number().max(10) }),
    execute: ({ value }) => {
      effects.push(value);
      return 'effect';
    },
  });
  const replacement = {
    type: 'object',
    properties: {
      value: { type: 'number', maximum: 20, unknown_null_key: null },
    },
    required: ['value'],
    additionalProperties: false,
  };
  const server = new ModelServer([
    [call('lookup', { value: 7 }, { callId: 'allowed' })],
    [call('lookup', { value: 15 }, { callId: 'above-original-maximum' })],
  ]);
  await using provider = await providerFor(server);
  const result = new Agent({
    model: 'gpt-5.5',
    instructions: 'Call lookup then answer.',
    provider,
    tools: [selected],
  }).run('go', {
    prepareRequest({ request }) {
      request.tools[0].parameters = structuredClone(replacement);
      return request;
    },
  });
  await expect(result).rejects.toMatchObject({
    issues: [
      expect.objectContaining({
        code: 'too_big',
        maximum: 10,
        path: ['value'],
      }),
    ],
  });
  expect(effects).toEqual([7]);
  expect(server.requests).toHaveLength(2);
  for (const request of server.requests) {
    expect(request.tools).toEqual([
      expect.objectContaining({
        name: 'lookup',
        type: 'function',
        parameters: replacement,
      }),
    ]);
    expect(JSON.stringify(request.tools)).not.toContain('[agents-schema:');
  }
});

it('rejects a lossy ordinary MCP schema edit without a managed raw receipt before HTTP or effects', async () => {
  const remote = await peer();
  const selected = new HttpMCP({
    name: 'records',
    url: remote.url,
    tools: ['lookup'],
    deferLoading: false,
  });
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  await expect(
    new Agent({
      model: 'gpt-5.5',
      instructions: 'Answer.',
      provider,
      tools: [selected],
    }).run('go', {
      prepareRequest({ request }) {
        request.tools[0].parameters = {
          type: 'object',
          properties: {
            value: { type: 'number', maximum: 20, unknown_null_key: null },
          },
          required: ['value'],
        };
        return request;
      },
    }),
  ).rejects.toThrow(/loses fields|prepared.request/i);
  expect(remote.effects).toHaveLength(0);
  expect(server.requests).toHaveLength(0);
});
