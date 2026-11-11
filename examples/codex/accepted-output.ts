import assert from 'node:assert/strict';
import { Agent, NativeError, OutputValidationError } from '@openai/agents';
import {
  text,
  withScriptedResponses,
  type ScriptedResponse,
} from '@openai/agents/testing';
import { z } from 'zod';

const SupportResult = z.strictObject({
  category: z.enum(['billing', 'technical']),
  nextStep: z.string().min(1),
});
type SupportResult = z.infer<typeof SupportResult>;

/** Exercise acceptance through the native loop without model credentials. */
export async function runAcceptedOutput(
  onProgress: (message: string) => void = () => {},
) {
  // These arrays stand in for the application's customer-facing destination.
  const reports: string[] = [];
  const supportResults: SupportResult[] = [];
  const draft = 'Synthetic inventory report: 12 units.';
  const revised = 'Synthetic inventory report: 12 units. Source: fixture A.';

  await withScriptedResponses(
    [draft, revised].map((value, index): ScriptedResponse => {
      const itemId = `report-${index}`;
      return {
        items: [],
        events: [
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              type: 'message',
              role: 'assistant',
              id: itemId,
              content: [],
            },
          },
          {
            type: 'response.output_text.delta',
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            delta: value,
          },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'message',
              role: 'assistant',
              id: itemId,
              content: [{ type: 'output_text', text: value }],
            },
          },
        ],
      };
    }),
    async (peer) => {
      const privateCandidates: string[] = [];
      const agent = new Agent({
        instructions: 'Write an inventory report with a source.',
        provider: peer.provider,
        beforeComplete: (context) => {
          // Candidate text stays private, including the proposal being rejected.
          privateCandidates.push(context.text ?? '');
          onProgress('Checking the report.');
          if (context.text?.includes('Source: fixture A.')) return;
          if (context.continuationCount >= 1) {
            return { action: 'stop' };
          }
          onProgress('Revising the report.');
          return {
            action: 'continue',
            instructions: 'Add the source: fixture A.',
          };
        },
      });
      await using session = await agent.session();
      onProgress('Preparing the report.');
      const turn = await session.submit(
        'Report the synthetic inventory count.',
      );
      const privateDeltas: string[] = [];
      for await (const event of turn.events()) {
        // Raw observations never enter onProgress or the publication destination.
        if (event.type === 'output_text_delta') privateDeltas.push(event.delta);
        if (event.type === 'gap')
          throw new Error('Private report observations lost');
      }
      const result = await turn.wait();
      // Real applications can apply additional authorization or content checks here.
      assert.equal(result.finalOutput, revised);
      reports.push(result.finalOutput);
      onProgress('Report ready.');
      assert.deepEqual(privateCandidates, [draft, revised]);
      assert.ok(privateDeltas.includes(draft));
      assert.ok(!reports.includes(draft));
      assert.deepEqual(reports, [revised]);
      assert.equal(peer.requests.length, 2);
    },
  );

  const support = {
    category: 'billing' as const,
    nextStep: 'Ask the synthetic account owner to review the duplicate charge.',
  };
  await withScriptedResponses(
    [[text(JSON.stringify(support))]],
    async (peer) => {
      const agent = new Agent({
        instructions: 'Classify a support ticket and propose a next step.',
        provider: peer.provider,
        outputType: SupportResult,
      });
      await using session = await agent.session();
      onProgress('Checking the support result.');
      const turn = await session.submit('Synthetic ticket: duplicate charge.');
      const result = await turn.wait();
      // Application checks follow the SDK's schema validation.
      assert.equal(result.finalOutput.category, 'billing');
      supportResults.push(result.finalOutput);
      onProgress('Support result ready.');
    },
  );

  // Each case has its own Session and a fresh publication destination.
  for (const scenario of [
    'rejected',
    'cancelled',
    'invalid',
    'unapproved',
  ] as const) {
    const published: SupportResult[] = [];
    const entered = Promise.withResolvers<void>();
    const candidate =
      scenario === 'invalid' ? '{"category":42}' : JSON.stringify(support);
    await withScriptedResponses([[text(candidate)]], async (peer) => {
      const agent = new Agent({
        instructions: 'Classify the synthetic support ticket.',
        provider: peer.provider,
        outputType: SupportResult,
        beforeComplete: async (context) => {
          if (scenario === 'rejected') {
            return { action: 'stop' };
          }
          if (scenario === 'cancelled') {
            entered.resolve();
            // Hold this synthetic check until the caller cancels the Turn.
            await new Promise<void>((resolve) => {
              if (context.signal.aborted) resolve();
              else
                context.signal.addEventListener('abort', () => resolve(), {
                  once: true,
                });
            });
          }
        },
      });
      await using session = await agent.session();
      const turn = await session.submit('Synthetic ticket: duplicate charge.');
      const publication = (async () => {
        const result = await turn.wait();
        // A valid result still needs the application's current authorization.
        const approved = scenario !== 'unapproved';
        if (!approved) throw new Error('Application approval missing');
        published.push(result.finalOutput);
      })();
      const rejected = assert.rejects(publication, (error: unknown) => {
        if (scenario === 'invalid')
          return error instanceof OutputValidationError;
        if (scenario === 'rejected') return error instanceof NativeError;
        if (scenario === 'unapproved')
          return (
            error instanceof Error &&
            error.message === 'Application approval missing'
          );
        return error instanceof Error;
      });
      if (scenario === 'cancelled') {
        await Promise.race([
          entered.promise,
          rejected.then(() => {
            throw new Error('Turn ended before the cancellation check');
          }),
        ]);
        await turn.cancel();
      }
      await rejected;
      assert.deepEqual(published, []);
      // Error objects and rejected candidate text stay out of progress messages.
      onProgress(`Support result withheld: ${scenario}.`);
    });
  }
  assert.deepEqual(supportResults, [support]);
  return { reports, supportResults };
}

if (typeof require !== 'undefined' && require.main === module) {
  runAcceptedOutput(console.log).then(
    (accepted) => console.log(JSON.stringify(accepted, null, 2)),
    () => {
      console.error('Accepted-output example failed.');
      process.exitCode = 1;
    },
  );
}
