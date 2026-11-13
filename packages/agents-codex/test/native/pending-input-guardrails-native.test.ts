import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  manualTool,
  withPendingInput,
  parseSessionState,
  ToolOutput,
  GuardrailTripwire,
  pendingInput,
} from '../../src';
import {
  isManualSessionState,
  isBudgetedManualSessionState,
  isOutputAwareState,
} from '../../src/runtime/state';
import { ModelServer, call, message } from './fixtures/model-server';
const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(() => ModelServer.closeAll());
nativeIt.each([false, true])(
  'checks only staged input before recovery sampling (parallel=%s)',
  async (runInParallel) => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const seen: unknown[] = [];
    const server = new ModelServer([
      [call('decision', {}, { callId: 'saved-call' })],
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
      inputGuardrails: [
        {
          name: 'staged-owner',
          runInParallel,
          async callback({ input }) {
            seen.push(input);
            if (typeof input !== 'string') {
              entered.resolve();
              await gate.promise;
            }
            return { tripwireTriggered: false };
          },
        },
      ],
    });
    const initial = await agent.session();
    const turn = await initial.submit('original');
    const completion = turn.wait().catch((error) => error);
    await turn.wait({ until: 'manual_tool' });
    const snapshot = await initial.suspend();
    await completion;
    await initial.close();
    const staged = withPendingInput(snapshot, 'extra');
    await using restored = await agent.session({
      state: parseSessionState(JSON.stringify(staged)),
    });
    const request = (await restored.pendingInteractions())[0];
    if (!request || request.type !== 'action_requested')
      throw new Error('Expected restored manual grant');
    const response = restored.respond(request.reply('accepted'));
    try {
      await entered.promise;
      expect(server.requests).toHaveLength(1);
      expect(seen).toEqual([
        'original',
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'extra' }],
        },
      ]);
    } finally {
      gate.resolve();
      await response;
    }
    expect((await restored.restoredTurn!.wait()).finalOutput).toBe('completed');
    const input = server.requests[1].input as {
      type: string;
      call_id?: string;
      content?: unknown;
    }[];
    expect(
      input.findIndex(
        (item) =>
          item.call_id === 'saved-call' && item.type === 'function_call_output',
      ),
    ).toBeLessThan(
      input.findIndex((item) =>
        (JSON.stringify(item.content) ?? '').includes('extra'),
      ),
    );
    server.assertExhausted();
  },
  20000,
);

nativeIt(
  'retains a rejected staged batch and its accepted reply sidecar exactly once',
  async () => {
    let reject = true;
    let parsed = 0;
    const server = new ModelServer([
      [call('decision', {}, { callId: 'saved-sidecar' })],
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
          result: z.string().transform((value) => {
            parsed++;
            return new ToolOutput([{ type: 'inputText', text: value }], true, {
              tag: 'host-only-sidecar',
            });
          }),
        }),
      ],
      inputGuardrails: [
        {
          name: 'staged-reject',
          runInParallel: true,
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
    await using resumed = await agent.session({
      state: withPendingInput(saved, 'extra'),
    });
    const request = (await resumed.pendingInteractions())[0];
    if (request?.type !== 'action_requested')
      throw new Error('Missing manual grant');
    const result = resumed.restoredTurn!.wait();
    result.catch(() => {});
    await resumed.respond(request.reply('accepted')).catch(() => {});
    await expect(result).rejects.toBeInstanceOf(GuardrailTripwire);
    const retry = await resumed.saveState();
    expect(pendingInput(retry)).toHaveLength(1);
    if (!isManualSessionState(retry) || !isOutputAwareState(retry))
      throw new Error('Expected output-aware retry checkpoint');
    expect(retry.manual_continuation.staged_retry).toBe(true);
    const sidecars = [
      ...(retry.application_tool_outputs ?? []),
      ...(retry.pending_application_tool_outputs ?? []),
    ];
    expect(
      sidecars.filter(
        (item) => item.applicationData.tag === 'host-only-sidecar',
      ),
    ).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
    reject = false;
    await using retried = await agent.session({
      state: parseSessionState(JSON.stringify(retry)),
    });
    expect((await retried.restoredTurn!.wait()).finalOutput).toBe('completed');
    expect(parsed).toBe(1);
    expect(JSON.stringify(server.requests)).not.toContain('host-only-sidecar');
    server.assertExhausted();
  },
  20000,
);

nativeIt.each(['request-budget', 'model-steps'])(
  'samples with exactly one remaining slot (%s)',
  async (mode) => {
    const server = new ModelServer([
      [call('decision', {}, { callId: 'one-slot' })],
      [message('completed')],
    ]);
    const cfg = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (cfg['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'local-fixture',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Ask and continue.',
      provider,
      model: 'gpt-5.5',
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
    const first = await initial.submit(
      'original',
      mode === 'request-budget'
        ? { budget: { maxRequests: 2 } }
        : { maxModelSteps: 2 },
    );
    const ended = first.wait().catch((error) => error);
    await first.wait({ until: 'manual_tool' });
    const saved = await initial.suspend();
    await ended;
    await initial.close();
    if (!isManualSessionState(saved))
      throw new Error('Expected manual checkpoint');
    if (mode === 'request-budget' && !isBudgetedManualSessionState(saved))
      throw new Error('Expected saved request budget');
    if (mode === 'request-budget' && isBudgetedManualSessionState(saved))
      expect(saved.run_budget).toEqual({
        version: 1,
        maxRequests: 2,
        admittedRequests: 1,
      });
    else expect(saved.manual_context.remaining_model_steps).toBe(1);
    await using resumed = await agent.session({
      state: withPendingInput(saved, 'extra'),
      ...(mode === 'request-budget'
        ? { resumeBudget: { maxRequests: 2 } }
        : {}),
    });
    const decision = (await resumed.pendingInteractions())[0];
    if (decision?.type !== 'action_requested')
      throw new Error('Expected exact manual grant');
    const done = resumed.restoredTurn!.wait();
    done.catch(() => {});
    await resumed.respond(decision.reply('accepted')).catch(() => {});
    expect((await done).finalOutput).toBe('completed');
    expect(server.requests).toHaveLength(2);
    server.assertExhausted();
  },
  20000,
);
