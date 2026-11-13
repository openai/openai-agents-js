import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, manualTool } from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

const sourceSchema = z.object({ source_only: z.string() });
const targetSchema = z.object({ target_only: z.number() });
type Output =
  z.infer<typeof sourceSchema> | z.infer<typeof targetSchema> | string;

function wireSchema(request: JsonObject): unknown {
  const text = request.text as JsonObject | undefined;
  return (text?.format as JsonObject | undefined)?.schema;
}

function instructions(request: JsonObject): string {
  return JSON.stringify(
    (request.input as JsonObject[]).filter((item) => item.role === 'developer'),
  );
}

it.each([
  ['native', 'native'],
  ['native', 'plain'],
  ['plain', 'native'],
  ['native', 'prompted'],
  ['prompted', 'native'],
  ['prompted', 'prompted'],
] as const)(
  'selects %s → %s output across a native handoff and restore',
  async (from, to) => {
    const targetText = to === 'plain' ? 'done' : '{"target_only":7}';
    const server = new ModelServer([
      [call('transfer_to_destination', {}, { callId: 'route-output' })],
      [message(targetText)],
      [message(targetText)],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-profile-output',
      supportsWebsockets: false,
    });
    const destination = new Agent<undefined, Output>({
      name: 'destination',
      instructions: 'Destination instructions.',
      outputType:
        to === 'plain'
          ? undefined
          : {
              mode: to,
              schema: targetSchema,
              ...(to === 'prompted' ? { maxRetries: 0 } : {}),
            },
    });
    const agent = new Agent<undefined, Output>({
      instructions: 'Source instructions.',
      provider,
      model: 'gpt-5.5',
      outputType:
        from === 'plain'
          ? undefined
          : {
              mode: from,
              schema: sourceSchema,
              ...(from === 'prompted' ? { maxRetries: 0 } : {}),
            },
      handoffs: [destination],
    });
    const expected = to === 'plain' ? 'done' : { target_only: 7 };
    let state;
    {
      await using session = await agent.session();
      expect(
        (await (await session.submit('Route this.')).wait()).finalOutput,
      ).toEqual(expected);
      expect(await session.getActiveAgent()).toBe(destination);
      state = await session.saveState();
    }
    await using restored = await agent.session({ state });
    expect(await restored.getActiveAgent()).toBe(destination);
    expect(
      (await (await restored.submit('Continue.')).wait()).finalOutput,
    ).toEqual(expected);
    const [first, after, reopened] = server.requests;
    if (from === 'native')
      expect(wireSchema(first)).toMatchObject({
        properties: { source_only: expect.anything() },
      });
    else expect(wireSchema(first)).toBeUndefined();
    for (const request of [after, reopened]) {
      if (to === 'native')
        expect(wireSchema(request)).toMatchObject({
          properties: { target_only: expect.anything() },
        });
      else expect(wireSchema(request)).toBeUndefined();
      if (to === 'prompted')
        expect(instructions(request)).toContain('target_only');
      expect(JSON.stringify(request.input)).not.toContain('source_only');
    }
    if (from === 'prompted')
      expect(instructions(first)).toContain('source_only');
    server.assertExhausted();
  },
);

