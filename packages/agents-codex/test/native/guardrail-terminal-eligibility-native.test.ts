import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { ModelServer, call, message } from './fixtures/model-server';
import {
  Agent,
  GuardrailTripwire,
  InteractionRequired,
  NativeProvider,
  ToolOutput,
  manualTool,
  tool,
} from '../../src';
afterEach(() => ModelServer.closeAll());
async function fixture(steps: ConstructorParameters<typeof ModelServer>[0]) {
  const server = new ModelServer(steps);
  const config = await server.config();
  return {
    server,
    provider: new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
    }),
  };
}
it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  'checks restored held candidate after sibling failure=%s reject=%s',
  async (failedSibling, reject) => {
    const effects: string[] = [],
      checked: string[] = [];
    const { provider, server } = await fixture([
      [
        call('finish', {}, { callId: 'held-call' }),
        call('sibling', {}, { callId: 'sibling-call' }),
        call('lookup', {}, { callId: 'manual-call' }),
      ],
      [message('ordinary after restore')],
    ]);
    await using _provider = provider;
    const options = {
      instructions: 'Use tools.',
      provider,
      tools: [
        tool({
          name: 'finish',
          parameters: z.object({}),
          finishTurn: true,
          execute() {
            effects.push('finish');
            return 'held-secret-sentinel';
          },
        }),
        tool({
          name: 'sibling',
          parameters: z.object({}),
          execute() {
            effects.push('sibling');
            return new ToolOutput(
              [{ type: 'inputText', text: 'settled sibling' }],
              !failedSibling,
            );
          },
        }),
        manualTool({
          name: 'lookup',
          description: 'Ask.',
          parameters: z.object({}),
          result: z.string(),
        }),
      ],
    };
    await using original = await new Agent(options).session();
    const first = await original.submit('begin');
    const interrupted = first.wait().catch((error: unknown) => error);
    for await (const event of original.events())
      if (event.type === 'action_requested') break;
    const state = await original.suspend();
    expect(await interrupted).toBeInstanceOf(InteractionRequired);
    expect(effects.sort()).toEqual(['finish', 'sibling']);
    expect(JSON.stringify(state.history)).not.toContain('held-secret-sentinel');
    await original.close();
    await using restored = await new Agent({
      ...options,
      outputGuardrails: [
        {
          name: 'restored',
          callback(context) {
            if (context.toolCall) {
              checked.push(context.toolCall.callId!);
              expect(context.finalOutput).toBe('held-secret-sentinel');
              return { tripwireTriggered: reject };
            }
            return { tripwireTriggered: false };
          },
        },
      ],
    }).session({ state: JSON.parse(JSON.stringify(state)) });
    for await (const event of restored.events()) {
      if (event.type !== 'action_requested') continue;
      await restored.respond(event.reply('accepted'));
      break;
    }
    if (reject)
      await expect(restored.restoredTurn!.wait()).rejects.toBeInstanceOf(
        GuardrailTripwire,
      );
    else
      expect((await restored.restoredTurn!.wait()).finalOutput).toBe(
        'ordinary after restore',
      );
    expect(checked).toEqual(['held-call']);
    expect(effects.sort()).toEqual(['finish', 'sibling']);
    expect(server.requests.length).toBe(reject ? 1 : 2);
    expect(
      JSON.stringify(await Array.fromAsync(restored.items())).includes(
        'held-secret-sentinel',
      ),
    ).toBe(!reject);
  },
);
it('continues after failed terminal without a held body', async () => {
  const { provider } = await fixture([
    [call('finish', {}, { callId: 'failed-terminal' })],
    [message('ordinary after failure')],
  ]);
  await using _provider = provider;
  const seen: unknown[] = [];
  await using session = await new Agent({
    instructions: 'Use finish.',
    provider,
    tools: [
      tool({
        name: 'finish',
        parameters: z.object({}),
        finishTurn: true,
        execute: () =>
          new ToolOutput(
            [{ type: 'inputText', text: 'failed terminal' }],
            false,
          ),
      }),
    ],
    outputGuardrails: [
      {
        name: 'ordinary',
        callback(context) {
          seen.push(context.toolCall);
          expect(context.toolCall).toBeUndefined();
          return { tripwireTriggered: false };
        },
      },
    ],
  }).session();
  expect((await (await session.submit('begin')).wait()).finalOutput).toBe(
    'ordinary after failure',
  );
  expect(seen).toEqual([undefined]);
});

it.each([false, true])(
  'checks live held candidate in failed batch without completion policy reject=%s',
  async (reject) => {
    const effects: string[] = [],
      checked: string[] = [],
      completed: (string | null)[] = [];
    const { provider } = await fixture([
      [
        call('finish', {}, { callId: 'live-held' }),
        call('sibling', {}, { callId: 'live-failed' }),
      ],
      [message('ordinary live continuation')],
    ]);
    await using _provider = provider;
    await using session = await new Agent({
      instructions: 'Use tools.',
      provider,
      beforeComplete(context) {
        completed.push(context.text);
      },
      tools: [
        tool({
          name: 'finish',
          parameters: z.object({}),
          finishTurn: true,
          execute() {
            effects.push('finish');
            return 'live-held-secret';
          },
        }),
        tool({
          name: 'sibling',
          parameters: z.object({}),
          execute() {
            effects.push('sibling');
            return new ToolOutput(
              [{ type: 'inputText', text: 'ordinary sibling failure' }],
              false,
            );
          },
        }),
      ],
      outputGuardrails: [
        {
          name: 'live-check',
          callback(context) {
            if (context.toolCall) {
              checked.push(context.toolCall.callId!);
              expect(context.finalOutput).toBe('live-held-secret');
              return { tripwireTriggered: reject };
            }
            return { tripwireTriggered: false };
          },
        },
      ],
    }).session();
    const turn = await session.submit('begin');
    if (reject)
      await expect(turn.wait()).rejects.toBeInstanceOf(GuardrailTripwire);
    else
      expect((await turn.wait()).finalOutput).toBe(
        'ordinary live continuation',
      );
    expect(checked).toEqual(['live-held']);
    expect(completed).toEqual(reject ? [] : ['ordinary live continuation']);
    expect(effects.sort()).toEqual(['finish', 'sibling']);
    expect(
      JSON.stringify(await Array.fromAsync(session.items())).includes(
        'live-held-secret',
      ),
    ).toBe(!reject);
  },
);
