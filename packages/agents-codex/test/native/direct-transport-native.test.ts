import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent as ClassicAgent } from '@openai/agents-core';
import {
  ScriptedModel,
  assistantMessage,
  modelResponse,
} from '@openai/agents-core/testing';
import {
  Agent,
  NativeError,
  NativeProvider,
  tool,
  type ModelRequestDispatching,
  type ModelResponseLinked,
} from '../../src';
import { SDKRunner } from '../../src/migration';
import {
  binding,
  jsonObject,
  type JsonObject,
} from '../../src/runtime/binding';
import { NativeProviderRoutes } from '../../src/runtime/http-model';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(async () => {
  // Each test disposes sessions/providers before shared upstream servers close.
  try {
    await ModelServer.closeAll();
  } finally {
    vi.restoreAllMocks();
  }
});

async function carrierCounters() {
  const native = await binding();
  // Observe private boundaries without changing routing or supplying a test flag.
  const routes = NativeProviderRoutes.prototype as unknown as {
    handle(
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<boolean>;
  };
  return {
    handle: vi.spyOn(routes, 'handle'),
    stream: vi.spyOn(native.Engine.prototype, '_sentinel_stream'),
    chunks: vi.spyOn(native.NativeModelResponse.prototype, 'next_chunk'),
  };
}

function expectDirect(counts: Awaited<ReturnType<typeof carrierCounters>>) {
  expect(counts.handle).not.toHaveBeenCalled();
  expect(counts.stream).not.toHaveBeenCalled();
  expect(counts.chunks).not.toHaveBeenCalled();
}

async function providerFor(server: ModelServer, supportsWebsockets = false) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-direct-transport-key',
    supportsWebsockets,
  });
}

// ModelServer owns the endpoint and its prescribed responses. This observation
// exposes only its existing Node server so tests can watch close/upgrade events.
function endpoint(server: ModelServer): Server {
  return (server as unknown as { server: Server }).server;
}

function heldToolCall(phase: 'before headers' | 'during SSE') {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const execute = vi.fn(() => 'unexpected effect');
  const server = new ModelServer(
    [
      async () => {
        if (phase === 'before headers') {
          entered.resolve();
          await release.promise;
        }
        return [call('write_once', {}, { callId: 'late-direct-call' })];
      },
      [message('fresh answer')],
    ],
    [],
    async () => {
      if (phase === 'during SSE' && server.requests.length === 1) {
        entered.resolve();
        await release.promise;
      }
    },
  );
  endpoint(server).once('request', (_request, response) => {
    response.once('close', () => closed.resolve());
  });
  server.onRecord = (event) => {
    if (event === 'MODEL_COMPLETED_FRAME') completed.resolve();
  };
  return { server, entered, release, closed, completed, execute };
}

function declarations(request: JsonObject): JsonObject[] {
  const collect = (values: unknown): JsonObject[] => {
    if (!Array.isArray(values)) return [];
    return values.flatMap((value) => {
      const item = jsonObject.parse(value);
      return item.type === 'namespace' ? collect(item.tools) : [item];
    });
  };
  return collect(request.tools);
}

