import { expect, it } from 'vitest';
import { Agent, AiSdkModel, NativeProvider, tool } from '../../src';
import { z } from 'zod';
import type { JsonObject } from '../../src/runtime/binding';

const file = {
  type: 'tool-result',
  toolCallId: 'provider-call',
  toolName: 'lookup',
  result: 'opaque-provider-result',
  providerExecuted: true,
};

it.each([false, true])(
  'keeps an unrequested provider tool result observational (capture=%s)',
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
    const files = observed.filter((part) => part.type === 'tool-result');
    expect(files).toEqual(capture ? [file] : []);
    const history = JSON.stringify(await session.historySnapshot());
    expect(history).not.toContain(file.result);
    expect(history).not.toContain(file.toolCallId);
  },
);

it('settles a buffered answer without converting its unrequested provider tool result into a response item', async () => {
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

const pairedCases = ['buffered', 'stream'].flatMap((mode) =>
  ['declared', 'provider'].flatMap((kind) =>
    [false, true].map((resultFirst) => ({ mode, kind, resultFirst })),
  ),
);
it.each(pairedCases)(
  'rejects a $kind call/result pair ($mode, resultFirst=$resultFirst)',
  async ({ mode, kind, resultFirst }) => {
    let effects = 0;
    const call = {
      type: 'tool-call',
      toolCallId: 'provider-call',
      toolName: 'lookup',
      input: {},
      providerExecuted: kind === 'provider',
    };
    const content = resultFirst ? [file, call] : [call, file];
    const model = new AiSdkModel(
      {
        specificationVersion: 'v3',
        provider: 'fixture.tools',
        modelId: 'fixture',
        doGenerate: () => ({ content, finishReason: 'stop' }),
        doStream: () => ({
          stream: new ReadableStream({
            start(c) {
              for (const part of [
                ...content,
                { type: 'finish', finishReason: 'stop' },
              ])
                c.enqueue(part);
              c.close();
            },
          }),
        }),
      },
      {},
      { stream: mode === 'stream' },
    );
    await using provider = new NativeProvider({ modelBackend: model });
    const declared = tool({
      name: 'lookup',
      description: 'Lookup.',
      parameters: z.object({}),
      execute: () => {
        effects++;
        return 'done';
      },
    });
    const agent = new Agent({
      provider,
      model: 'fixture',
      instructions: 'Answer.',
      tools: kind === 'declared' ? [declared] : [],
    });
    await expect(agent.run('Begin.')).rejects.toThrow(/tool|unsupported/);
    expect(effects).toBe(0);
  },
);
