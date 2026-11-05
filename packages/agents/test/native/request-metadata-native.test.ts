import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  manualTool,
  type ActionRequested,
  NativeProvider,
  tool,
  type ModelRequestDispatching,
  type ModelResponseLinked,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await ModelServer.closeAll();
  for (const close of cleanups.splice(0)) await close();
});

it('matches final HTTP scalar fields and links repeated provider IDs by occurrence', async () => {
  const terminal = JSON.stringify({
    type: 'response.completed',
    response: {
      id: 'same',
      headers: {
        'x-ratelimit-remaining-requests': '7',
        authorization: 'PRIVATE_HEADER_MARKER',
      },
      usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 },
    },
  });
  const server = new ModelServer(
    [[call('probe', {}, { callId: 'probe' })], [message('done')]],
    [],
    undefined,
    [terminal, terminal],
  );
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-metadata-key',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions: 'Use probe then answer.',
    model: 'gpt-5.5',
    provider,
    modelSettings: {
      reasoningEffort: 'low',
      reasoningSummary: 'concise',
      serviceTier: 'flex',
    },
    tools: [
      tool({ name: 'probe', parameters: z.object({}), execute: () => 'ok' }),
    ],
  });
  await using session = await agent.session();
  const turn = await session.submit('PRIVATE_INPUT_MARKER');
  const result = await turn.wait();
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
  const rateUpdates = events.filter(
    (event) => event.type === 'api_rate_limits_updated',
  );
  expect(rateUpdates).toHaveLength(2);
  for (const event of rateUpdates) {
    expect(event.turnId).toBe(turn.turnId);
    expect(event.submissionId).toBe(turn.submissionId);
    expect(event.snapshot).toEqual({ requests: { remaining: 7 } });
  }
  expect(session.rateLimits()).toEqual({ requests: { remaining: 7 } });
  expect(result.usage?.totalTokenUsage.totalTokens).toBe(26);
  expect(
    events.filter(
      (event) => event.type === 'usage_updated' && event.usage === null,
    ),
  ).toEqual([]);
  expect(JSON.stringify(events)).not.toContain('PRIVATE_HEADER_MARKER');
  expect(dispatches).toHaveLength(2);
  expect(new Set(dispatches.map((event) => event.requestId)).size).toBe(2);
  for (const [index, event] of dispatches.entries()) {
    const request = server.requests[index];
    expect(event.threadId).toBe(session.id);
    expect(event.turnId).toBe(turn.turnId);
    expect(event.submissionId).toBe(turn.submissionId);
    expect(event.model).toBe(request.model);
    expect(event.reasoningEffort).toBe(
      (request.reasoning as JsonObject | undefined)?.effort ?? null,
    );
    expect(event.reasoningSummary).toBe(
      (request.reasoning as JsonObject | undefined)?.summary ?? null,
    );
    expect(event.serviceTier).toBe(request.service_tier ?? null);
    expect(event.transport).toBe('http_sse');
    expect(JSON.stringify(event)).not.toContain('PRIVATE_INPUT_MARKER');
    expect(Object.isFrozen(event)).toBe(true);
  }
  const recorded = [];
  for await (const row of session.turns()) recorded.push(row);
  expect(recorded[0].responses).toHaveLength(2);
  expect(new Set(recorded[0].responses!.map((row) => row.responseId))).toEqual(
    new Set(['same']),
  );
  expect(new Set(links.map((event) => event.responseObservationId))).toEqual(
    new Set(recorded[0].responses!.map((row) => row.id)),
  );
  expect(new Set(links.map((event) => event.requestId))).toEqual(
    new Set(dispatches.map((event) => event.requestId)),
  );
  server.assertExhausted();
}, 30_000);

