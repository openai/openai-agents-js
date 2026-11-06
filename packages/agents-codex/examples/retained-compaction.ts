import assert from 'node:assert/strict';
import { Agent, parseSessionState } from '@openai/agents';
import { text, withScriptedResponses } from '@openai/agents/testing';

export async function retainContextAcrossRestore() {
  const original = 'My delivery window is Tuesday morning.';
  const summary = 'The user is arranging a delivery.';
  return withScriptedResponses(
    [[text('I recorded the delivery window.')], [text('Tuesday morning.')]],
    async (peer) => {
      const agent = new Agent({
        instructions: 'Help the user arrange a delivery.',
        provider: peer.provider,
      });
      const state = await (async () => {
        await using session = await agent.session();
        const turn = await session.submit(original);
        await turn.wait();

        const snapshot = await session.modelContext();
        const userIndex = snapshot.items.findIndex(
          (item) => item.type === 'message' && item.role === 'user',
        );
        assert(userIndex >= 0);
        await session.compact({ summary, snapshot, retain: [userIndex] });
        assert.equal(peer.requests.length, 1);
        return parseSessionState(JSON.stringify(await session.saveState()));
      })();

      await using restored = await agent.session({ state });
      const turn = await restored.submit('What is my delivery window?');
      const result = await turn.wait();
      const input = JSON.stringify(peer.requests[1].input);
      assert(input.includes(original));
      assert(input.includes(summary));
      assert(!input.includes('I recorded the delivery window.'));
      return result.finalOutput;
    },
  );
}

if (typeof require !== 'undefined' && require.main === module) {
  retainContextAcrossRestore().then(console.log, (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
