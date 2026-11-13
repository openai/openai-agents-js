import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  AiSdkModel,
  NativeProvider,
  InteractionRequired,
  manualTool,
  parseSessionState,
  tool,
} from '../../src';

type Mode = 'buffered' | 'streamed';
const token = 'synthetic-private-provider-continuation';
const metadata = (value: string) => ({ fixture: { continuation: value } });
const toolParts = (prompt: any[]) =>
  prompt
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.content)
    .filter((part) => part.type === 'tool-call');
function adapter(
  mode: Mode,
  produce: (prompt: any[]) => any,
  provider = 'fixture.metadata',
  modelId = 'fixture-metadata-model',
) {
  const model = {
    specificationVersion: 'v3' as const,
    provider,
    modelId,
    doGenerate(options: any) {
      return produce(options.prompt);
    },
    doStream(options: any) {
      const response = produce(options.prompt);
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of response.content) {
              if (part.type === 'tool-call') {
                controller.enqueue({
                  type: 'tool-input-start',
                  id: part.toolCallId,
                  toolName: part.toolName,
                  providerMetadata: part.providerMetadata,
                });
                controller.enqueue({
                  type: 'tool-input-end',
                  id: part.toolCallId,
                });
                const { providerMetadata: _metadata, ...call } = part;
                controller.enqueue(call);
              } else {
                controller.enqueue({ type: 'text-start', id: 'text' });
                controller.enqueue({
                  type: 'text-delta',
                  id: 'text',
                  delta: part.text,
                });
                controller.enqueue({ type: 'text-end', id: 'text' });
              }
            }
            controller.enqueue({
              type: 'finish',
              finishReason: response.finishReason,
              providerMetadata: response.providerMetadata,
            });
            controller.close();
          },
        }),
      };
    },
  };
  return new AiSdkModel(model, {}, { stream: mode === 'streamed' });
}
const calls = (ids: string[]) => ({
  content: ids.map((id, index) => ({
    type: 'tool-call',
    toolCallId: id,
    toolName: 'lookup',
    input: '{}',
    providerMetadata: metadata(`${token}-${index}`),
  })),
  providerMetadata: metadata('synthetic-response-fallback'),
  response: { id: 'same-provider-response-id' },
  finishReason: 'tool-calls',
});
const done = () => ({
  content: [{ type: 'text', text: 'done' }],
  finishReason: 'stop',
});