it('dispatches native HTTP directly with full schemas, headers and observations', async () => {
  const counts = await carrierCounters();
  const terminal = JSON.stringify({
    type: 'response.completed',
    response: {
      id: 'direct-success',
      headers: { 'x-ratelimit-remaining-requests': '7' },
      usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 },
    },
  });
  const server = new ModelServer([[message('direct answer')]], [], undefined, [
    terminal,
  ]);
  const lookup = tool({
    name: 'lookup',
    description: 'Read a record using its nested owner.',
    parameters: z.object({
      key: z.string().min(9),
      record: z.object({ owner: z.object({ team: z.string().min(2) }) }),
    }),
    execute: () => 'unused',
  });
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer directly.',
    model: 'gpt-5.5',
    provider,
    tools: [lookup],
    modelSettings: { reasoningEffort: 'low', serviceTier: 'flex' },
  }).session();
  const turn = await session.submit('direct request marker');
  const result = await turn.wait();
  expect(result.finalOutput).toBe('direct answer');
  expect(result.usage?.totalTokenUsage.totalTokens).toBe(13);
  expect(server.requests).toHaveLength(1);
  const request = server.requests[0];
  expect(request.model).toBe('gpt-5.5');
  expect(request.stream).toBe(true);
  expect(JSON.stringify(request.input)).toContain('direct request marker');
  expect(declarations(request)).toContainEqual(
    expect.objectContaining({
      name: 'lookup',
      description: lookup.description,
      parameters: lookup.parameters,
    }),
  );
  expect(JSON.stringify(request)).not.toContain('[agents-schema:');
  expect(jsonObject.parse(request.client_metadata ?? {})).not.toHaveProperty(
    'sdk_sentinel_thread',
  );
  expect(jsonObject.parse(request.client_metadata ?? {})).not.toHaveProperty(
    'sdk_sentinel_nonce',
  );
  expect(server.requestHeaders[0]).toMatchObject({
    authorization: 'Bearer synthetic-direct-transport-key',
    'x-client-request-id': session.id,
    originator: expect.any(String),
    'user-agent': expect.any(String),
  });
  expect(server.requestHeaders[0]).not.toHaveProperty('x-sdk-sentinel-grant');
  const events = [];
  for await (const event of turn.events()) events.push(event);
  const dispatches = events.filter(
    (event): event is ModelRequestDispatching =>
      event.type === 'model_request_dispatching',
  );
  const links = events.filter(
    (event): event is ModelResponseLinked =>
      event.type === 'model_response_linked',
  );
  expect(dispatches).toHaveLength(1);
  expect(links).toHaveLength(1);
  expect(dispatches[0]).toMatchObject({
    threadId: session.id,
    turnId: turn.turnId,
    submissionId: turn.submissionId,
    model: request.model,
    transport: 'http_sse',
    reasoningEffort: 'low',
    serviceTier: 'flex',
  });
  expect(links[0].requestId).toBe(dispatches[0].requestId);
  expect(session.rateLimits()).toEqual({ requests: { remaining: 7 } });
  expectDirect(counts);
  server.assertExhausted();
}, 30_000);

it('declines selected JavaScript Models and keeps their real carrier', async () => {
  const counts = await carrierCounters();
  const model = new ScriptedModel([
    modelResponse([assistantMessage('selected answer')]),
  ]);
  const result = await SDKRunner.run(
    new ClassicAgent({
      name: 'Selected direct-transport regression',
      instructions: 'Answer directly.',
      model,
    }),
    'selected request marker',
    { context: {} },
  );
  expect(result.finalOutput).toBe('selected answer');
  expect(model.calls).toHaveLength(1);
  expect(JSON.stringify(model.calls[0].request.input)).toContain(
    'selected request marker',
  );
  expect(counts.handle).toHaveBeenCalledTimes(1);
  // SelectedModelInvocation.produce owns this response rather than native I/O.
  expect(counts.stream).not.toHaveBeenCalled();
  expect(counts.chunks).not.toHaveBeenCalled();
});

it.each(['before headers', 'during SSE'] as const)(
  'joins cancellation %s without accepting a late tool call',
  async (phase) => {
    const counts = await carrierCounters();
    const { server, entered, release, closed, completed, execute } =
      heldToolCall(phase);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use write_once then answer.',
      provider,
      tools: [tool({ name: 'write_once', parameters: z.object({}), execute })],
    }).session();
    try {
      const turn = await session.submit('cancel marker');
      const outcome = turn.wait().catch((error: unknown) => error);
      await entered.promise;
      expect(server.requests).toHaveLength(1);
      await turn.cancel();
      expect(await outcome).toBeInstanceOf(NativeError);
      // The upstream close must happen while its output remains held.
      await closed.promise;
      expect(execute).not.toHaveBeenCalled();
      release.resolve();
      await completed.promise;
      expect(
        (await (await session.submit('fresh marker')).wait()).finalOutput,
      ).toBe('fresh answer');
      expect(server.requests).toHaveLength(2);
      expect(execute).not.toHaveBeenCalled();
      expectDirect(counts);
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  },
  30_000,
);

