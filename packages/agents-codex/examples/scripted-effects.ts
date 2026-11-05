import assert from 'node:assert/strict';
import { Agent, tool, type ToolContext } from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { z } from 'zod';

export interface SyntheticLedger {
  keys: Set<string>;
}

export const recordSynthetic = tool({
  name: 'record',
  description: 'Record a synthetic key in the application ledger.',
  parameters: z.strictObject({ key: z.string() }),
  execute: ({ key }, { context }: ToolContext<SyntheticLedger>) => {
    // Set insertion deduplicates this fake effect within one process only.
    context.keys.add(key);
    return 'recorded';
  },
});

/** Exercise real native tool plumbing with prescribed model output and no API key. */
export async function runScriptedEffects() {
  const ledger: SyntheticLedger = { keys: new Set() };
  return withScriptedResponses(
    [
      [toolCall('record', { key: 'synthetic-a' }, { callId: 'first' })],
      [toolCall('record', { key: 'synthetic-a' }, { callId: 'repeat' })],
      [text('Recorded once.')],
    ],
    async (peer) => {
      const agent = new Agent<SyntheticLedger>({
        instructions: 'Use record for each requested key.',
        model: 'gpt-5.5',
        provider: peer.provider,
        tools: [recordSynthetic],
      });
      const result = await agent.run('Record the synthetic key.', {
        context: ledger,
      });
      assert.equal(peer.toolOutput('first'), 'recorded');
      assert.equal(peer.toolOutput('repeat'), 'recorded');
      assert.deepEqual([...ledger.keys], ['synthetic-a']);
      return result.finalOutput;
    },
  );
}

if (typeof require !== 'undefined' && require.main === module) {
  runScriptedEffects().then(console.log, (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
