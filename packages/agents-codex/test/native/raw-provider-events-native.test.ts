import { afterEach, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import {
  Agent,
  Environment,
  InteractionRequired,
  NativeAgents,
  NativeProvider,
  manualTool,
  type ObservedEvent,
  type RawProviderEvent,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

const marker = 'SYNTHETIC_RAW_PROVIDER_EXTENSION_c8e34b';
const opaque = {
  type: 'response.sdk_fixture.opaque',
  extension: { private: marker, parts: [null, false, 0] },
};
const malformed = {
  type: 'response.output_text.delta',
  item_id: 'msg-raw',
  delta: 42,
};
const other = { type: 'response.sdk_fixture.other', count: 0 };

afterEach(() => ModelServer.closeAll());

function frames(
  id: string,
  text: string,
  ...extra: JsonObject[]
): JsonObject[] {
  const item = { ...message(text), id: `msg-${id}` };
  return [
    { type: 'response.created', response: { id } },
    ...extra,
    {
      type: 'response.output_item.added',
      item: { ...item, content: [] },
      output_index: 0,
    },
    {
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    { type: 'response.output_item.done', item, output_index: 0 },
    { type: 'response.completed', response: { id, output: [item] } },
  ];
}

function sseReply(batch: readonly JsonObject[]) {
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: batch.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  };
}

async function providerFor(
  server: ModelServer,
  options: ConstructorParameters<typeof NativeProvider>[0] = {},
) {
  const config = await server.config();
  const { base_url: baseUrl } = config['model_providers.fixture'] as {
    base_url: string;
  };
  return new NativeProvider({
    baseUrl,
    apiKey: 'synthetic-raw-events',
    supportsWebsockets: false,
    ...options,
  });
}

async function collect(events: AsyncIterable<ObservedEvent>) {
  const result: ObservedEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function rawEvents(events: readonly ObservedEvent[]): RawProviderEvent[] {
  return events.filter((event) => event.type === 'raw_provider_event');
}

it('routes raw frames through the admitted child turn only', async () => {
  let rootId: string | undefined;
  let rootRequests = 0;
  let childRequests = 0;
  const respond = (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootId ??= id;
    if (id === rootId) {
      if (++rootRequests === 1)
        return [
          call(
            'spawn_agent',
            { task_name: 'child', message: 'Answer.' },
            {
              namespace: 'collaboration',
              callId: 'spawn-child',
            },
          ),
        ];
      return [message('root done')];
    }
    childRequests++;
    return sseReply(
      frames(
        `child-${childRequests}`,
        `child ${childRequests}`,
        childRequests === 1 ? opaque : other,
      ),
    );
  };
  const server = new ModelServer(Array.from({ length: 4 }, () => respond));
  const executor = await startPublicExecutor();
  try {
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Delegate.',
      model: 'gpt-5.5',
      provider,
      tools: [new NativeAgents()],
    }).session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
      includeRawProviderEvents: true,
      observationRetention: 'all',
    });
    const root = await session.submit('Delegate.');
    expect((await root.wait()).finalOutput).toBe('root done');
    const child = await vi.waitFor(async () => {
      const children = await Array.fromAsync(session.subagents());
      expect(children).toHaveLength(1);
      expect(children[0]?.turn).toBeTruthy();
      return children[0]!;
    });
    const turn = child.turn!;
    expect((await turn.wait()).finalOutput).toBe('child 1');
    const raw = rawEvents(
      await collect(turn.events({ includeExecutionDetails: true })),
    );
    expect(raw.map((event) => event.payload)).toContainEqual(opaque);
    expect(
      raw.every(
        (event) =>
          event.turnId === turn.turnId &&
          event.submissionId === turn.submissionId,
      ),
    ).toBe(true);
    expect(rawEvents(await collect(turn.events()))).toEqual([]);
    expect(
      rawEvents(
        await collect(root.events({ includeExecutionDetails: true })),
      ).map((event) => event.payload),
    ).not.toContainEqual(opaque);
    const following = await child.submit('Continue.');
    expect((await following.wait()).finalOutput).toBe('child 2');
    const next = rawEvents(
      await collect(following.events({ includeExecutionDetails: true })),
    );
    expect(next.map((event) => event.payload)).toContainEqual(other);
    expect(next.map((event) => event.payload)).not.toContainEqual(opaque);
    expect(JSON.stringify(await session.saveState())).not.toContain(marker);
    server.assertExhausted();
  } finally {
    await executor.close();
  }
}, 30_000);

