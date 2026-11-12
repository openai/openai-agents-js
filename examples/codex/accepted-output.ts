import assert from 'node:assert/strict';
import {
  Agent,
  NativeError,
  OutputValidationError,
  tool,
} from '@openai/agents';
import {
  text,
  toolCall,
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

async function runAcceptedSections() {
  // Later sections cannot change facts already checked for an earlier section.
  const expected = [
    ['inventory', '7 units available'],
    ['dispatch', '2 orders packed'],
    ['delivery', 'Delivery unconfirmed'],
  ] as const;
  const published: (typeof expected)[number][] = [];
  await withScriptedResponses(
    [
      [text('7 units available')],
      [text('2 orders packed')],
      [text('All orders delivered')],
    ],
    async (peer) => {
      const agent = new Agent({
        instructions: 'Report one section at a time.',
        provider: peer.provider,
      });
      await using session = await agent.session();
      for (const [index, entry] of expected.entries()) {
        assert.deepEqual(published, expected.slice(0, index));
        assert.equal(peer.requests.length, index);
        const [section, verifiedText] = entry;
        const turn = await session.submit(
          `Report the verified ${section} facts.`,
        );
        const result = await turn.wait();
        if (result.finalOutput !== verifiedText) {
          console.log(`Section withheld: ${section}.`);
          break;
        }
        published.push(entry);
        console.log(`Accepted ${section}: ${verifiedText}`);
      }
      assert.equal(peer.requests.length, expected.length);
    },
  );
  assert.deepEqual(published, expected.slice(0, 2));
}

async function main() {
  const accepted = await runAcceptedOutput(console.log);
  await runAcceptedSections();
  await runSameTurnSections();
  console.log(JSON.stringify(accepted, null, 2));
}

async function runSameTurnSections() {
  const published = new Map<string, string>();
  const privateCandidates: string[] = [];
  const facts = {
    inventory: '7 units available',
    delivery: 'Delivery unconfirmed',
  };
  const publishSection = tool({
    name: 'publish_section',
    description:
      'The application has been checking and publishing one independent section.',
    parameters: z.strictObject({
      section: z.enum(['inventory', 'delivery']),
      content: z.string(),
    }),
    execute({ section, content }) {
      // Trusted application facts have been governing publication.
      if (content !== facts[section]) return 'Section withheld.';
      published.set(section, content);
      return 'Section published.';
    },
  });
  await withScriptedResponses(
    [
      [
        toolCall(
          'publish_section',
          { section: 'inventory', content: '7 units available' },
          { callId: 'accepted-section' },
        ),
      ],
      () => {
        // The peer has been checking delivery before its next generation response.
        assert.deepEqual([...published], [['inventory', '7 units available']]);
        return [
          toolCall(
            'publish_section',
            { section: 'delivery', content: 'All orders delivered' },
            { callId: 'rejected-section' },
          ),
        ];
      },
      () => {
        assert.deepEqual([...published], [['inventory', '7 units available']]);
        return [text('Provisional summary: all orders delivered.')];
      },
    ],
    async (peer) => {
      const agent = new Agent({
        instructions:
          'You have been publishing independently verified sections with publish_section.',
        provider: peer.provider,
        tools: [publishSection],
        beforeComplete(context) {
          privateCandidates.push(context.text ?? '');
          return { action: 'stop' };
        },
      });
      await using session = await agent.session();
      const turn = await session.submit(
        'I have been requesting inventory and delivery facts.',
      );
      await assert.rejects(turn.wait(), NativeError);
      assert.equal(peer.requests.length, 3);
      assert.equal(peer.toolOutput('accepted-section'), 'Section published.');
      assert.equal(peer.toolOutput('rejected-section'), 'Section withheld.');
    },
  );
  assert.deepEqual(privateCandidates, [
    'Provisional summary: all orders delivered.',
  ]);
  assert.deepEqual([...published], [['inventory', '7 units available']]);
  console.log('Same-turn application publication:', published);
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch(() => {
    console.error('Accepted-output example failed.');
    process.exitCode = 1;
  });
}
