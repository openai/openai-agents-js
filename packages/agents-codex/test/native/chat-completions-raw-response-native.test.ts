import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  ChatCompletionsModel,
  NativeProvider,
  RunDiagnosticError,
  tool,
} from '../../src';

const marker = 'SYNTHETIC_CHAT_RESPONSE_EXTENSION_a8fd31';

function chatReply(toolCall = false) {
  return {
    id: 'chat_failure_fixture',
    object: 'chat.completion',
    created: 1,
    model: 'fixture',
    choices: [
      {
        index: 0,
        finish_reason: toolCall ? 'tool_calls' : 'stop',
        message: toolCall
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_fail',
                  type: 'function',
                  function: { name: 'fail', arguments: '{}' },
                },
              ],
            }
          : { role: 'assistant', content: 'done' },
      },
    ],
    provider_extension: { nested: [marker] },
  };
}

it.each([false, true])(
  'retains detached Chat provider JSON only with the native opt-in=%s',
  async (enabled) => {
    const requests: any[] = [];
    const responses: any[] = [];
    const client = {
      chat: {
        completions: {
          async create(body: unknown) {
            requests.push(structuredClone(body));
            const response = {
              id: `chat_completion_${requests.length}`,
              object: 'chat.completion',
              created: 1,
              model: 'fixture',
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: 'done' },
                },
              ],
              provider_extension: { nested: [marker] },
            };
            responses.push(response);
            return response;
          },
        },
      },
    };
    await using provider = new NativeProvider({
      baseUrl: 'https://example.invalid/v1',
      modelBackend: new ChatCompletionsModel(client),
    });
    await using session = await new Agent({
      instructions: 'Reply briefly.',
      model: 'fixture',
      provider,
    }).session({
      includeRawProviderEvents: enabled,
      observationRetention: 'all',
    });
    const first = await session.submit('First.');
    expect((await first.wait()).finalOutput).toBe('done');
    const original = structuredClone(responses[0]);
    responses[0].provider_extension.nested[0] = 'changed after completion';
    const frames = (
      await Array.fromAsync(first.events({ includeExecutionDetails: true }))
    ).filter((event) => event.type === 'raw_provider_event');
    expect(frames.map((event) => event.payload)).toEqual(
      enabled ? [original] : [],
    );
    expect(
      frames.every(
        (event) =>
          event.source === 'chat_completions' &&
          event.transport === 'json' &&
          event.turnId === first.turnId &&
          event.submissionId === first.submissionId,
      ),
    ).toBe(true);
    expect(
      (await Array.fromAsync(first.events())).filter(
        (event) => event.type === 'raw_provider_event',
      ),
    ).toEqual([]);
    const second = await session.submit('Second.');
    expect((await second.wait()).finalOutput).toBe('done');
    expect(JSON.stringify(requests[1].messages)).not.toContain(marker);
    const later = (
      await Array.fromAsync(second.events({ includeExecutionDetails: true }))
    ).filter((event) => event.type === 'raw_provider_event');
    expect(later.map((event) => event.payload.id)).toEqual(
      enabled ? ['chat_completion_2'] : [],
    );
  },
  20_000,
);

it('retains accepted Chat JSON in opted-in failure details', async () => {
  const cause = new Error('synthetic tool failure');
  const response = chatReply(true);
  const fail = tool({
    name: 'fail',
    description: 'Fail.',
    parameters: z.object({}),
    errorFunction: null,
    execute: () => {
      throw cause;
    },
  });
  await using provider = new NativeProvider({
    baseUrl: 'https://example.invalid/v1',
    modelBackend: new ChatCompletionsModel({
      chat: { completions: { create: async () => response } },
    }),
  });
  const caught = await new Agent({
    instructions: 'Call fail.',
    model: 'fixture',
    provider,
    tools: [fail],
  })
    .run('Fail after model output.', { captureErrorDetails: true })
    .catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(RunDiagnosticError);
  const failure = caught as RunDiagnosticError;
  expect(failure.cause).toBe(cause);
  expect(failure.details.rawResponses).toEqual([response]);
  expect(JSON.stringify(failure)).not.toContain(marker);
});

it('joins cancelled Chat client work without publishing its late JSON', async () => {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await using provider = new NativeProvider({
    baseUrl: 'https://example.invalid/v1',
    modelBackend: new ChatCompletionsModel({
      chat: {
        completions: {
          async create(_body: unknown, options: { signal: AbortSignal }) {
            options.signal.addEventListener('abort', () => aborted.resolve(), {
              once: true,
            });
            entered.resolve();
            await release.promise;
            return chatReply();
          },
        },
      },
    }),
  });
  await using session = await new Agent({
    instructions: 'Reply briefly.',
    model: 'fixture',
    provider,
  }).session({ includeRawProviderEvents: true });
  const turn = await session.submit('Wait.');
  const outcome = turn.wait().catch((error: unknown) => error);
  await entered.promise;
  let closed = false;
  const closing = session.close().then(() => {
    closed = true;
  });
  await aborted.promise;
  expect(closed).toBe(false);
  release.resolve();
  await closing;
  await outcome;
  expect(
    (
      await Array.fromAsync(turn.events({ includeExecutionDetails: true }))
    ).filter((event) => event.type === 'raw_provider_event'),
  ).toEqual([]);
}, 20_000);
