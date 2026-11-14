import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  parseSessionState,
  type SessionState,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());
const format = (request: Record<string, unknown>) =>
  (request.text as { format: { strict: boolean; schema: unknown } }).format;

it.each([
  [true, false],
  [false, true],
  [true, true],
  [false, false],
])(
  'selects destination strictness from sourceStrict=%s with sharedSchema=%s',
  async (sourceStrict, sharedSchema) => {
    const shared = z.strictObject({ value: z.string() });
    const sourceSchema = sharedSchema
      ? shared
      : z.strictObject({ source: z.boolean() });
    const targetSchema = sharedSchema
      ? shared
      : z.strictObject({ target: z.string() });
    const expected = sharedSchema
      ? { value: 'complete' }
      : { target: 'complete' };
    const server = new ModelServer([
      [call('transfer_to_b', {}, { callId: 'strict-route' })],
      [message(JSON.stringify(expected))],
      [message(JSON.stringify(expected))],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-output-strictness',
      supportsWebsockets: false,
    });
    const destination = new Agent<undefined, unknown>({
      name: 'B',
      instructions: 'Complete.',
      outputType: {
        mode: 'native',
        schema: targetSchema,
        strict: !sourceStrict,
      },
    });
    const source = new Agent<undefined, unknown>({
      model: 'gpt-5.5',
      provider,
      instructions: 'Transfer.',
      outputType: {
        mode: 'native',
        schema: sourceSchema,
        strict: sourceStrict,
      },
      handoffs: [destination],
    });
    let state: SessionState;
    {
      await using session = await source.session();
      expect(
        (await (await session.submit('Route.')).wait()).finalOutput,
      ).toEqual(expected);
      state = await session.saveState();
    }
    await using restored = await source.session({ state });
    expect(
      (await (await restored.submit('Continue.')).wait()).finalOutput,
    ).toEqual(expected);
    expect(format(server.requests[0]).strict).toBe(sourceStrict);
    expect(format(server.requests[1]).strict).toBe(!sourceStrict);
    expect(format(server.requests[2]).strict).toBe(!sourceStrict);
    expect(format(server.requests[1]).schema).toMatchObject({
      properties: sharedSchema
        ? { value: { type: 'string' } }
        : { target: { type: 'string' } },
    });
    if (sharedSchema)
      expect(format(server.requests[0]).schema).toEqual(
        format(server.requests[1]).schema,
      );
    server.assertExhausted();
  },
  30_000,
);

it.each([false, true])(
  'preserves explicit turn output strict=%s over profile defaults',
  async (strict) => {
    const server = new ModelServer([
      [call('transfer_to_b', {}, { callId: 'override-route' })],
      [message('{"override":"complete"}')],
      [message('{"target":"next"}')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-output-override',
      supportsWebsockets: false,
    });
    const destination = new Agent<undefined, unknown>({
      name: 'B',
      instructions: 'Complete.',
      outputType: {
        mode: 'native',
        schema: z.strictObject({ target: z.string() }),
        strict: !strict,
      },
    });
    const source = new Agent<undefined, unknown>({
      model: 'gpt-5.5',
      provider,
      instructions: 'Transfer.',
      outputType: z.strictObject({ source: z.boolean() }),
      handoffs: [destination],
    });
    await using session = await source.session();
    const result = await (
      await session.submit('Route.', {
        outputType: {
          mode: 'native',
          schema: z.strictObject({ override: z.string() }),
          strict,
        },
      })
    ).wait();
    expect(result.finalOutput).toEqual({ override: 'complete' });
    expect(format(server.requests[0]).strict).toBe(strict);
    expect(format(server.requests[1]).strict).toBe(strict);
    expect((await (await session.submit('Next.')).wait()).finalOutput).toEqual({
      target: 'next',
    });
    expect(format(server.requests[2]).strict).toBe(!strict);
    expect(format(server.requests[2]).schema).toMatchObject({
      properties: { target: { type: 'string' } },
    });
    server.assertExhausted();
  },
  30_000,
);

it('rebinds non-strict root output for checkpoints that omitted profile strictness', async () => {
  const server = new ModelServer([
    [message('{"value":"initial"}')],
    [message('{"value":"restored"}')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-output-strictness',
    supportsWebsockets: false,
  });
  const schema = z.strictObject({ value: z.string() });
  const destination = new Agent({
    name: 'B',
    instructions: 'Complete.',
    outputType: { mode: 'native', schema },
  });
  const source = new Agent({
    model: 'gpt-5.5',
    provider,
    instructions: 'Start.',
    outputType: { mode: 'native', schema, strict: false },
    handoffs: [destination],
  });
  let state: SessionState;
  {
    await using session = await source.session();
    expect((await (await session.submit('Start.')).wait()).finalOutput).toEqual(
      {
        value: 'initial',
      },
    );
    state = await session.saveState();
  }
  // Older root profile receipts carried model settings without this field.
  const legacyWire = JSON.stringify(state, (key, value: unknown) =>
    key === 'output_schema_strict' ? undefined : value,
  );
  const legacyState = parseSessionState(legacyWire, {
    expectedSha256: createHash('sha256').update(legacyWire).digest('hex'),
  });
  await using restored = await source.session({ state: legacyState });
  expect(
    (await (await restored.submit('Continue.')).wait()).finalOutput,
  ).toEqual({
    value: 'restored',
  });
  expect(format(server.requests[1]).strict).toBe(false);
  server.assertExhausted();
});
