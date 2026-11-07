import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

// Expected defaults come from the official model pages checked on 2026-11-04:
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
// https://developers.openai.com/api/docs/models/gpt-5.6-sol
const MODELS = ['gpt-6.1-sol', 'gpt-5.6-sol'] as const;
const USAGE = { input_tokens: 11, output_tokens: 3, total_tokens: 14 };

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-model-defaults-key',
  });
}

afterEach(() => ModelServer.closeAll());

it.each(MODELS)('uses documented omitted reasoning for %s', async (model) => {
  const server = new ModelServer([[message('finished')]], USAGE);
  await using provider = await providerFor(server);
  const result = await new Agent({
    model,
    instructions: 'Answer.',
    provider,
  }).run('one');
  expect(result.finalOutput).toBe('finished');
  expect(result.threadUsage?.modelContextWindow).toBe(258_400);
  expect(server.requests[0]?.model).toBe(model);
  expect(server.requests[0]?.reasoning).toMatchObject({ effort: 'medium' });
  server.assertExhausted();
});

it.each(MODELS)(
  'preserves explicit reasoning when %s changes',
  async (model) => {
    const other = MODELS.find((candidate) => candidate !== model)!;
    const server = new ModelServer(
      Array.from({ length: 3 }, () => [message('finished')]),
    );
    await using provider = await providerFor(server);
    const agent = new Agent({
      model,
      instructions: 'Answer.',
      provider,
      modelSettings: { reasoningEffort: 'low' },
    });
    await using session = await agent.session({
      modelSettings: { reasoningEffort: 'high' },
    });
    expect(
      (await (await session.submit('session override')).wait()).finalOutput,
    ).toBe('finished');
    await session.update({
      model: other,
      modelSettings: { reasoningEffort: 'low' },
    });
    expect(
      (await (await session.submit('update override')).wait()).finalOutput,
    ).toBe('finished');
    await session.update({ model });
    expect(
      (await (await session.submit('retain override')).wait()).finalOutput,
    ).toBe('finished');
    expect(server.requests.map((request) => request.model)).toEqual([
      model,
      other,
      model,
    ]);
    expect(server.requests.map((request) => request.reasoning)).toEqual([
      expect.objectContaining({ effort: 'high' }),
      expect.objectContaining({ effort: 'low' }),
      expect.objectContaining({ effort: 'low' }),
    ]);
    server.assertExhausted();
  },
);

it('reselects omitted reasoning after model changes', async () => {
  const unknown = 'fixture-model-without-context-metadata';
  const selections = [unknown, ...MODELS, unknown];
  const server = new ModelServer(
    selections.map(() => [message('finished')]),
    USAGE,
  );
  await using provider = await providerFor(server);
  await using session = await new Agent({
    model: selections[0],
    instructions: 'Answer.',
    provider,
  }).session();
  for (const model of selections) {
    await session.update({ model });
    const result = await (await session.submit('selected model')).wait();
    expect(result.finalOutput).toBe('finished');
    expect(result.threadUsage?.modelContextWindow).toBe(
      model === unknown ? null : 258_400,
    );
  }
  expect(server.requests.map((request) => request.model)).toEqual(selections);
  // Unknown models omit effort instead of retaining the prior known model default.
  expect(
    server.requests.map(
      (request) =>
        (request.reasoning as { effort?: string } | undefined)?.effort ?? null,
    ),
  ).toEqual([null, 'medium', 'medium', null]);
  server.assertExhausted();
});

it('aligns omitted Astra effort with observed provider behavior while retaining overrides and context', async () => {
  const efforts = [undefined, 'low', 'high'] as const;
  const server = new ModelServer(
    efforts.map(() => [message('finished')]),
    USAGE,
  );
  await using provider = await providerFor(server);
  for (const effort of efforts) {
    const result = await new Agent({
      model: 'gpt-6-astra',
      instructions: 'Answer.',
      provider,
      ...(effort === undefined
        ? {}
        : { modelSettings: { reasoningEffort: effort } }),
    }).run('one');
    expect(result.finalOutput).toBe('finished');
    expect(result.threadUsage?.modelContextWindow).toBe(258_400);
  }
  expect(server.requests.map((request) => request.reasoning)).toEqual([
    expect.objectContaining({ effort: 'medium' }),
    expect.objectContaining({ effort: 'low' }),
    expect.objectContaining({ effort: 'high' }),
  ]);
  server.assertExhausted();
});
