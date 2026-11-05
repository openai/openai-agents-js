import assert from 'node:assert/strict';
import { Agent, tool, type ToolContext } from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { z } from 'zod';

/** Two Sessions share this application-owned, event-loop-local quota. */
export async function runConcurrentTools() {
  const quota = { remaining: 1, ledger: [] as string[], denied: 0 };
  const ready = Promise.withResolvers<void>();
  let arrived = 0;
  const reserve = tool({
    name: 'reserve',
    description: 'Reserve one unit for the authenticated caller.',
    parameters: z.strictObject({}),
    execute: async (
      _,
      { context, signal }: ToolContext<{ userId: string }>,
    ) => {
      if (++arrived === 2) ready.resolve();
      const abort = () => ready.reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        await ready.promise;
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener('abort', abort);
      }
      // No await separates checking, spending and recording the effect.
      if (quota.remaining === 0) {
        quota.denied++;
        return 'full';
      }
      quota.remaining--;
      quota.ledger.push(context.userId);
      return 'reserved';
    },
  });
  return withScriptedResponses(
    [[toolCall('reserve', {}, { callId: 'left' })], [text('Done.')]],
    (left) =>
      withScriptedResponses(
        [[toolCall('reserve', {}, { callId: 'right' })], [text('Done.')]],
        async (right) => {
          await using first = await new Agent<{ userId: string }>({
            instructions: 'Reserve one unit.',
            tools: [reserve],
            provider: left.provider,
          }).session({ context: { userId: 'alice' } });
          await using second = await new Agent<{ userId: string }>({
            instructions: 'Reserve one unit.',
            tools: [reserve],
            provider: right.provider,
          }).session({ context: { userId: 'bob' } });
          const turns = await Promise.all([
            first.submit('Reserve.'),
            second.submit('Reserve.'),
          ]);
          await Promise.all(
            turns.map((turn) =>
              turn.wait({
                until: 'request',
                signal: AbortSignal.timeout(10_000),
              }),
            ),
          );
          const outputs = [left.toolOutput('left'), right.toolOutput('right')];
          assert.equal(quota.remaining, 0);
          assert.equal(quota.ledger.length, 1);
          assert.equal(quota.denied, 1);
          assert.deepEqual(outputs.toSorted(), ['full', 'reserved']);
          return { ...quota, outputs };
        },
      ),
  );
}

if (typeof require !== 'undefined' && require.main === module) {
  runConcurrentTools().then(
    (result) => console.log(JSON.stringify(result)),
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
