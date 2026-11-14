import { expect, it } from 'vitest';
import { Agent, AiSdkModel, NativeProvider } from '../../src';
import type { JsonObject } from '../../src/runtime/binding';

const file = {
  type: 'file',
  mediaType: 'image/png',
  data: 'ZmlsZS1wcm92aWRlci1kYXRh',
  providerMetadata: { fixture: { label: 'opaque-file' } },
};

it.each([false, true])(
  'keeps an auxiliary AI SDK file observational (capture=%s)',
  async (capture) => {
    const model = new AiSdkModel(
      {
        specificationVersion: 'v3',
        provider: 'fixture.files',
        modelId: 'fixture',
        doGenerate() {
          throw new Error('Unexpected buffered call');
        },
        doStream() {
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue(file);
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
    const files = observed.filter((part) => part.type === 'file');
    expect(files).toEqual(capture ? [file] : []);
    const history = JSON.stringify(await session.historySnapshot());
    expect(history).not.toContain(file.data);
    expect(history).not.toContain(file.mediaType);
    expect(history).not.toContain('opaque-file');
  },
);

it('settles a buffered answer without converting its auxiliary file into a response item', async () => {
  const model = new AiSdkModel({
    specificationVersion: 'v3',
    provider: 'fixture.files',
    modelId: 'fixture',
    doGenerate: () => ({
      content: [file, { type: 'text', text: 'Done.' }],
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
