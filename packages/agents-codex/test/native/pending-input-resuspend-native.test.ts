import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  GuardrailTripwire,
  NativeProvider,
  manualTool,
  parseSessionState,
  pendingInput,
  tool,
  toolRef,
  withPendingInput,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(() => ModelServer.closeAll());
nativeIt(
  'keeps staged input when a restored pending grant suspends again',
  async () => {
    const server = new ModelServer([
      [call('decision', {}, { callId: 'resuspend-manual' })],
      [message('completed')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'local-fixture',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Ask and continue.',
      model: 'gpt-5.5',
      provider,
      tools: [
        manualTool({
          name: 'decision',
          description: 'Request a decision.',
          parameters: z.object({}),
          result: z.string(),
        }),
      ],
    });
    const initial = await agent.session();
    const first = await initial.submit('original');
    const ended = first.wait().catch((error) => error);
    await first.wait({ until: 'manual_tool' });
    const saved = await initial.suspend();
    await ended;
    await initial.close();
    await using restored = await agent.session({
      state: withPendingInput(saved, 'extra'),
    });
    const held = restored.restoredTurn!.wait().catch((error) => error);
    const again = parseSessionState(JSON.stringify(await restored.suspend()));
    await held;
    expect([19, 20]).toContain(again.format_version);
    expect(pendingInput(again)).toEqual(
      pendingInput(withPendingInput(saved, 'extra')),
    );
    await using resumed = await agent.session({ state: again });
    const request = (await resumed.pendingInteractions())[0];
    if (request?.type !== 'action_requested')
      throw new Error('Expected exact resumed grant');
    await resumed.respond(request.reply('accepted'));
    expect((await resumed.restoredTurn!.wait()).finalOutput).toBe('completed');
    expect(server.requests).toHaveLength(2);
    expect(JSON.stringify(server.requests[1].input)).toContain('extra');
    server.assertExhausted();
  },
  20000,
);

nativeIt(
  'retains forced-choice outcome data through staged rejection and portable retry',
  async () => {
    let reject = true;
    const effects: string[] = [];
    const server = new ModelServer([
      [call('decision', {}, { callId: 'forced-manual' })],
      [call('echo', {}, { callId: 'eligible-after-reset' })],
      [message('completed')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'local-fixture',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Ask, then echo.',
      model: 'gpt-5.5',
      provider,
      tools: [
        manualTool({
          name: 'decision',
          description: 'Request a decision.',
          parameters: z.object({}),
          result: z.string(),
        }),
        tool({
          name: 'echo',
          description: 'Echo after the choice resets.',
          parameters: z.object({}),
          execute: () => {
            effects.push('once');
            return 'echoed';
          },
        }),
      ],
      modelSettings: { toolChoice: toolRef('decision'), resetToolChoice: true },
      inputGuardrails: [
        {
          name: 'staged-reject',
          callback: ({ input }) => ({
            tripwireTriggered: typeof input !== 'string' && reject,
          }),
        },
      ],
    });
    const initial = await agent.session();
    const first = await initial.submit('original');
    const ended = first.wait().catch((error) => error);
    await first.wait({ until: 'manual_tool' });
    const saved = await initial.suspend();
    await ended;
    await initial.close();
    await using restored = await agent.session({
      state: withPendingInput(saved, 'extra'),
    });
    const request = (await restored.pendingInteractions())[0];
    if (request?.type !== 'action_requested')
      throw new Error('Expected original manual grant');
    const failed = restored.restoredTurn!.wait();
    failed.catch(() => {});
    await restored.respond(request.reply('accepted')).catch(() => {});
    await expect(failed).rejects.toBeInstanceOf(GuardrailTripwire);
    const retry = parseSessionState(JSON.stringify(await restored.saveState()));
    expect(server.requests).toHaveLength(1);
    reject = false;
    await using resumed = await agent.session({ state: retry });
    expect((await resumed.restoredTurn!.wait()).finalOutput).toBe('completed');
    expect(server.requests[1].tool_choice ?? 'auto').toBe('auto');
    expect(effects).toEqual(['once']);
    expect(server.requests).toHaveLength(3);
    server.assertExhausted();
  },
  20000,
);
