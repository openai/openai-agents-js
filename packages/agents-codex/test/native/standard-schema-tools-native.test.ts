import type { StandardSchemaWithJSON } from '@openai/agents-core';
import { afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import { Agent, NativeProvider, tool } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

type Input = { value?: string | null };
type Output = { value: string; length: number };

function schema() {
  const validate = vi.fn((input: unknown) => {
    const value = (input as Input)?.value ?? 'default';
    if (value === 'blocked')
      return { issues: [{ message: 'Rejected tool value' }] };
    return { value: { value, length: value.length } };
  });
  const parameters: StandardSchemaWithJSON<Input, Output> = {
    '~standard': {
      version: 1,
      vendor: 'native-standard-schema-fixture',
      types: undefined as unknown as { input: Input; output: Output },
      jsonSchema: {
        input: () => ({
          type: 'object',
          properties: { value: { type: 'string' } },
          additionalProperties: false,
        }),
        output: () => ({
          type: 'object',
          properties: { value: { type: 'string' }, length: { type: 'number' } },
          required: ['value', 'length'],
          additionalProperties: false,
        }),
      },
      validate,
    },
  };
  return { parameters, validate };
}

async function provider(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-standard-schema-tool',
    supportsWebsockets: false,
  });
}

it.each(['plain', 'managed'] as const)(
  'validates and transforms external schema input before native tool policy and execution (%s)',
  async (entrypoint) => {
    const { parameters, validate } = schema();
    const server = new ModelServer([
      [call('external', { value: null }, { callId: 'external-call' })],
      [message('parent done')],
    ]);
    await using selected = await provider(server);
    const before = vi.fn(() => ({ action: 'allow' as const }));
    const effects: Output[] = [];
    const agent = new Agent({
      instructions: 'Use external.',
      model: 'gpt-5',
      provider: selected,
      tools: [
        tool({
          name: 'external',
          strict: true,
          parameters,
          before,
          execute(input) {
            expectTypeOf(input).toEqualTypeOf<Output>();
            effects.push(input);
            return input.length;
          },
        }),
      ],
    });
    const result =
      entrypoint === 'plain'
        ? await agent.run('begin')
        : await (async () => {
            await using session = await agent.session();
            return await (await session.submit('begin')).wait();
          })();
    expect(result.finalOutput).toBe('parent done');
    expect(effects).toEqual([{ value: 'default', length: 7 }]);
    expect(validate).toHaveBeenCalledExactlyOnceWith({});
    expect(before).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        originalArguments: { value: null },
        effectiveArguments: { value: 'default', length: 7 },
      }),
    );
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0].tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function',
          name: 'external',
          strict: true,
          parameters: {
            type: 'object',
            properties: {
              value: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            },
            required: ['value'],
            additionalProperties: false,
          },
        }),
      ]),
    );
    expect(server.requests[1].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'external-call',
          output: '7',
        }),
      ]),
    );
    server.assertExhausted();
  },
);

it.each(['plain', 'managed'] as const)(
  'rejects external validation before native tool policy and execution (%s)',
  async (entrypoint) => {
    const { parameters, validate } = schema();
    const server = new ModelServer([
      [call('external', { value: 'blocked' }, { callId: 'rejected-call' })],
    ]);
    await using selected = await provider(server);
    const before = vi.fn(() => ({ action: 'allow' as const }));
    const execute = vi.fn(() => 'unreachable');
    const agent = new Agent({
      instructions: 'Use external.',
      model: 'gpt-5',
      provider: selected,
      tools: [
        tool({ name: 'external', strict: true, parameters, before, execute }),
      ],
    });
    if (entrypoint === 'plain') {
      await expect(agent.run('begin')).rejects.toThrow('Rejected tool value');
    } else {
      await using session = await agent.session();
      await expect((await session.submit('begin')).wait()).rejects.toThrow(
        'Rejected tool value',
      );
    }
    expect(validate).toHaveBeenCalledExactlyOnceWith({ value: 'blocked' });
    expect(before).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(1);
    server.assertExhausted();
  },
);

it('keeps the existing requirement for strict Standard Schema conversion', () => {
  const { parameters } = schema();
  expect(() =>
    tool({ name: 'external', parameters, execute: () => 'unreachable' }),
  ).toThrow('Strict mode is required for Standard Schema parameters');
});

it('rejects asynchronous Standard Schema validation before native callback execution', async () => {
  const { parameters } = schema();
  const asynchronous: StandardSchemaWithJSON<Input, Output> = {
    '~standard': {
      ...parameters['~standard'],
      validate: async () => ({ value: { value: 'async', length: 5 } }),
    },
  };
  const server = new ModelServer([
    [call('async_external', { value: 'async' }, { callId: 'async-call' })],
  ]);
  await using selected = await provider(server);
  const execute = vi.fn(() => 'unreachable');
  const agent = new Agent({
    instructions: 'Use async_external.',
    model: 'gpt-5',
    provider: selected,
    tools: [
      tool({
        name: 'async_external',
        strict: true,
        parameters: asynchronous,
        execute,
      }),
    ],
  });
  await expect(agent.run('begin')).rejects.toThrow(
    'Async Standard Schema validation is not supported',
  );
  expect(execute).not.toHaveBeenCalled();
  expect(server.requests).toHaveLength(1);
  server.assertExhausted();
});
