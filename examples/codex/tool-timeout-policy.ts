import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent, ToolTimeoutError, tool } from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { z } from 'zod';

/** Let the model recover from a callback deadline without undoing earlier effects. */
export async function runToolTimeoutPolicyExample() {
  const effects: string[] = [];
  return withScriptedResponses(
    [
      [toolCall('slow_lookup', {}, { callId: 'lookup-deadline' })],
      [text('The lookup timed out. Please try another source.')],
    ],
    async (peer) => {
      const lookup = tool({
        name: 'slow_lookup',
        parameters: z.strictObject({}),
        callbackTimeout: 0.02,
        timeoutBehavior: 'error_as_result',
        async execute(_, context) {
          effects.push('lookup started');
          // Use the same signal with cancellable network or storage operations.
          try {
            await delay(1_000, undefined, { signal: context.signal });
            return 'lookup completed';
          } finally {
            effects.push('cleanup finished');
          }
        },
        timeoutErrorFunction(context, error) {
          assert(error instanceof ToolTimeoutError);
          assert.equal(context.signal.aborted, false);
          assert.deepEqual(effects, ['lookup started', 'cleanup finished']);
          return `${error.toolName} timed out after ${error.timeoutSeconds} seconds.`;
        },
      });
      const agent = new Agent({
        instructions: 'Use slow_lookup and explain any failure.',
        provider: peer.provider,
        tools: [lookup],
      });
      const result = await agent.run('Look it up.');
      const failureText = peer.toolOutput('lookup-deadline');
      assert.equal(failureText, 'slow_lookup timed out after 0.02 seconds.');
      assert.deepEqual(effects, ['lookup started', 'cleanup finished']);
      return { finalOutput: result.finalOutput, failureText, effects };
    },
  );
}

if (typeof require !== 'undefined' && require.main === module) {
  runToolTimeoutPolicyExample().then(
    (result) => console.log(result),
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
