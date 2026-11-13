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

it.each([false, true])(
  'awaits an output transform while keeping streamed provider deltas (stream=%s)',
  async (stream) => {
    const rawText = 'provider draft';
    const finalText = 'normalized answer';
    let transformCalls = 0;
    const model = new AiSdkModel(
      {
        specificationVersion: 'v3',
        provider: 'fixture.model',
        modelId: 'fixture-transform',
        doGenerate() {
          return {
            content: [{ type: 'text', text: rawText }],
            finishReason: 'stop',
          };
        },
        doStream() {
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({
                  type: 'text-delta',
                  id: 'one',
                  delta: rawText,
                });
                controller.enqueue({ type: 'finish', finishReason: 'stop' });
                controller.close();
              },
            }),
          };
        },
      },
      {},
      {
        stream,
        async transformOutputText(text, context) {
          expect(text).toBe(rawText);
          expect(context).toMatchObject({
            provider: 'fixture.model',
            modelId: 'fixture-transform',
            specificationVersion: 'v3',
            stream,
          });
          expect(context.request.turnId).toBeTruthy();
          await Promise.resolve();
          transformCalls++;
          return finalText;
        },
      },
    );
    await using provider = new NativeProvider({
      apiKey: 'synthetic',
      modelBackend: model,
    });
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'fixture-transform',
      provider,
    });
    await using session = await agent.session({ observationRetention: 'all' });
    const turn = await session.submit('Begin.');
    const deltas = [];
    for await (const event of turn.events()) {
      if (event.type === 'output_text_delta') deltas.push(event.delta);
    }
    expect((await turn.wait()).finalOutput).toBe(finalText);
    expect(transformCalls).toBe(1);
    if (stream) expect(deltas.join('')).toBe(rawText);
    expect(JSON.stringify(await session.historySnapshot())).toContain(
      finalText,
    );
  },
);

it.each([false, true])(
  'sets explicit provider cache breakpoints on admitted prompt parts without changing native history (stream=%s)',
  async (stream) => {
    const prompts: any[][] = [];
    const breakPoint = { anthropic: { cacheControl: { type: 'ephemeral' } } };
    const output = 'native cache breakpoint answer';
    const model = new AiSdkModel(
      {
        specificationVersion: 'v3',
        provider: 'anthropic.messages',
        modelId: 'cache-test',
        doGenerate(options) {
          prompts.push(options.prompt);
          return {
            content: [{ type: 'text', text: output }],
            finishReason: 'stop',
          };
        },
        doStream(options) {
          prompts.push(options.prompt);
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({
                  type: 'text-delta',
                  id: 'text',
                  delta: output,
                });
                controller.enqueue({ type: 'finish', finishReason: 'stop' });
                controller.close();
              },
            }),
          };
        },
      },
      {},
      {
        stream,
        resolvePromptProviderOptions({ role, contentIndex, item }) {
          if (role === 'system') return breakPoint;
          if (
            role === 'user' &&
            contentIndex === 0 &&
            item.text === 'Cache this exact input.'
          ) {
            return breakPoint;
          }
          return undefined;
        },
      },
    );
    await using provider = new NativeProvider({
      apiKey: 'synthetic',
      modelBackend: model,
    });
    const root = new Agent({
      instructions: 'Cache the developer instructions.',
      model: 'cache-test',
      provider,
    });
    await using session = await root.session();
    expect(
      (await (await session.submit('Cache this exact input.')).wait())
        .finalOutput,
    ).toBe(output);
    expect(prompts[0]).toContainEqual({
      role: 'system',
      content: expect.stringContaining('Cache the developer instructions.'),
      providerOptions: breakPoint,
    });
    expect(prompts[0]).toContainEqual({
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Cache this exact input.',
          providerOptions: breakPoint,
        },
      ],
    });
    expect(JSON.stringify(await session.historySnapshot())).not.toContain(
      'cacheControl',
    );
  },
);
