import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  ToolOutput,
  tool,
  type ObservedEvent,
  parseSessionState,
} from '../src';
import { nativeCheckpoint } from '../src/runtime/state';
import { ModelServer, call, message } from './native/fixtures/model-server';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
async function finished(reader: AsyncIterator<ObservedEvent>) {
  while (true) {
    const next = await reader.next();
    expect(next.done).toBe(false);
    expect(next.value.type).not.toBe('turn_finished');
    if (next.value.type === 'tool_finished') return next.value;
  }
}
nativeIt.each([true, false])(
  'streams acknowledged post-hook output with reader isolation (success=%s)',
  async (success) => {
    const privateValue = 'private-application-value';
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const lookup = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute: () => 'raw callback output',
      after: () =>
        new ToolOutput(
          [{ type: 'inputText', text: 'post-hook output' }],
          success,
          { privateValue, nested: { count: 1 } },
        ),
    });
    const model = new ModelServer([
      [call('lookup', {}, { callId: 'observed-call' })],
      async (request) => {
        expect(JSON.stringify(request)).not.toContain(privateValue);
        expect(JSON.stringify(request)).not.toContain('applicationData');
        const output = (
          request.input as {
            type: string;
            call_id?: string;
            output?: unknown;
          }[]
        ).find(
          (i) =>
            i.type === 'function_call_output' && i.call_id === 'observed-call',
        );
        expect(JSON.stringify(output?.output)).toContain('post-hook output');
        entered.resolve();
        await release.promise;
        return [message('done')];
      },
      (request) => {
        expect(JSON.stringify(request)).not.toContain(privateValue);
        return [message('cold')];
      },
    ]);
    try {
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-function-output',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        instructions: 'Use lookup',
        tools: [lookup],
        provider,
      });
      await using session = await agent.session();
      const first = session.events({ includeExecutionDetails: true });
      const second = session.events({ includeExecutionDetails: true });
      const ordinary = session.events();
      const turn = await session.submit('Lookup');
      try {
        await entered.promise;
        const event = await finished(first);
        expect(event.status).toBe(success ? 'completed' : 'failed');
        expect(event.output?.contentItems).toEqual([
          { type: 'inputText', text: 'post-hook output' },
        ]);
        expect(event.output?.success).toBe(success);
        expect([
          event.sessionId,
          event.turnId,
          event.submissionId,
          event.callId,
        ]).toEqual([
          session.id,
          turn.turnId,
          turn.submissionId,
          'observed-call',
        ]);
        expect(event.output?.applicationData).toEqual({
          privateValue,
          nested: { count: 1 },
        });
        event.output!.applicationData!.nested = 'mutated reader';
        event.output!.contentItems.length = 0;
        expect((await finished(second)).output?.contentItems).toEqual([
          { type: 'inputText', text: 'post-hook output' },
        ]);
        const redacted = await finished(ordinary);
        expect(redacted.output).toBeNull();
        expect(JSON.stringify(redacted)).not.toContain('post-hook output');
      } finally {
        release.resolve();
      }
      const result = await turn.wait();
      expect(result.finalOutput).toBe('done');
      expect(result.applicationToolOutputs).toHaveLength(1);
      expect(result.applicationToolOutputs![0]).toMatchObject({
        callId: 'observed-call',
        turnId: turn.turnId,
        applicationData: { privateValue, nested: { count: 1 } },
      });
      result.applicationToolOutputs![0].applicationData.nested =
        'mutated result';
      expect(turn.applicationToolOutputs[0].applicationData.nested).toEqual({
        count: 1,
      });
      const saved = await session.saveState();
      expect(JSON.stringify(saved)).toContain(privateValue);
      expect(JSON.stringify(nativeCheckpoint(saved))).not.toContain(
        privateValue,
      );
      await session.close();
      await using restored = await agent.session({
        state: parseSessionState(JSON.stringify(saved)),
      });
      expect(
        (await restored.submit('Continue').then((next) => next.wait()))
          .finalOutput,
      ).toBe('cold');
      expect(JSON.stringify(await restored.saveState())).toContain(
        privateValue,
      );
    } finally {
      release.resolve();
      await ModelServer.closeAll();
    }
  },
  30000,
);

nativeIt(
  'omits output when native callback delivery is cancelled',
  async () => {
    const entered = Promise.withResolvers<void>();
    const hold = tool({
      name: 'hold',
      parameters: z.object({}),
      execute: async (_args, context) => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          if (context.signal.aborted) reject(context.signal.reason);
          else
            context.signal.addEventListener(
              'abort',
              () => reject(context.signal.reason),
              { once: true },
            );
        });
        return 'unaccepted callback output';
      },
    });
    const model = new ModelServer([
      [call('hold', {}, { callId: 'cancelled-call' })],
    ]);
    try {
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-cancelled-function-output',
        supportsWebsockets: false,
      });
      await using session = await new Agent({
        instructions: 'Use hold',
        tools: [hold],
        provider,
      }).session();
      const reader = session.events({ includeExecutionDetails: true });
      const turn = await session.submit('Wait');
      await entered.promise;
      await turn.cancel();
      await session.close();
      const events = (await Array.fromAsync(reader)).filter(
        (e) => e.type === 'tool_finished',
      );
      expect(events).toHaveLength(1);
      expect(events[0].status).toBe('cancelled');
      expect(events[0].output).toBeNull();
    } finally {
      await ModelServer.closeAll();
    }
  },
  30000,
);