for (const mode of ['buffered', 'streamed'] as const) {
  it(`retains ordered ${mode} model metadata without exposing it in public history or another Session`, async () => {
    const prompts: any[][] = [];
    let requests = 0;
    let effects = 0;
    const backend = adapter(mode, (prompt) => {
      prompts.push(prompt);
      requests++;
      if (requests === 1) return calls(['first', 'second']);
      if (requests === 3) {
        const response = calls(['first', 'second']);
        for (const part of response.content)
          delete (part as any).providerMetadata;
        delete (response as any).providerMetadata;
        return response;
      }
      return done();
    });
    await using provider = new NativeProvider({
      modelBackend: backend,
      apiKey: 'fixture-metadata-key',
    });
    const agent = new Agent({
      instructions: 'Use lookup and then finish.',
      model: 'fixture-metadata-model',
      provider,
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          execute() {
            effects++;
            return 'accepted';
          },
        }),
      ],
    });
    await using session = await agent.session({
      includeRawProviderEvents: true,
    });
    const turn = await session.submit('Run.');
    const events: any[] = [];
    const observations = (async () => {
      for await (const event of turn.events()) events.push(event);
    })();
    expect((await turn.wait()).finalOutput).toBe('done');
    await observations;
    expect(
      toolParts(prompts[1]).map(
        (part) => part.providerOptions.fixture.continuation,
      ),
    ).toEqual([`${token}-0`, `${token}-1`]);
    expect(effects).toBe(2);
    expect(JSON.stringify(events)).not.toContain(token);
    expect(JSON.stringify(await session.historySnapshot())).not.toContain(
      token,
    );
    const items = [];
    for await (const item of session.items()) items.push(item);
    expect(JSON.stringify(items)).not.toContain(token);
    const saved = await session.saveState();
    expect(JSON.stringify(saved)).toContain(token);
    await using independent = await agent.session();
    expect(
      (await (await independent.submit('Independent.')).wait()).finalOutput,
    ).toBe('done');
    expect(
      toolParts(prompts[3]).every((part) => part.providerOptions === undefined),
    ).toBe(true);
    expect(effects).toBe(4);
    expect(requests).toBe(4);
  }, 30_000);

  it(`refuses ${mode} metadata replay after a same-ID request payload edit`, async () => {
    const prompts: any[][] = [];
    let edits = 0;
    const backend = adapter(mode, (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1 ? calls(['edited']) : done();
    });
    function edit(request: any) {
      const call = request.body.input.find(
        (item: any) => item.type === 'function_call',
      );
      if (call) {
        call.arguments = '{"changed":true}';
        edits++;
      }
    }
    await using provider = new NativeProvider({
      apiKey: 'fixture-metadata-key',
      modelBackend: {
        complete(request) {
          edit(request);
          return backend.complete(request);
        },
        ...(mode === 'streamed'
          ? {
              async *stream(request: any) {
                edit(request);
                yield* backend.stream!(request);
              },
            }
          : {}),
      },
    });
    await using session = await new Agent({
      instructions: 'Use lookup then finish.',
      model: 'fixture-metadata-model',
      provider,
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          execute() {
            return 'accepted';
          },
        }),
      ],
    }).session();
    expect((await (await session.submit('Run.')).wait()).finalOutput).toBe(
      'done',
    );
    expect(edits).toBe(1);
    const replayed = toolParts(prompts[1])[0];
    expect(replayed.input).toEqual({ changed: true });
    expect(replayed.providerOptions).toBeUndefined();
  }, 30_000);

  it(`preserves ${mode} tool-call metadata through a JSON portable manual continuation`, async () => {
    const prompts: any[][] = [];
    const backend = adapter(mode, (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1 ? calls(['manual']) : done();
    });
    await using provider = new NativeProvider({
      modelBackend: backend,
      apiKey: 'fixture-metadata-key',
    });
    const agent = new Agent({
      instructions: 'Use lookup and then finish.',
      model: 'fixture-metadata-model',
      provider,
      tools: [
        manualTool({
          name: 'lookup',
          description: 'Ask for the lookup result.',
          parameters: z.object({}),
          result: z.string(),
        }),
      ],
    });
    await using original = await agent.session();
    const turn = await original.submit('Run.');
    const completion = turn.wait().catch((error: unknown) => error);
    for await (const event of original.events())
      if (event.type === 'action_requested') break;
    const state = await original.suspend();
    expect(await completion).toBeInstanceOf(InteractionRequired);
    const wire = JSON.stringify(state);
    expect(wire).toContain(token);
    await original.close();
    await using restored = await agent.session({
      state: parseSessionState(wire),
    });
    const pending = (await restored.pendingInteractions())[0];
    expect(pending).toBeDefined();
    if (pending.type !== 'action_requested')
      throw new Error('Expected the current manual tool request');
    await restored.respond(pending.reply('accepted'));
    expect((await restored.restoredTurn!.wait()).finalOutput).toBe('done');
    expect(toolParts(prompts[1])[0].providerOptions).toEqual(
      metadata(`${token}-0`),
    );
    expect(prompts).toHaveLength(2);
  }, 30_000);

  for (const [isolation, providerName, modelId] of [
    ['provider', 'foreign.metadata', 'fixture-metadata-model'],
    ['model', 'fixture.metadata', 'foreign-fixture-model'],
    ['provider casing', 'Fixture.Metadata', 'fixture-metadata-model'],
    ['model casing', 'fixture.metadata', 'Fixture-Metadata-Model'],
  ] as const)
    it(`keeps ${mode} metadata off a different current ${isolation}`, async () => {
      let foreignPrompt: any[] | undefined;
      let selected: AiSdkModel;
      const foreign = adapter(
        mode,
        (prompt) => {
          foreignPrompt = prompt;
          return done();
        },
        providerName,
        modelId,
      );
      const first = adapter(mode, () => calls(['switch']));
      selected = first;
      await using provider = new NativeProvider({
        modelBackend: { getModel: () => selected },
        apiKey: 'fixture-metadata-key',
      });
      const agent = new Agent({
        instructions: 'Use lookup and then finish.',
        model: 'fixture-metadata-model',
        provider,
        tools: [
          tool({
            name: 'lookup',
            parameters: z.object({}),
            execute() {
              selected = foreign;
              return 'accepted';
            },
          }),
        ],
      });
      await using session = await agent.session();
      expect((await (await session.submit('Run.')).wait()).finalOutput).toBe(
        'done',
      );
      expect(foreignPrompt).toBeDefined();
      expect(JSON.stringify(foreignPrompt)).not.toContain(token);
      expect(toolParts(foreignPrompt!)[0].providerOptions).toBeUndefined();
    }, 30_000);
}

it('replays a streamed thought signature on the next request without public raw metadata', async () => {
  const signature = 'synthetic-private-streamed-text-signature';
  const prompts: any[][] = [];
  const backend = new AiSdkModel(
    {
      specificationVersion: 'v3',
      provider: 'google.generative-ai',
      modelId: 'fixture-signed-text',
      doGenerate() {
        throw new Error('Expected streaming');
      },
      doStream(options) {
        prompts.push(options.prompt);
        const first = prompts.length === 1;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: 'text-delta',
                id: 'text',
                delta: first ? 'first answer' : 'continued answer',
                ...(first
                  ? {
                      providerMetadata: {
                        google: { thoughtSignature: signature },
                      },
                    }
                  : {}),
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
  await using provider = new NativeProvider({
    modelBackend: backend,
    apiKey: 'synthetic-signed-text',
  });
  await using session = await new Agent({
    instructions: 'Answer.',
    model: 'fixture-signed-text',
    provider,
  }).session({ includeRawProviderEvents: true, observationRetention: 'all' });
  const events: any[] = [];
  for (const [input, output] of [
    ['Start.', 'first answer'],
    ['Continue.', 'continued answer'],
  ]) {
    const turn = await session.submit(input);
    const observe = (async () => {
      for await (const event of turn.events({ includeExecutionDetails: true }))
        events.push(event);
    })();
    expect((await turn.wait()).finalOutput).toBe(output);
    await observe;
  }
  expect(prompts).toHaveLength(2);
  expect(prompts[1].filter((entry) => entry.role === 'assistant')).toEqual([
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'first answer',
          providerOptions: { google: { thoughtSignature: signature } },
        },
      ],
      providerOptions: { google: { thoughtSignature: signature } },
    },
  ]);
  expect(events.some((event) => event.type === 'raw_provider_event')).toBe(
    true,
  );
  expect(JSON.stringify(events)).not.toContain(signature);
  expect(JSON.stringify(await session.historySnapshot())).not.toContain(
    signature,
  );
}, 30_000);