it.each(['native', 'prompted'] as const)(
  'restores a manual turn with its destination %s output contract',
  async (mode) => {
    const server = new ModelServer([
      [call('transfer_to_destination', {}, { callId: 'route-output' })],
      [call('confirm', {}, { callId: 'confirm-output' })],
      [message('{"target_only":8}')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-profile-output',
      supportsWebsockets: false,
    });
    const confirm = manualTool({
      name: 'confirm',
      description: 'Confirm the selection.',
      parameters: z.object({}),
      result: z.string(),
    });
    const destination = new Agent<undefined, Output>({
      name: 'destination',
      instructions: 'Destination instructions.',
      outputType: {
        mode,
        schema: targetSchema,
        ...(mode === 'prompted' ? { maxRetries: 0 } : {}),
      },
      tools: [confirm],
    });
    const agent = new Agent<undefined, Output>({
      instructions: 'Source instructions.',
      provider,
      model: 'gpt-5.5',
      handoffs: [destination],
    });
    let state;
    {
      await using session = await agent.session();
      const turn = await session.submit('Route this.');
      await turn.wait({ until: 'manual_tool' });
      state = await session.suspend();
    }
    const result = await agent.run(null, {
      state,
      onInteraction(event) {
        const request = confirm.match(event);
        if (!request) throw new Error('Expected confirmation');
        return request.reply('approved once');
      },
    });
    expect(result.finalOutput).toEqual({ target_only: 8 });
    expect(server.requests).toHaveLength(3);
    for (const request of server.requests.slice(1)) {
      if (mode === 'native')
        expect(wireSchema(request)).toMatchObject({
          properties: { target_only: expect.anything() },
        });
      else {
        expect(wireSchema(request)).toBeUndefined();
        expect(instructions(request)).toContain('target_only');
      }
    }
    const last = server.requests[2].input as JsonObject[];
    expect(
      last.filter(
        (item) =>
          item.type === 'function_call_output' &&
          item.call_id === 'confirm-output',
      ),
    ).toHaveLength(1);
    server.assertExhausted();
  },
);

it('keeps an explicit per-turn schema over the destination profile', async () => {
  const server = new ModelServer([
    [call('transfer_to_destination', {}, { callId: 'route-output' })],
    [message('{"explicit_override":"done"}')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-profile-output',
    supportsWebsockets: false,
  });
  const destination = new Agent<undefined, Output>({
    name: 'destination',
    instructions: 'Destination instructions.',
    outputType: { mode: 'prompted', schema: targetSchema, maxRetries: 0 },
  });
  const agent = new Agent<undefined, Output>({
    instructions: 'Source instructions.',
    provider,
    model: 'gpt-5.5',
    outputType: sourceSchema,
    handoffs: [destination],
  });
  await using session = await agent.session();
  const outputType = z.object({ explicit_override: z.string() });
  const result = await (
    await session.submit('Route this.', { outputType })
  ).wait();
  expect(result.finalOutput).toEqual({ explicit_override: 'done' });
  expect(await session.getActiveAgent()).toBe(destination);
  expect(server.requests).toHaveLength(2);
  for (const request of server.requests) {
    expect(wireSchema(request)).toMatchObject({
      properties: { explicit_override: expect.anything() },
    });
    expect(instructions(request)).not.toContain('target_only');
  }
  server.assertExhausted();
});

it('keeps destination output guidance across accepted steering', async () => {
  const sampling = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const marker = 'steered after transfer';
  const server = new ModelServer([
    [call('transfer_to_destination', {}, { callId: 'route-output' })],
    async () => {
      sampling.resolve();
      await release.promise;
      return [message('{"target_only":5}')];
    },
    [message('{"target_only":6}')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-profile-output',
    supportsWebsockets: false,
  });
  const destination = new Agent<undefined, Output>({
    name: 'destination',
    instructions: 'Destination instructions.',
    outputType: { mode: 'prompted', schema: targetSchema, maxRetries: 0 },
  });
  const agent = new Agent<undefined, Output>({
    instructions: 'Source instructions.',
    provider,
    model: 'gpt-5.5',
    outputType: sourceSchema,
    handoffs: [destination],
  });
  await using session = await agent.session();
  const turn = await session.submit('Route this.');
  const result = turn.wait();
  void result.catch(() => undefined);
  try {
    await Promise.race([
      sampling.promise,
      result.then(() => {
        throw new Error('Expected destination sampling');
      }),
    ]);
    await turn.steer(marker);
  } finally {
    release.resolve();
  }
  expect((await result).finalOutput).toEqual({ target_only: 6 });
  expect(server.requests).toHaveLength(3);
  expect(instructions(server.requests[2])).toContain('target_only');
  expect(wireSchema(server.requests[2])).toBeUndefined();
  expect(JSON.stringify(server.requests[2].input)).toContain(marker);
  server.assertExhausted();
});