it.each(['sse', 'websocket'] as const)(
  'captures original %s objects on the opted-in native turn only',
  async (transport) => {
    const replies = [
      frames('resp-1', 'hello', opaque, malformed),
      frames('resp-2', 'again', other),
      frames('resp-3', 'quiet', opaque),
    ];
    const server = new ModelServer(replies.map(sseReply));
    const sockets = new WebSocketServer({ noServer: true });
    let generated = 0;
    let warmups = 0;
    if (transport === 'websocket')
      server.onUpgrade((request, socket, head) => {
        sockets.handleUpgrade(request, socket, head, (connection) => {
          connection.on('message', (data) => {
            const request = JSON.parse(data.toString());
            const warmup = request.generate === false;
            const batch = warmup
              ? [
                  {
                    type: 'response.completed',
                    response: { id: `warmup-${++warmups}` },
                  },
                ]
              : replies[generated++];
            for (const event of batch ?? [])
              connection.send(JSON.stringify(event));
          });
        });
      });
    await using provider = await providerFor(server, {
      supportsWebsockets: transport === 'websocket',
    });
    const agent = new Agent({ instructions: 'Answer.', provider });
    try {
      {
        await using session = await agent.session({
          includeRawProviderEvents: true,
          observationRetention: 'all',
        });
        const turn = await session.submit('first');
        expect((await turn.wait()).finalOutput).toBe('hello');
        const detailed = await collect(
          turn.events({ includeExecutionDetails: true }),
        );
        const raw = rawEvents(detailed);
        expect(raw.map((event) => event.payload)).toEqual(replies[0]);
        expect(
          raw.every(
            (event) =>
              event.source === 'responses' &&
              event.transport === transport &&
              event.turnId === turn.turnId &&
              event.submissionId === turn.submissionId,
          ),
        ).toBe(true);
        const text = detailed.find(
          (event) => event.type === 'output_text_delta',
        );
        expect(text?.delta).toBe('hello');
        expect(raw[4].sequence).toBeLessThan(text!.sequence);
        expect(rawEvents(await collect(turn.events()))).toEqual([]);
        raw[1].payload.extension = null;
        expect(
          rawEvents(
            await collect(turn.events({ includeExecutionDetails: true })),
          )[1].payload,
        ).toEqual(opaque);

        const following = await session.submit('second');
        expect((await following.wait()).finalOutput).toBe('again');
        expect(
          rawEvents(
            await collect(following.events({ includeExecutionDetails: true })),
          ).map((event) => event.payload),
        ).toEqual(replies[1]);
        expect(JSON.stringify(await session.saveState())).not.toContain(marker);
        const recorded = [];
        for await (const entry of session.turns()) recorded.push(entry);
        expect(JSON.stringify(recorded)).not.toContain(marker);
      }
      await using quiet = await agent.session();
      const third = await quiet.submit('third');
      expect((await third.wait()).finalOutput).toBe('quiet');
      expect(
        rawEvents(
          await collect(third.events({ includeExecutionDetails: true })),
        ),
      ).toEqual([]);
      if (transport === 'websocket') {
        expect(warmups).toBeGreaterThan(0);
        expect(generated).toBe(3);
        expect(server.requests).toEqual([]);
      }
    } finally {
      for (const connection of sockets.clients) connection.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    }
  },
);

it.each([false, true])(
  'captures buffered Responses with model output opt-in=%s',
  async (includeModelOutputItems) => {
    const body = {
      id: 'resp-json',
      status: 'completed',
      output: [message('done')],
      provider_extension: { opaque: marker },
    };
    const server = new ModelServer([
      {
        status: 200,
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      },
    ]);
    await using provider = await providerFor(server, {
      responseMode: 'buffered',
    });
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'fixture',
      provider,
    }).session({ includeRawProviderEvents: true, includeModelOutputItems });
    const turn = await session.submit('answer');
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(server.requests[0].stream).toBe(false);
    const detailed = await collect(
      turn.events({ includeExecutionDetails: true }),
    );
    expect(rawEvents(detailed)).toEqual([
      expect.objectContaining({ transport: 'json', payload: body }),
    ]);
    const modelItems = detailed.filter(
      (event) => event.type === 'model_output_item_completed',
    );
    expect(modelItems).toHaveLength(includeModelOutputItems ? 1 : 0);
    if (includeModelOutputItems)
      expect(JSON.stringify(modelItems)).toContain('done');
    expect(JSON.stringify(await session.saveState())).not.toContain(marker);
  },
);

it('exposes the original failure object before the native turn rejects', async () => {
  const frame = {
    type: 'response.failed',
    response: {
      id: 'resp-invalid',
      status: 'failed',
      error: { code: 'invalid_prompt', message: 'synthetic invalid prompt' },
    },
    provider_extension: marker,
  };
  const server = new ModelServer([
    sseReply([
      { type: 'response.created', response: { id: 'resp-invalid' } },
      frame,
    ]),
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
  }).session({ includeRawProviderEvents: true });
  const turn = await session.submit('invalid');
  await expect(turn.wait()).rejects.toThrow('synthetic invalid prompt');
  const raw = rawEvents(
    await collect(turn.events({ includeExecutionDetails: true })),
  );
  expect(raw.at(-1)?.payload).toEqual(frame);
  expect(JSON.stringify(await session.saveState())).not.toContain(marker);
});

it('arms capture before a restored manual turn continues', async () => {
  const frame = {
    type: 'response.sdk_fixture.restored',
    provider_extension: marker,
  };
  const lookup = manualTool({
    name: 'lookup',
    description: 'Look up a record.',
    parameters: z.object({ key: z.string() }),
    result: z.string(),
  });
  const server = new ModelServer([
    [call('lookup', { key: 'a' }, { callId: 'call-raw' })],
    sseReply(frames('resp-restored', 'done', frame)),
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Use lookup once.',
    provider,
    tools: [lookup],
  });
  const paused = await agent.run('Look up a.').catch((error: unknown) => error);
  if (!(paused instanceof InteractionRequired) || !paused.state)
    throw new Error('Expected a native manual checkpoint', { cause: paused });

  await using session = await agent.session({
    state: paused.state,
    includeRawProviderEvents: true,
    onInteraction(request) {
      const action = lookup.match(request);
      if (!action) throw new Error('Expected a lookup action');
      return action.reply('accepted');
    },
  });
  const turn = session.restoredTurn;
  if (!turn) throw new Error('Expected the restored native turn');
  expect((await turn.wait()).finalOutput).toBe('done');
  const raw = rawEvents(
    await collect(turn.events({ includeExecutionDetails: true })),
  );
  expect(raw[1]?.payload).toEqual(frame);
  expect(raw.every((event) => event.turnId === turn.turnId)).toBe(true);
});
