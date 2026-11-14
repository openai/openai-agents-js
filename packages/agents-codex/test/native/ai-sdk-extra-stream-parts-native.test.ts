import { expect, it } from 'vitest';
import { Agent, AiSdkModel, NativeProvider } from '../../src';
import type { JsonObject } from '../../src/runtime/binding';

const source = {
  type: 'source',
  sourceType: 'url',
  id: 'source-1',
  url: 'https://example.com/reference',
  title: 'Reference',
};
const raw = {
  type: 'raw',
  rawValue: { sequence: 1, fixture: { counters: [0, false, null] } },
};
const privateChunk = {
  ...raw,
  rawValue: {
    ...raw.rawValue,
    fixture: {
      ...raw.rawValue.fixture,
      thoughtSignature: 'private-continuation',
      thought_signature: 'private-serialized-continuation',
    },
  },
};

it.each([false, true])(
  'keeps auxiliary AI SDK source and raw parts observational (capture=%s)',
  async (capture) => {
    let includeRawChunks: boolean | undefined;
    const model = new AiSdkModel(
      {
        specificationVersion: 'v3',
        provider: 'fixture.raw',
        modelId: 'fixture',
        doGenerate() {
          throw new Error('Unexpected buffered request');
        },
        doStream(options) {
          includeRawChunks = options.includeRawChunks;
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue(source);
                if (includeRawChunks) controller.enqueue(privateChunk);
                controller.enqueue({
                  type: 'text-delta',
                  id: 'answer',
                  delta: 'Done.',
                });
                controller.enqueue({ type: 'finish', finishReason: 'stop' });
                controller.close();
              },
            }),
          };
        },
      },
      {},
      { stream: true },
    );
    await using provider = new NativeProvider({ modelBackend: model });
    const agent = new Agent({
      model: 'fixture',
      instructions: 'Answer.',
      provider,
    });
    await using session = await agent.session({
      includeRawProviderEvents: capture,
      observationRetention: 'all',
    });
    const turn = await session.submit('Begin.');
    expect((await turn.wait()).finalOutput).toBe('Done.');
    const observed: JsonObject[] = [];
    for await (const event of turn.events({ includeExecutionDetails: true })) {
      if (event.type === 'raw_provider_event') {
        expect(event.source).toBe('ai_sdk');
        observed.push(event.payload);
      }
    }
    expect(includeRawChunks === true).toBe(capture);
    if (capture) expect(observed.slice(0, 2)).toEqual([source, raw]);
    else expect(observed).toEqual([]);
    const history = JSON.stringify(await session.historySnapshot());
    expect(history).not.toContain(source.url);
    expect(history).not.toContain('counters');
  },
);

it('settles a buffered AI SDK answer accompanied by an auxiliary source', async () => {
  const model = new AiSdkModel({
    specificationVersion: 'v3',
    provider: 'fixture.raw',
    modelId: 'fixture',
    doGenerate: () => ({
      content: [source, { type: 'text', text: 'Done.' }],
      finishReason: 'stop',
    }),
  });
  await using provider = new NativeProvider({ modelBackend: model });
  const result = await new Agent({
    model: 'fixture',
    instructions: 'Answer.',
    provider,
  }).run('Begin.');
  expect(result.finalOutput).toBe('Done.');
});
