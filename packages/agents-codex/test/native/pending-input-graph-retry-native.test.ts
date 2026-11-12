import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  GuardrailTripwire,
  NativeProvider,
  manualTool,
  parseSessionState,
  withPendingInput,
  withoutPendingInput,
  type UserInput,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(() => ModelServer.closeAll());
nativeIt.each([false, true])(
  'restores the settled worker retry after a handoff (clear=%s)',
  async (clear) => {
    let reject = true;
    let accepted = 0;
    const server = new ModelServer([
      [call('transfer_to_worker', {}, { callId: 'root-route' })],
      [call('decision', {}, { callId: 'worker-manual' })],
      [message('completed')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'local-fixture',
      supportsWebsockets: false,
    });
    const worker = new Agent({
      name: 'Worker',
      instructions: 'Worker source.',
      tools: [
        manualTool({
          name: 'decision',
          description: 'Request a decision.',
          parameters: z.object({}),
          result: z.string().transform((value) => {
            accepted++;
            return value;
          }),
        }),
      ],
    });
    const inputGuardrails = [
      {
        name: 'worker-stage',
        callback: ({ input }: { input: UserInput }) => ({
          tripwireTriggered: typeof input !== 'string' && reject,
        }),
      },
    ];
    const root = new Agent({
      instructions: 'Root source.',
      model: 'gpt-5.5',
      provider,
      handoffs: [worker],
    });
    const initial = await root.session({ inputGuardrails });
    const first = await initial.submit('original');
    const ended = first.wait().catch((error) => error);
    await first.wait({ until: 'manual_tool' });
    const saved = await initial.suspend();
    await ended;
    await initial.close();
    await using restored = await root.session({
      state: withPendingInput(saved, 'staged'),
      inputGuardrails,
    });
    const decision = (await restored.pendingInteractions())[0];
    if (decision?.type !== 'action_requested')
      throw new Error('Expected worker manual grant');
    const result = restored.restoredTurn!.wait();
    result.catch(() => {});
    await restored.respond(decision.reply('accepted')).catch(() => {});
    await expect(result).rejects.toBeInstanceOf(GuardrailTripwire);
    const retry = await restored.saveState();
    expect(server.requests).toHaveLength(2);
    reject = false;
    await using resumed = await root.session({
      inputGuardrails,
      state: parseSessionState(
        JSON.stringify(clear ? withoutPendingInput(retry) : retry),
      ),
    });
    expect((await resumed.restoredTurn!.wait()).finalOutput).toBe('completed');
    expect(accepted).toBe(1);
    expect(server.requests).toHaveLength(3);
    expect(server.requests[2].tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function', name: 'decision' }),
      ]),
    );
    server.assertExhausted();
  },
  20000,
);
