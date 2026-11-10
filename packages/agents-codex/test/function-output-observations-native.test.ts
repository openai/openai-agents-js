import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  ToolOutput,
  tool,
  type ObservedEvent,
} from '../src';
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
        ),
    });
    const model = new ModelServer([
      [call('lookup', {}, { callId: 'observed-call' })],
      async (request) => {
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
    ]);
    try {
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-function-output',
        supportsWebsockets: false,
      });
      await using session = await new Agent({
        instructions: 'Use lookup',
        tools: [lookup],
        provider,
      }).session();
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
      expect((await turn.wait()).finalOutput).toBe('done');
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
