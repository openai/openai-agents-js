import { z } from 'zod';
import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  isFunctionApprovalRequest,
  tool,
  type AgentToolStreamEvent,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-configured-stream',
    supportsWebsockets: false,
  });
}
function frames(count: number, complete = true) {
  const item = { ...message('x'.repeat(count)), id: 'child-stream-message' };
  const events = [
    { type: 'response.created', response: { id: 'child-stream-response' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: item.id, role: 'assistant', content: [] },
    },
    ...Array.from({ length: count }, () => ({
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: 'x',
    })),
    ...(complete
      ? [
          { type: 'response.output_item.done', output_index: 0, item },
          {
            type: 'response.completed',
            response: { id: 'child-stream-response' },
          },
        ]
      : []),
  ];
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  };
}
for (const maxPending of [undefined, null]) {
  it(`has been streaming child deltas with original Agent and call identity before parent settlement (${String(maxPending)})`, async () => {
    const parentModel = new ModelServer([
      [
        call(
          'nested',
          { input: 'read child' },
          { callId: 'parent-stream-call' },
        ),
      ],
      [message('parent complete')],
    ]);
    const childModel = new ModelServer([
      frames(maxPending === null ? 2048 : 3),
    ]);
    await using parentProvider = await providerFor(parentModel);
    await using childProvider = await providerFor(childModel);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: AgentToolStreamEvent[] = [];
    const child = new Agent({
      name: 'original-child',
      provider: childProvider,
      model: 'gpt-5.5',
      instructions: 'Answer the request.',
    });
    const nested = child.asTool({
      toolName: 'nested',
      onStreamMaxPendingEvents: maxPending,
      onStream: async (event) => {
        events.push(event);
        if (
          event.event.type === 'output_text_delta' &&
          events.filter((value) => value.event.type === 'output_text_delta')
            .length === 1
        ) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    await using session = await new Agent({
      provider: parentProvider,
      model: 'gpt-5.5',
      instructions: 'Call the child.',
      tools: [nested],
    }).session();
    const turn = await session.submit('Use the child.');
    try {
      await entered.promise;
      expect(parentModel.requests).toHaveLength(1);
      expect(
        events.every(
          (event) =>
            event.agent === child && event.callId === 'parent-stream-call',
        ),
      ).toBe(true);
      expect(events[0].toolCall?.tool.name).toBe('nested');
    } finally {
      release.resolve();
    }
    expect((await turn.wait()).finalOutput).toBe('parent complete');
    expect(
      events.filter((event) => event.event.type === 'output_text_delta'),
    ).toHaveLength(maxPending === null ? 2048 : 3);
    expect(
      events.some((event) => event.event.type === 'raw_provider_event'),
    ).toBe(false);
    parentModel.assertExhausted();
    childModel.assertExhausted();
  });
}
it('has been isolating synchronous stream handler failure from the native child result', async () => {
  const parentModel = new ModelServer([
    [call('nested', { input: 'read child' }, { callId: 'handler-error-call' })],
    [message('parent complete')],
  ]);
  const childModel = new ModelServer([[message('child complete')]]);
  await using parentProvider = await providerFor(parentModel);
  await using childProvider = await providerFor(childModel);
  let entered = 0;
  const nested = new Agent({
    provider: childProvider,
    model: 'gpt-5.5',
    instructions: 'Answer.',
  }).asTool({
    toolName: 'nested',
    onStream() {
      entered++;
      throw new Error('isolated observer failure');
    },
  });
  await using session = await new Agent({
    provider: parentProvider,
    model: 'gpt-5.5',
    instructions: 'Call child.',
    tools: [nested],
  }).session();
  expect((await (await session.submit('Read.')).wait()).finalOutput).toBe(
    'parent complete',
  );
  expect(entered).toBeGreaterThan(0);
  expect(JSON.stringify(parentModel.requests[1])).toContain('child complete');
  expect(JSON.stringify(parentModel.requests[1])).not.toContain(
    'isolated observer failure',
  );
});
it('has been stopping overflow and joining the active callback before parent tool publication', async () => {
  const parentModel = new ModelServer([
    [call('nested', { input: 'read child' }, { callId: 'overflow-call' })],
    [message('parent handled failure')],
  ]);
  const wireRelease = Promise.withResolvers<void>();
  const childModel = new ModelServer(
    [frames(64, false)],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => wireRelease.promise,
  );
  const disconnected = Promise.withResolvers<void>();
  childModel.onRecord = (phase) => {
    if (phase === 'MODEL_RESPONSE_CLOSED') disconnected.resolve();
  };
  await using parentProvider = await providerFor(parentModel);
  await using childProvider = await providerFor(childModel);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let handlers = 0;
  let settled = false;
  const nested = new Agent({
    provider: childProvider,
    model: 'gpt-5.5',
    instructions: 'Stream until stopped.',
  }).asTool({
    toolName: 'nested',
    onStreamMaxPendingEvents: 1,
    onStream: async () => {
      handlers++;
      entered.resolve();
      await release.promise;
    },
  });
  await using session = await new Agent({
    provider: parentProvider,
    model: 'gpt-5.5',
    instructions: 'Call child and report failures.',
    tools: [nested],
  }).session();
  const result = (await session.submit('Stream.')).wait().then(
    (value) => {
      settled = true;
      return { value, error: undefined };
    },
    (error) => {
      settled = true;
      return { value: undefined, error };
    },
  );
  try {
    await entered.promise;
    await disconnected.promise;
    expect(settled).toBe(false);
    expect(parentModel.requests).toHaveLength(1);
    expect(handlers).toBe(1);
  } finally {
    release.resolve();
    wireRelease.resolve();
  }
  const outcome = await result;
  expect(outcome.value).toBeUndefined();
  const errors =
    outcome.error instanceof AggregateError
      ? outcome.error.errors
      : [outcome.error];
  expect(
    errors.some(
      (error) =>
        error instanceof Error &&
        error.message.includes('onStreamMaxPendingEvents'),
    ),
  ).toBe(true);
  expect(parentModel.requests).toHaveLength(1);
  expect(handlers).toBe(1);
});
for (const limit of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
  it(`has been rejecting invalid stream backlog ${String(limit)}`, () => {
    expect(() =>
      new Agent({ instructions: 'No opening.' }).asTool({
        toolName: 'nested',
        onStreamMaxPendingEvents: limit,
      }),
    ).toThrow(/positive safe integer/);
  });
}

it('has been keeping original destination identity through handoff, suspension and restored child events', async () => {
  const parentModel = new ModelServer([
    [
      call(
        'nested',
        { input: 'handoff then approve' },
        { callId: 'restored-stream-call' },
      ),
    ],
    [message('parent restored')],
  ]);
  const childModel = new ModelServer([
    [call('transfer_to_destination', {}, { callId: 'child-handoff' })],
    [call('child_effect', {}, { callId: 'child-gate' })],
    frames(3),
  ]);
  await using parentProvider = await providerFor(parentModel);
  await using childProvider = await providerFor(childModel);
  let effects = 0;
  const destination = new Agent({
    name: 'destination',
    instructions: 'Request approval then finish.',
    tools: [
      tool({
        name: 'child_effect',
        parameters: z.object({}),
        needsApproval: true,
        execute() {
          effects++;
          return 'approved child effect';
        },
      }),
    ],
  });
  const initial = new Agent({
    name: 'initial',
    provider: childProvider,
    model: 'gpt-5.5',
    instructions: 'Transfer.',
    handoffs: [destination],
  });
  const events: AgentToolStreamEvent[] = [];
  const nested = initial.asTool({
    toolName: 'nested',
    onStream: (event) => {
      events.push(event);
    },
  });
  const root = new Agent({
    provider: parentProvider,
    model: 'gpt-5.5',
    instructions: 'Call child.',
    tools: [nested],
  });
  const source = await root.session();
  let state;
  try {
    const turn = await source.submit('Call child.');
    const attention = await turn.wait({ until: 'interaction' });
    expect('requests' in attention).toBe(true);
    state = await source.suspend();
  } finally {
    await source.close();
  }
  expect(events[0].agent).toBe(initial);
  expect(
    events.some(
      (event) =>
        event.event.type === 'agent_profile_changed' &&
        event.agent === destination,
    ),
  ).toBe(true);
  const restoredStart = events.length;
  await using restored = await root.session({ state });
  for await (const request of restored.interactions()) {
    if (!isFunctionApprovalRequest(request)) continue;
    await restored.respond(request.approve());
    break;
  }
  expect((await restored.restoredTurn!.wait()).finalOutput).toBe(
    'parent restored',
  );
  expect(effects).toBe(1);
  const resumed = events.slice(restoredStart);
  expect(resumed.length).toBeGreaterThan(0);
  expect(resumed.every((event) => event.agent === destination)).toBe(true);
  expect(
    resumed.filter((event) => event.event.type === 'output_text_delta'),
  ).toHaveLength(3);
  parentModel.assertExhausted();
  childModel.assertExhausted();
});