for (const mode of ['websocket', 'fallback', 'failed-websocket'] as const) {
  it(`reports the selected invocation transport over ${mode}`, async () => {
    const requests: JsonObject[] = [];
    let upgrades = 0;
    const failures: unknown[] = [];
    function events(request: JsonObject): JsonObject[] {
      if (request.generate === false)
        return [
          { type: 'response.created', response: { id: 'warmup' } },
          { type: 'response.completed', response: { id: 'warmup' } },
        ];
      requests.push(request);
      if (mode === 'failed-websocket')
        return [
          {
            type: 'response.output_item.done',
            item: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'refusal', refusal: 'PRIVATE_REFUSAL' }],
            },
          },
        ];
      return [
        { type: 'response.created', response: { id: 'response' } },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: message('done'),
        },
        {
          type: 'response.completed',
          response: {
            id: 'response',
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ];
    }
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const output = events(JSON.parse(Buffer.concat(chunks).toString()));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of output)
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      } catch (error) {
        failures.push(error);
        response.writeHead(500).end();
      }
    });
    const ws = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      upgrades++;
      if (mode === 'fallback') {
        socket.end(
          'HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
        );
        return;
      }
      ws.handleUpgrade(request, socket, head, (connection) =>
        connection.on('message', (data) => {
          try {
            for (const event of events(JSON.parse(data.toString())))
              connection.send(JSON.stringify(event));
          } catch (error) {
            failures.push(error);
            connection.close();
          }
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No test peer address');
    cleanups.push(async () => {
      for (const connection of ws.clients) connection.terminate();
      await new Promise<void>((resolve) => ws.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      expect(failures).toEqual([]);
    });
    await using provider = new NativeProvider({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'synthetic-metadata-key',
      supportsWebsockets: true,
    });
    await using session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session();
    const turn = await session.submit('go');
    if (mode === 'failed-websocket')
      await expect(turn.wait()).rejects.toThrow();
    else await turn.wait();
    const observed = [];
    for await (const event of turn.events()) observed.push(event);
    const dispatches = observed.filter(
      (event): event is ModelRequestDispatching =>
        event.type === 'model_request_dispatching',
    );
    expect(dispatches).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(dispatches[0].transport).toBe(
      mode === 'fallback' ? 'http_sse' : 'websocket',
    );
    expect(dispatches[0].model).toBe(requests[0].model);
    expect(upgrades).toBeGreaterThan(0);
    if (mode === 'failed-websocket') {
      expect(
        observed.some((event) => event.type === 'model_response_linked'),
      ).toBe(false);
      expect(JSON.stringify(observed)).not.toContain('PRIVATE_REFUSAL');
    }
  }, 30_000);
}

for (const cancel of [false, true]) {
  it(`keeps a closed observation reader passive while the root ${cancel ? 'cancels' : 'completes'}`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([
      async () => {
        entered.resolve();
        await release.promise;
        return [message('done')];
      },
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-metadata-key',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session();
    const turn = await session.submit('go');
    const reader = turn.events();
    let dispatch: ModelRequestDispatching | undefined;
    for await (const event of reader) {
      if (event.type === 'model_request_dispatching') {
        dispatch = event;
        break;
      }
    }
    expect(dispatch).toBeDefined();
    await reader.return?.();
    await entered.promise;
    if (cancel) {
      await turn.cancel();
      await expect(turn.wait()).rejects.toThrow();
    }
    release.resolve();
    if (!cancel) expect((await turn.wait()).finalOutput).toBe('done');
    const events = [];
    for await (const event of turn.events()) events.push(event);
    expect(events).toContainEqual(dispatch);
    expect(server.requests).toHaveLength(1);
    if (cancel)
      expect(
        events.some((event) => event.type === 'model_response_linked'),
      ).toBe(false);
  }, 30_000);
}

it('keeps prompted correction request ownership and the existing parent submission link', async () => {
  const server = new ModelServer([
    [message('not valid JSON')],
    [message('{"answer":"done"}')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-metadata-key',
    supportsWebsockets: false,
  });
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
    outputType: {
      mode: 'prompted',
      schema: z.object({ answer: z.literal('done') }),
      maxRetries: 1,
    },
  }).session();
  const turn = await session.submit('go');
  expect((await turn.wait()).finalOutput).toEqual({ answer: 'done' });
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
  expect(dispatches).toHaveLength(2);
  expect(server.requests).toHaveLength(2);
  const [original, correction] = dispatches;
  expect(original.threadId).toBe(session.id);
  expect(original.sessionId).toBe(session.id);
  expect(original.submissionId).toBe(turn.submissionId);
  expect(correction.threadId).toBe(correction.sessionId);
  expect(correction.threadId).not.toBe(session.id);
  expect(correction.submissionId).not.toBe(turn.submissionId);
  expect(correction.parentSubmissionId).toBe(turn.submissionId);
  expect(correction.requestId).not.toBe(original.requestId);
  expect(links).toHaveLength(2);
  for (const event of links) {
    const owner = dispatches.find((row) => row.requestId === event.requestId)!;
    expect([
      event.threadId,
      event.submissionId,
      event.parentSubmissionId,
    ]).toEqual([owner.threadId, owner.submissionId, owner.parentSubmissionId]);
  }
  server.assertExhausted();
}, 30_000);

for (const restore of [false, true]) {
  it(`binds a fresh ephemeral route for ${restore ? 'restored' : 'in-memory'} manual follow-up`, async () => {
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'manual-A' })],
      [message('continued')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-metadata-key',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Use lookup.',
      provider,
      tools: [
        manualTool({
          name: 'lookup',
          description: 'Read a record.',
          parameters: z.object({}),
          result: z.string(),
        }),
      ],
    });
    const source = await agent.session();
    let owner = source;
    try {
      const original = await source.submit('read A');
      let action: ActionRequested | undefined;
      for await (const event of source.events()) {
        if (event.type === 'action_requested') {
          action = event;
          break;
        }
      }
      if (!action) throw new Error('No manual request');
      const priorIds = new Set<string | null>();
      for await (const row of source.turns())
        for (const response of row.responses ?? []) priorIds.add(response.id);
      expect(priorIds.size).toBeGreaterThan(0);
      if (restore) {
        const saved = await source.suspend();
        const encoded = JSON.stringify(saved);
        expect(encoded).not.toContain('observation_submission_id');
        expect(encoded).not.toContain(original.submissionId);
        await source.close();
        owner = await agent.session({ state: saved });
        action = undefined;
        for await (const event of owner.events()) {
          if (event.type === 'action_requested') {
            action = event;
            break;
          }
        }
        if (!action) throw new Error('No restored manual request');
      }
      expect(server.requests).toHaveLength(1);
      const resumed = await owner.submit(action.reply('record A'));
      expect((await resumed.wait()).finalOutput).toBe('continued');
      const events = [];
      for await (const event of resumed.events()) events.push(event);
      const dispatches = events.filter(
        (event): event is ModelRequestDispatching =>
          event.type === 'model_request_dispatching',
      );
      const links = events.filter(
        (event): event is ModelResponseLinked =>
          event.type === 'model_response_linked',
      );
      expect(dispatches).toHaveLength(restore ? 1 : 2);
      expect(links).toHaveLength(restore ? 1 : 2);
      expect(
        dispatches.every(
          (event) =>
            event.submissionId === resumed.submissionId &&
            event.threadId === owner.id,
        ),
      ).toBe(true);
      expect(dispatches.at(-1)?.turnId).toBe(original.turnId);
      if (restore) {
        expect(resumed.submissionId).not.toBe(original.submissionId);
        expect(
          links.every((event) => !priorIds.has(event.responseObservationId)),
        ).toBe(true);
      }
      const retainedIds = new Set<string | null>();
      for await (const row of owner.turns())
        for (const response of row.responses ?? [])
          retainedIds.add(response.id);
      expect([...priorIds].every((id) => retainedIds.has(id))).toBe(true);
      server.assertExhausted();
    } finally {
      if (owner !== source) await owner.close();
      await source.close();
    }
  }, 30_000);
}

