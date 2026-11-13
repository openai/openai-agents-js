import { expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, AiSdkModel, NativeProvider, tool } from '../../src';

it.each([false, true])(
  'replays non-Responses reasoning only to its exact provider and model (stream=%s)',
  async (stream) => {
    const prompts: unknown[][] = [];
    const token = 'synthetic-anthropic-continuation-signature';
    const providerMetadata = { anthropic: { signature: token } };
    const part = {
      type: 'reasoning',
      text: 'Private reasoning.',
      providerMetadata,
    };
    const text = (first: boolean) => (first ? 'first answer' : 'next answer');
    const model = (name: string) =>
      new AiSdkModel(
        {
          specificationVersion: 'v3',
          provider: name,
          modelId: 'reasoning-model',
          doGenerate(options) {
            prompts.push(options.prompt);
            const first = prompts.length === 1;
            return {
              content: [
                ...(first ? [part] : []),
                { type: 'text', text: text(first) },
              ],
              finishReason: 'stop',
            };
          },
          doStream(options) {
            prompts.push(options.prompt);
            const first = prompts.length === 1;
            return {
              stream: new ReadableStream({
                start(controller) {
                  if (first) {
                    controller.enqueue({ type: 'reasoning-start', id: 'r1' });
                    controller.enqueue({
                      type: 'reasoning-delta',
                      id: 'r1',
                      delta: part.text,
                    });
                    controller.enqueue({
                      type: 'reasoning-end',
                      id: 'r1',
                      providerMetadata,
                    });
                  }
                  controller.enqueue({
                    type: 'text-delta',
                    id: 't1',
                    delta: text(first),
                  });
                  controller.enqueue({ type: 'finish', finishReason: 'stop' });
                  controller.close();
                },
              }),
            };
          },
        },
        {},
        { stream },
      );
    await using provider = new NativeProvider({
      apiKey: 'synthetic',
      modelBackend: model('anthropic.messages'),
    });
    const root = new Agent({
      instructions: 'Answer.',
      model: 'reasoning-model',
      provider,
    });
    const state = await (async () => {
      await using session = await root.session();
      expect((await (await session.submit('Begin.')).wait()).finalOutput).toBe(
        'first answer',
      );
      expect(JSON.stringify(await session.historySnapshot())).not.toContain(
        token,
      );
      return session.saveState();
    })();
    await using resumed = await root.session({ state });
    expect((await (await resumed.submit('Continue.')).wait()).finalOutput).toBe(
      'next answer',
    );
    const replay = prompts[1] as { content?: unknown[] }[];
    expect(replay.flatMap((message) => message.content ?? [])).toContainEqual({
      type: 'reasoning',
      text: part.text,
      providerOptions: providerMetadata,
    });
    await using other = new NativeProvider({
      apiKey: 'synthetic',
      modelBackend: model('other.fixture'),
    });
    const isolated = new Agent({
      instructions: 'Answer.',
      model: 'reasoning-model',
      provider: other,
    });
    await using switched = await isolated.session({ state });
    expect(
      (await (await switched.submit('Continue elsewhere.')).wait()).finalOutput,
    ).toBe('next answer');
    expect(JSON.stringify(prompts[2])).not.toContain(token);
    expect(JSON.stringify(prompts[2])).not.toContain(part.text);
  },
);

it.each([
  { modelId: 'deepseek-reasoner', providerOptions: {} },
  {
    modelId: 'deepseek-chat',
    providerOptions: { deepseek: { thinking: { type: 'enabled' } } },
  },
])(
  'keeps $modelId reasoning and its tool call on the same assistant message',
  async ({ modelId, providerOptions }) => {
    let requests = 0;
    const backend = new AiSdkModel(
      {
        specificationVersion: 'v3',
        provider: 'deepseek.chat',
        modelId,
        doGenerate({ prompt }) {
          if (++requests === 1) {
            return {
              content: [
                { type: 'reasoning', text: 'Retained reasoning.' },
                {
                  type: 'tool-call',
                  toolCallId: 'lookup-id',
                  toolName: 'lookup',
                  input: '{}',
                },
              ],
              finishReason: 'tool-calls',
            };
          }
          expect(prompt).toContainEqual(
            expect.objectContaining({
              role: 'assistant',
              content: [
                expect.objectContaining({
                  type: 'reasoning',
                  text: 'Retained reasoning.',
                }),
                expect.objectContaining({
                  type: 'tool-call',
                  toolCallId: 'lookup-id',
                }),
              ],
            }),
          );
          return {
            content: [{ type: 'text', text: 'done' }],
            finishReason: 'stop',
          };
        },
      },
      providerOptions,
    );
    await using provider = new NativeProvider({
      apiKey: 'synthetic',
      modelBackend: backend,
    });
    const agent = new Agent({
      instructions: 'Use lookup.',
      model: modelId,
      provider,
      tools: [
        tool({
          name: 'lookup',
          description: 'Look up the fixture.',
          parameters: z.object({}),
          execute: () => 'fixture result',
        }),
      ],
    });
    expect((await agent.run('Begin.')).finalOutput).toBe('done');
    expect(requests).toBe(2);
  },
);
