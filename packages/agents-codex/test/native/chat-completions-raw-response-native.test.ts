import { expect, it } from 'vitest';
import { Agent, ChatCompletionsModel, NativeProvider } from '../../src';

const marker = 'SYNTHETIC_CHAT_RESPONSE_EXTENSION_a8fd31';

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
