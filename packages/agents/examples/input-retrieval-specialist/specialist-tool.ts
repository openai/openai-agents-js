import { Agent, tool, type ToolContext } from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { z } from 'zod';

export interface Catalog {
  readonly title: string;
}
export const summarySchema = z.strictObject({ title: z.string().max(240) });
export type Summary = z.infer<typeof summarySchema>;
export interface Application {
  readonly specialist: Agent<Catalog, Summary>;
  readonly catalog: Catalog;
}
export const readCatalog = tool({
  name: 'read_catalog',
  description: 'Read the application-supplied catalog title.',
  parameters: z.strictObject({}),
  execute: async (_args, { context }: ToolContext<Catalog>) => context.title,
});

export const consult = tool({
  name: 'consult',
  description: 'Ask the separately configured catalog specialist.',
  parameters: z.strictObject({ question: z.string() }),
  execute: async (
    { question },
    { context, signal }: ToolContext<Application>,
  ) => {
    signal.throwIfAborted();
    await using session = await context.specialist.session({
      context: context.catalog,
    });
    signal.throwIfAborted();
    const aborted = Promise.withResolvers<never>();
    const abort = () => aborted.reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try {
      // Disposal stops the owned Turn and joins cleanup if this wait is aborted.
      const result = session.submit(question).then((turn) => turn.wait());
      return (await Promise.race([result, aborted.promise])).finalOutput;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  },
});

export async function runExample() {
  return withScriptedResponses(
    [
      [toolCall('consult', { question: 'Read title.' }, { callId: 'consult' })],
      [text('Done.')],
    ],
    (outer) =>
      withScriptedResponses(
        [
          [toolCall('read_catalog', {}, { callId: 'catalog' })],
          [text('{"title":"Synthetic catalog"}')],
        ],
        async (inner) => {
          const specialist = new Agent<Catalog, Summary>({
            instructions: 'Read the catalog with the declared tool.',
            tools: [readCatalog],
            outputType: summarySchema,
            provider: inner.provider,
          });
          await new Agent<Application>({
            instructions: 'Consult the specialist.',
            tools: [consult],
            provider: outer.provider,
          }).run('Consult.', {
            context: { specialist, catalog: { title: 'Synthetic catalog' } },
          });
          return {
            summary: JSON.parse(outer.toolOutput('consult')!),
            catalog: inner.toolOutput('catalog'),
          };
        },
      ),
  );
}
if (typeof require !== 'undefined' && require.main === module) {
  runExample().then(console.log, (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
