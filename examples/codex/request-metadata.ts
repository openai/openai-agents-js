import assert from 'node:assert/strict';
import {
  Agent,
  tool,
  type ModelRequestDispatching,
  type ModelResponseLinked,
  type RecordedResponse,
} from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { z } from 'zod';

/** Compare public request observations with the scripted wire and retained history. */
export async function inspectRequestMetadata() {
  return withScriptedResponses(
    [
      [toolCall('lookup', { code: 'A' }, { callId: 'lookup-A' })],
      [text('violet')],
    ],
    async (peer) => {
      const agent = new Agent({
        instructions: 'Look up the requested code and return its color.',
        model: 'gpt-5.5',
        modelSettings: {
          reasoningEffort: 'low',
          reasoningSummary: 'concise',
          serviceTier: 'flex',
        },
        provider: peer.provider,
        tools: [
          tool({
            name: 'lookup',
            parameters: z.object({ code: z.literal('A') }),
            execute: () => 'violet',
          }),
        ],
      });
      await using session = await agent.session();
      const turn = await session.submit('Look up A.');
      const dispatches: ModelRequestDispatching[] = [];
      const links: ModelResponseLinked[] = [];
      let gap = false;
      const reader = turn.events();
      const reading = (async () => {
        for await (const event of reader) {
          if (event.type === 'gap') gap = true;
          if (event.type === 'model_request_dispatching')
            dispatches.push(event);
          if (event.type === 'model_response_linked') links.push(event);
        }
      })();
      // Keep both rejection paths observed until their owners finish.
      void reading.catch(() => {});
      try {
        const result = await turn.wait();
        await reading;
        assert.equal(result.finalOutput, 'violet');
      } finally {
        await reader.return?.();
        await reading;
      }

      // Small fixtures fit the bounded suffix. Production consumers must handle gaps.
      assert.equal(gap, false);
      assert.equal(dispatches.length, 2);
      assert.equal(links.length, 2);
      const responses: RecordedResponse[] = [];
      for await (const recorded of session.turns())
        responses.push(...(recorded.responses ?? []));
      const joined = links.map((link) => {
        const request = dispatches.find(
          (item) => item.requestId === link.requestId,
        );
        const response = responses.find(
          (item) => item.id === link.responseObservationId,
        );
        assert(
          request && response,
          'Expected a request/response occurrence join.',
        );
        assert.equal(request.threadId, session.id);
        assert.equal(request.turnId, turn.turnId);
        assert.equal(response.turnId, link.turnId);
        return {
          requestId: request.requestId,
          responseObservationId: response.id,
        };
      });
      for (const [index, event] of dispatches.entries()) {
        const wire = peer.requests[index];
        assert.equal(event.model, wire.model);
        assert.equal(event.reasoningEffort, 'low');
        assert.equal(event.reasoningSummary, 'concise');
        assert.equal(event.serviceTier, wire.service_tier);
        assert.equal(event.transport, 'http_sse');
      }
      assert.equal(new Set(dispatches.map((item) => item.requestId)).size, 2);
      return { dispatches, joined };
    },
  );
}

if (typeof require !== 'undefined' && require.main === module) {
  inspectRequestMetadata().then(
    (summary) =>
      console.log(
        JSON.stringify(summary, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      ),
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
