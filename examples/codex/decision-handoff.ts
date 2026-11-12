import assert from 'node:assert/strict';
import { Agent, DecisionHandoff } from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';

async function main() {
  await withScriptedResponses(
    [
      [
        toolCall(
          'route_issue',
          { input: 'Disputed charge' },
          { callId: 'route' },
        ),
      ],
      [text('The billing specialist has been handling the synthetic dispute.')],
    ],
    async (peer) => {
      const billing = new Agent({ instructions: 'BILLING_ONLY' });
      const technical = new Agent({ instructions: 'TECHNICAL_ONLY' });
      let choices = 0;
      const router = new Agent({
        instructions: 'Invoke route_issue with explicit routing input.',
        model: 'gpt-5.5',
        provider: peer.provider,
        decisions: {
          async getDecision(request) {
            assert.equal(request.input, 'Disputed charge');
            choices++;
            return { value: 'billing' };
          },
        },
        handoffs: [
          new DecisionHandoff({
            name: 'route_issue',
            description: 'Transfer to a captured specialist.',
            question: 'Which specialist has been handling this request?',
            targets: { billing, technical },
          }),
        ],
      });
      await using session = await router.session();
      const result = await (await session.submit('Begin')).wait();
      assert.equal(await session.getActiveAgent(), billing);
      assert.equal(choices, 1);
      assert.equal(peer.requests.length, 2);
      assert(peer.requests.every((request) => request.model === 'gpt-5.5'));
      assert(JSON.stringify(peer.requests[1].input).includes('BILLING_ONLY'));
      assert(
        !JSON.stringify(peer.requests[1].input).includes('TECHNICAL_ONLY'),
      );
      peer.assertExhausted();
      console.log(result.finalOutput);
    },
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