it.each(['before headers', 'during SSE'] as const)(
  'joins managed Session and Engine close %s before releasing provider output',
  async (phase) => {
    const counts = await carrierCounters();
    const native = await binding();
    const bound = vi.spyOn(NativeProviderRoutes.prototype, 'bindEngine');
    const engineClose = vi.spyOn(native.Engine.prototype, '_close_report');
    const { server, entered, release, closed, completed, execute } =
      heldToolCall(phase);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Use write_once then answer.',
      provider,
      tools: [tool({ name: 'write_once', parameters: z.object({}), execute })],
    });
    await using session = await agent.session();
    const engine = bound.mock.calls[0][0];
    try {
      const turn = await session.submit('close marker');
      const outcome = turn.wait().catch((error: unknown) => error);
      await entered.promise;
      expect(server.requests).toHaveLength(1);
      const closing = session.close();
      void closing.catch(() => undefined);
      // Neither close proof may depend on releasing the provider's held output.
      await closed.promise;
      await expect(closing).resolves.toBeUndefined();
      expect(await outcome).toBeInstanceOf(NativeError);
      expect(execute).not.toHaveBeenCalled();
      const closedEngine = engineClose.mock.contexts.indexOf(engine);
      expect(closedEngine).toBeGreaterThanOrEqual(0);
      const result = engineClose.mock.results[closedEngine];
      if (result.type !== 'return')
        throw new Error('Engine close did not return');
      await expect(result.value).resolves.toBeNull();
      await expect(
        engine._sentinel_admit('closed-probe', '{}'),
      ).rejects.toThrow('Codex engine is closed');
      await expect(session.close()).resolves.toBeUndefined();
      release.resolve();
      await completed.promise;
      // A new managed Engine must work through the same still-open provider.
      await using fresh = await agent.session();
      expect(fresh.id).not.toBe(session.id);
      expect(bound.mock.calls).toHaveLength(2);
      expect(bound.mock.calls[1][0]).not.toBe(engine);
      expect(
        (await (await fresh.submit('fresh independent marker')).wait())
          .finalOutput,
      ).toBe('fresh answer');
      expect(server.requests).toHaveLength(2);
      expect(JSON.stringify(server.requests[1].input)).toContain(
        'fresh independent marker',
      );
      expect(JSON.stringify(server.requests[1].input)).not.toContain(
        'close marker',
      );
      expect(execute).not.toHaveBeenCalled();
      expectDirect(counts);
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  },
  30_000,
);

it('uses direct HTTP after a native WebSocket upgrade is rejected', async () => {
  const counts = await carrierCounters();
  const server = new ModelServer([[message('HTTP fallback answer')]]);
  let upgrades = 0;
  endpoint(server).on('upgrade', (_request, socket) => {
    upgrades++;
    // 426 explicitly selects Core's HTTP fallback, without retry advice/auth.
    socket.end(
      'HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
    );
  });
  await using provider = await providerFor(server, true);
  await using session = await new Agent({
    instructions: 'Answer directly.',
    provider,
  }).session();
  const turn = await session.submit('WebSocket fallback marker');
  expect((await turn.wait()).finalOutput).toBe('HTTP fallback answer');
  expect(upgrades).toBeGreaterThan(0);
  expect(server.requests).toHaveLength(1);
  expect(JSON.stringify(server.requests[0].input)).toContain(
    'WebSocket fallback marker',
  );
  expect(server.requestHeaders[0].authorization).toBe(
    'Bearer synthetic-direct-transport-key',
  );
  const events = [];
  for await (const event of turn.events()) events.push(event);
  expect(
    events.filter((event) => event.type === 'model_request_dispatching'),
  ).toContainEqual(expect.objectContaining({ transport: 'http_sse' }));
  expectDirect(counts);
  server.assertExhausted();
}, 30_000);
