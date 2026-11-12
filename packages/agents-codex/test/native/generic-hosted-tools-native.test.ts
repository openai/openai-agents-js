import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  hostedTool,
  isFunctionApprovalRequest,
  tool,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

const synthesizedCollisions: [JsonObject, string][] = [
  [{ type: 'exec' }, 'Duplicate selected tool functions.exec'],
  [{ type: 'wait' }, 'Duplicate selected tool functions.wait'],
  [
    { type: 'future_hosted', name: 'exec' },
    'Provider-only declaration conflicts with a native callable',
  ],
  [
    { type: 'future_hosted', name: 'wait' },
    'Provider-only declaration conflicts with a native callable',
  ],
  [
    { type: 'future_hosted', name: 'tool_search' },
    'Provider-only declaration conflicts with a native callable',
  ],
];

it.each(synthesizedCollisions)(
  'rejects a synthesized callable collision before dispatch: %j',
  async (definition, diagnostic) => {
    const server = new ModelServer([[message('provider completed')]]);
    await using provider = await providerFor(server);
    let effects = 0;
    await expect(
      new Agent({
        provider,
        model: 'gpt-5.5',
        instructions: 'Answer.',
        programmaticToolCalling: true,
        tools: [
          hostedTool(definition),
          tool({
            name: 'deferred_lookup',
            parameters: z.object({}),
            deferLoading: true,
            execute: () => {
              effects++;
              return 'unused';
            },
          }),
        ],
      }).run('begin'),
    ).rejects.toThrow(diagnostic);
    expect(server.requests).toHaveLength(0);
    expect(effects).toBe(0);
  },
);

it('keeps noncolliding opaque tools beside synthesized callable identities', async () => {
  const server = new ModelServer([[message('provider completed')]]);
  await using provider = await providerFor(server);
  let effects = 0;
  const result = await new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Answer.',
    programmaticToolCalling: true,
    tools: [
      hostedTool({ type: 'future_hosted', name: 'provider_action' }),
      tool({
        name: 'deferred_lookup',
        parameters: z.object({}),
        deferLoading: true,
        execute: () => {
          effects++;
          return 'unused';
        },
      }),
    ],
  }).run('begin');
  expect(result.finalOutput).toBe('provider completed');
  const names = (server.requests[0].tools as JsonObject[]).flatMap((spec) =>
    spec.type === 'namespace'
      ? (spec.tools as JsonObject[]).map((tool) => tool.name)
      : [spec.name ?? spec.type],
  );
  expect(names).toEqual(
    expect.arrayContaining(['exec', 'wait', 'tool_search', 'provider_action']),
  );
  expect(effects).toBe(0);
  server.assertExhausted();
});

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-generic-hosted',
    supportsWebsockets: false,
  });
}

it('preserves the captured opaque provider declaration on the native request', async () => {
  const definition: JsonObject = {
    type: 'future_hosted',
    name: 'vendor_action',
    kind: 'opaque-provider-field',
    future: { values: [null, true, { format: 'vendor-format' }] },
  };
  const expected = structuredClone(definition);
  const declaration = hostedTool(definition);
  (definition.future as JsonObject).values = ['changed-after-capture'];
  definition.extra = 'changed-after-capture';
  const server = new ModelServer([[message('provider completed')]]);
  await using provider = await providerFor(server);
  const result = await new Agent({
    provider,
    model: 'fixture-hosted-responses',
    instructions: 'Use the provider-owned tool.',
    tools: [declaration],
  }).run('begin');
  expect(result.finalOutput).toBe('provider completed');
  expect(server.requests).toHaveLength(1);
  expect(
    (server.requests[0].tools as JsonObject[]).find(
      (item) => item.type === 'future_hosted',
    ),
  ).toEqual(expected);
  expect(server.requests[0].tools).not.toContainEqual(
    expect.objectContaining({ type: 'provider_only' }),
  );
  server.assertExhausted();
});

it.each([false, true])(
  'preserves native function approval with provider declaration=%s',
  async (withHosted) => {
    const effects: string[] = [];
    const ordinary = tool({
      name: 'ordinary',
      parameters: z.object({}),
      needsApproval: true,
      execute: () => {
        effects.push('accepted');
        return 'accepted';
      },
    });
    const server = new ModelServer([
      [call('ordinary', {}, { callId: 'ordinary-call' })],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      model: 'gpt-5',
      instructions: 'Use the ordinary tool.',
      tools: [
        ordinary,
        ...(withHosted ? [hostedTool({ type: 'future_hosted' })] : []),
      ],
    }).session();
    const turn = await session.submit('begin');
    let approved = false;
    for await (const event of session.interactions()) {
      if (!isFunctionApprovalRequest(event)) continue;
      expect(event.callId).toBe('ordinary-call');
      expect(event.turnId).toBe(turn.turnId);
      expect(effects).toEqual([]);
      expect(server.requests).toHaveLength(1);
      await session.respond(event.approve());
      approved = true;
      break;
    }
    expect(approved).toBe(true);
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(effects).toEqual(['accepted']);
    server.assertExhausted();
  },
);

it.each([false, true])(
  'keeps accepted-request retry ownership with provider declaration=%s',
  async (withHosted) => {
    const server = new ModelServer([
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: 'data: {"type":"response.created","response":{"id":"accepted"}}\n\n',
      },
      [message('replayed')],
    ]);
    await using provider = await providerFor(server);
    const run = new Agent({
      provider,
      model: 'gpt-5',
      instructions: 'Answer.',
      tools: withHosted ? [hostedTool({ type: 'future_hosted' })] : [],
      modelSettings: {
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: () => ({
            retry: true,
            delayMs: 0,
            approveUnsafeReplay: true,
          }),
        },
      },
    }).run('begin');
    if (withHosted) {
      await expect(run).rejects.toThrow();
      expect(server.requests).toHaveLength(1);
    } else {
      expect((await run).finalOutput).toBe('replayed');
      expect(server.requests).toHaveLength(2);
      server.assertExhausted();
    }
  },
);
