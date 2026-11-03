import {
  Agent,
  tool,
  type NativeProvider,
  type ToolContext,
} from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { z } from 'zod';

export interface Passage {
  readonly tenant: string;
  readonly sourceId: string;
  readonly passage: string;
}
export const corpus: readonly Passage[] = [
  {
    tenant: 'acme',
    sourceId: 'acme-hours',
    passage: 'The Acme library opens at 09:00 on weekdays.',
  },
  {
    tenant: 'acme',
    sourceId: 'acme-returns',
    passage: 'The Acme return window is 14 days.',
  },
  {
    tenant: 'other',
    sourceId: 'other-code',
    passage: 'The Other library access code is SYNTHETIC-42.',
  },
];
interface SearchScope {
  tenant: string;
  corpus: readonly Passage[];
  retrieved: Map<string, string>;
}
const answerSchema = z.strictObject({
  answer: z.string(),
  sourceIds: z.array(z.string()),
  found: z.boolean(),
});

export async function answerQuestion(
  question: string,
  tenant: string,
  passages: readonly Passage[],
  provider: NativeProvider,
) {
  const scope: SearchScope = { tenant, corpus: passages, retrieved: new Map() };
  const search = tool({
    name: 'search',
    description: 'Find up to two passages in the current tenant.',
    parameters: z.strictObject({ query: z.string() }),
    execute: async ({ query }, { context }: ToolContext<SearchScope>) => {
      const terms = new Set(query.toLowerCase().split(/\s+/));
      const matches = [];
      for (const entry of context.corpus) {
        if (
          entry.tenant !== context.tenant ||
          !entry.passage
            .toLowerCase()
            .split(/\s+/)
            .some((term) => terms.has(term))
        )
          continue;
        const passage = entry.passage.slice(0, 240);
        matches.push({ sourceId: entry.sourceId, passage });
        context.retrieved.set(entry.sourceId, passage);
        if (matches.length === 2) break;
      }
      return matches;
    },
  });
  const agent = new Agent<SearchScope, z.infer<typeof answerSchema>>({
    instructions:
      'Search before answering. Use only returned passages and cite their sourceIds. If unavailable, set found=false and sourceIds=[].',
    tools: [search],
    outputType: answerSchema,
    provider,
  });
  const answer = (await agent.run(question, { context: scope })).finalOutput;
  if (answer.sourceIds.some((id) => !scope.retrieved.has(id)))
    throw new Error('Answer cites a source not retrieved in this run');
  if (answer.found !== Boolean(answer.sourceIds.length))
    throw new Error(
      'Found answers need sources; absent answers must have none',
    );
  return { answer, retrieved: Object.fromEntries(scope.retrieved) };
}

export async function runExample() {
  return withScriptedResponses(
    [
      [toolCall('search', { query: 'opens' }, { callId: 'search' })],
      [
        text(
          '{"answer":"09:00 on weekdays","sourceIds":["acme-hours"],"found":true}',
        ),
      ],
    ],
    (peer) =>
      answerQuestion(
        'When does the library open?',
        'acme',
        corpus,
        peer.provider,
      ),
  );
}
if (typeof require !== 'undefined' && require.main === module) {
  runExample().then(console.log, (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