it('does not report a client invocation after a held sampling step is closed', async () => {
  // The blocked request must never consume this response.
  const server = new ModelServer([[message('must not send')]]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-stop-metadata',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    model: 'gpt-5.5',
    instructions: 'Answer.',
    provider,
  });
  const session = await agent.session();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const turn = await session.submit('close at sampling admission', {
      async beforeStep() {
        entered.resolve();
        await release.promise;
        return undefined;
      },
    });
    const waiting = turn.wait().then(
      () => ({ completed: true }),
      () => ({ completed: false }),
    );
    await entered.promise;
    const closing = session.close();
    release.resolve();
    await closing;
    expect((await waiting).completed).toBe(false);
    const events = [];
    for await (const event of turn.events()) events.push(event);
    expect(
      events.filter((event) => event.type === 'model_request_dispatching'),
    ).toEqual([]);
    expect(
      events.filter((event) => event.type === 'model_response_linked'),
    ).toEqual([]);
    expect(server.requests).toHaveLength(0);
  } finally {
    release.resolve();
    await session.close();
  }
}, 30_000);

it('routes queued work to its issued handle and drops a canceled queued root', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let holdFirst = true;
  const server = new ModelServer(
    [[message('first')], [message('second')]],
    [],
    async () => {
      if (!holdFirst) return;
      holdFirst = false;
      entered.resolve();
      await release.promise;
    },
  );
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-queued-metadata',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    model: 'gpt-5.5',
    instructions: 'Answer.',
    provider,
  });
  const session = await agent.session();
  try {
    const first = await session.submit('first');
    await entered.promise;
    const second = await session.enqueue('second');
    const canceled = await session.enqueue('must not dispatch');
    expect(second.turnId).toBeNull();
    const canceledWait = canceled.wait().then(
      () => false,
      () => true,
    );
    await canceled.cancel();
    expect(await canceledWait).toBe(true);
    release.resolve();
    expect((await first.wait()).finalOutput).toBe('first');
    expect((await second.wait()).finalOutput).toBe('second');
    const requests: ModelRequestDispatching[] = [];
    for (const turn of [first, second, canceled]) {
      const events = [];
      for await (const event of turn.events()) events.push(event);
      const dispatches = events.filter(
        (event): event is ModelRequestDispatching =>
          event.type === 'model_request_dispatching',
      );
      expect(dispatches).toHaveLength(turn === canceled ? 0 : 1);
      for (const event of dispatches) {
        expect(event.submissionId).toBe(turn.submissionId);
        expect(event.turnId).toBe(turn.turnId);
        expect(event.threadId).toBe(session.id);
        requests.push(event);
      }
    }
    expect(new Set(requests.map((event) => event.requestId)).size).toBe(2);
    expect(first.submissionId).not.toBe(second.submissionId);
    expect(server.requests).toHaveLength(2);
    server.assertExhausted();
  } finally {
    release.resolve();
    await session.close();
  }
}, 30_000);
