import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeError, NativeProvider, tool } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
const MODEL = 'gpt-5.1-codex';
const PRIVATE = 'synthetic-buffered-refusal-or-alternative';
const usage = { input_tokens: 11, output_tokens: 3, total_tokens: 14 };
function reply(output: any[], id = 'buffered-1') {
  return {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-request-id': `upstream-${id}`,
    },
    body: JSON.stringify({
      id,
      object: 'response',
      status: 'completed',
      model: MODEL,
      output,
      usage,
    }),
  };
}
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as any).base_url,
    apiKey: 'synthetic-buffered-key',
    responseMode: 'buffered',
    supportsWebsockets: false,
  });
}
afterEach(async () => {
  await ModelServer.closeAll();
});

it('sends complete JSON controls, retains real probability/identity facts and never puts them into later model input', async () => {
  const item = message('a');
  (item.content as any[])[0].logprobs = [
    {
      token: 'a',
      bytes: [97],
      logprob: -1,
      top_logprobs: [{ token: PRIVATE, bytes: [], logprob: -2 }],
    },
  ];
  const server = new ModelServer([
    reply([item]),
    reply([message('again')], 'buffered-2'),
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    model: MODEL,
    instructions: 'Answer.',
    provider,
    modelSettings: {
      topLogprobs: 0,
      maxOutputTokens: 23,
      metadata: { run: 'captured' },
      promptCacheRetention: '24h',
      promptCacheTtl: '12h',
    },
  }).session();
  const turn = await session.submit('one');
  expect((await turn.wait()).finalOutput).toBe('a');
  const ordinary = [];
  for await (const event of turn.events()) ordinary.push(event);
  expect(JSON.stringify(ordinary)).not.toContain(PRIVATE);
  const detailed = [];
  for await (const event of turn.events({ includeExecutionDetails: true }))
    detailed.push(event);
  expect(JSON.stringify(detailed)).toContain(PRIVATE);
  const turns = [];
  for await (const recorded of session.turns()) turns.push(recorded);
  expect(turns[0].responses![0]).toMatchObject({
    responseId: 'buffered-1',
    upstreamRequestId: 'upstream-buffered-1',
  });
  const facts = turns[0].responseFacts!;
  expect(
    facts.some(
      (record) =>
        record.fact.kind === 'text_probabilities' && record.fact.snapshot,
    ),
  ).toBe(true);
  expect(JSON.stringify(facts)).toContain(PRIVATE);
  await (await session.submit('two')).wait();
  expect(server.requests).toHaveLength(2);
  for (const request of server.requests) {
    expect(request.stream).toBe(false);
    expect(request).not.toHaveProperty('stream_options');
    expect(request.max_output_tokens).toBe(23);
    expect(request.top_logprobs).toBe(0);
    expect(request.include).toContain('message.output_text.logprobs');
    expect(request.prompt_cache_options).toEqual({ ttl: '12h' });
  }
  expect(JSON.stringify(server.requests[1])).not.toContain(PRIVATE);
});

it('retains buffered refusal facts before an error and never admits a later tool', async () => {
  const refusal = {
    type: 'message',
    id: 'refusal',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'refusal', refusal: PRIVATE }],
  };
  const effects: string[] = [];
  const server = new ModelServer([
    reply([refusal, call('work', {}, { callId: 'must-not-enter' })]),
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    model: MODEL,
    instructions: 'Answer.',
    provider,
    tools: [
      tool({
        name: 'work',
        parameters: z.object({}),
        execute: () => {
          effects.push('bad');
          return 'bad';
        },
      }),
    ],
  }).session();
  const turn = await session.submit('one');
  await expect(turn.wait()).rejects.toMatchObject({ code: 'provider_refusal' });
  expect(effects).toEqual([]);
  const turns = [];
  for await (const recorded of session.turns()) turns.push(recorded);
  expect(JSON.stringify(turns[0].responseFacts)).toContain(PRIVATE);
  expect(server.requests).toHaveLength(1);
});

it('expires while a real JSON body is held after HTTP headers and starts no next request', async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const server = new ModelServer(
    [reply([message('late')])],
    [],
    undefined,
    undefined,
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  await using provider = await providerFor(server);
  await using session = await new Agent({
    model: MODEL,
    instructions: 'Answer.',
    provider,
    modelSettings: { invocationTimeoutMs: 1_000 },
  }).session();
  const result = (await session.submit('one')).wait();
  // Attach the rejection observer immediately while waiting for the body phase.
  const observed = result.catch((error: unknown) => error);
  try {
    await entered.promise;
    const error = await observed;
    expect(error).toBeInstanceOf(NativeError);
    expect(error).toMatchObject({
      code: 'model_invocation_deadline_exceeded',
      retryable: false,
    });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].stream).toBe(false);
  } finally {
    release.resolve();
  }
});

it('uses the existing tool result and next JSON request without another tool loop', async () => {
  const effects: string[] = [];
  const server = new ModelServer([
    reply([call('work', {}, { callId: 'real-work' })]),
    reply([message('finished')], 'buffered-2'),
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    model: MODEL,
    instructions: 'Use work.',
    provider,
    tools: [
      tool({
        name: 'work',
        parameters: z.object({}),
        execute: () => {
          effects.push('one');
          return 'real receipt';
        },
      }),
    ],
  }).session();
  expect((await (await session.submit('one')).wait()).finalOutput).toBe(
    'finished',
  );
  expect(effects).toEqual(['one']);
  expect(server.requests).toHaveLength(2);
  expect(JSON.stringify(server.requests[1].input)).toContain('real receipt');
});

it('rejects explicit WebSockets with buffered mode before opening', () => {
  expect(
    () =>
      new NativeProvider({
        responseMode: 'buffered',
        supportsWebsockets: true,
      }),
  ).toThrow(/HTTP/);
});

it.each(['content-length', 'chunked', 'error-body'] as const)(
  'enforces the buffered response byte limit through the real direct route (%s)',
  async (mode) => {
    const response = reply([message('x'.repeat(64 * 1024 * 1024))]);
    if (mode === 'chunked') {
      Object.assign(response.headers, { 'transfer-encoding': 'chunked' });
    } else {
      Object.assign(response.headers, {
        'content-length': String(Buffer.byteLength(response.body)),
      });
    }
    if (mode === 'error-body') response.status = 429;
    const server = new ModelServer([response]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      model: MODEL,
      instructions: 'Answer.',
      provider,
    }).session();
    await expect((await session.submit('one')).wait()).rejects.toThrow(
      /response body exceeds.*byte limit/i,
    );
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].stream).toBe(false);
  },
);
