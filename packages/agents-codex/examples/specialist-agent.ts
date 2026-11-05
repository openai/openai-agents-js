import assert from 'node:assert/strict';
import { Agent, tool, type ToolContext } from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { z } from 'zod';

export interface Catalog {
  readonly title: string;
}
export const summarySchema = z.strictObject({ title: z.string() });
export type Summary = z.infer<typeof summarySchema>;
export interface Consultation {
  readonly specialist: Agent<Catalog, Summary>;
  readonly catalog: Catalog;
}

export const readCatalog = tool({
  name: 'read_catalog',
  description: 'Read the selected catalog title.',
  parameters: z.strictObject({}),
  execute: (_args, { context }: ToolContext<Catalog>) => context.title,
});

/** Own one independent specialist Session, including cancellation and cleanup. */
export async function consultSpecialist(
  { specialist, catalog }: Consultation,
  signal: AbortSignal,
): Promise<Summary> {
  signal.throwIfAborted();
  // Opening has no public abort option. Await it even if the outer tool stops.
  const session = await specialist.session({ context: catalog });
  let closing: Promise<void> | undefined;
  const close = () => {
    if (!closing) {
      closing = session.close();
      // The listener starts cleanup; the disposer below joins and rethrows it.
      void closing.catch(() => {});
    }
    return closing;
  };
  await using _owned = { [Symbol.asyncDispose]: close };
  const onAbort = () => {
    void close();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    // Covers cancellation during opening or before listener registration.
    signal.throwIfAborted();
    const turn = await session.submit(
      'Read the selected catalog and summarize.',
    );
    // Preserve inner failures, including its own cancellation error. The outer
    // Turn can report that distinct error as callback cleanup failure.
    const result = await turn.wait();
    signal.throwIfAborted();
    return result.finalOutput;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export const consult = tool({
  name: 'consult',
  description: 'Ask the catalog specialist for a typed summary.',
  parameters: z.strictObject({}),
  result: summarySchema,
  execute: (_args, { context, signal }: ToolContext<Consultation>) =>
    consultSpecialist(context, signal),
});

/** Run two real Agents with independent scripted providers and no API key. */
export async function runSpecialistExample() {
  return withScriptedResponses(
    [
      [toolCall('consult', {}, { callId: 'consult' })],
      [text('Violet catalog.')],
    ],
    async (outerPeer) =>
      withScriptedResponses(
        [
          [toolCall('read_catalog', {}, { callId: 'catalog' })],
          [text('{"title":"Violet catalog"}')],
        ],
        async (innerPeer) => {
          const specialist = new Agent<Catalog, Summary>({
            name: 'Catalog specialist',
            instructions: 'Read the catalog, then return its title as JSON.',
            model: 'gpt-5.5',
            provider: innerPeer.provider,
            tools: [readCatalog],
            outputType: summarySchema,
          });
          const outer = new Agent<Consultation>({
            instructions: 'Use consult, then give the catalog title.',
            model: 'gpt-5.5',
            provider: outerPeer.provider,
            tools: [consult],
          });
          // Select a new value rather than forwarding the whole application context.
          const application = {
            selectedTitle: 'Violet catalog',
            privateNote: 'synthetic-outer-only-note',
          };
          const context = {
            specialist,
            catalog: Object.freeze({ title: application.selectedTitle }),
            privateNote: application.privateNote,
          };
          const result = await outer.run('Consult the catalog specialist.', {
            context,
          });
          assert.equal(
            innerPeer.toolOutput('catalog'),
            application.selectedTitle,
          );
          const summary = summarySchema.parse(
            JSON.parse(outerPeer.toolOutput('consult')!),
          );
          assert.deepEqual(summary, { title: application.selectedTitle });
          const specialistInput = JSON.stringify(innerPeer.requests);
          assert(!specialistInput.includes(application.privateNote));
          assert(!specialistInput.includes('"name":"consult"'));
          return { answer: result.finalOutput, summary };
        },
      ),
  );
}

if (typeof require !== 'undefined' && require.main === module) {
  runSpecialistExample().then(console.log, (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
