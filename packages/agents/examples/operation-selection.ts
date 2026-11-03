import {
  Agent,
  NativeProvider,
  ToolOutput,
  tool,
  type NativeProviderOptions,
  type ToolDecision,
} from '@openai/agents';
import { z } from 'zod';

export interface RecordApplication {
  eligible(): boolean;
  approve(signal: AbortSignal): Promise<boolean>;
  create(
    signal: AbortSignal,
  ): string | ToolOutput | Promise<string | ToolOutput>;
  read(signal: AbortSignal): string | Promise<string>;
}

// Application policy for this create-then-read workflow, not an SDK dependency engine.
export function createRecordRecipe(application: RecordApplication) {
  let created = false;
  const canCreate = () => application.eligible() && !created;
  const canRead = () => application.eligible() && created;
  async function approve(
    eligible: () => boolean,
    signal: AbortSignal,
  ): Promise<ToolDecision<Record<string, never>>> {
    signal.throwIfAborted();
    if (!eligible())
      return { action: 'deny', reason: 'Record is not eligible.' };
    const accepted = await application.approve(signal);
    signal.throwIfAborted();
    return accepted && eligible()
      ? { action: 'allow' }
      : {
          action: 'deny',
          reason: 'Record approval or eligibility was refused.',
        };
  }
  const create = tool({
    name: 'create_record',
    parameters: z.object({}),
    result: z.union([z.string(), z.instanceof(ToolOutput)]),
    before: ({ signal }) => approve(canCreate, signal),
    execute(_arguments, { signal }) {
      signal.throwIfAborted();
      if (!canCreate()) throw new Error('Record is no longer eligible.');
      return application.create(signal);
    },
    after(output, { signal }) {
      if (output.success && !signal.aborted) created = true;
      return output;
    },
  });
  const read = tool({
    name: 'read_record',
    parameters: z.object({}),
    result: z.string(),
    before: ({ signal }) => approve(canRead, signal),
    execute(_arguments, { signal }) {
      signal.throwIfAborted();
      if (!canRead()) throw new Error('Record is no longer eligible.');
      return application.read(signal);
    },
  });
  return {
    tools: [create, read],
    beforeStep: () =>
      application.eligible() ? (created ? [read] : [create]) : [],
  };
}

export async function runExample(options: NativeProviderOptions = {}) {
  await using provider = new NativeProvider(options);
  const recipe = createRecordRecipe({
    eligible: () => true,
    // This demo approves its in-memory operations; an application supplies its own decision.
    approve: async () => true,
    create: () => 'created',
    read: () => 'record',
  });
  const agent = new Agent({
    instructions: 'Create the record, then read it.',
    provider,
    tools: recipe.tools,
  });
  await using session = await agent.session();
  const turn = await session.submit('Create and read a record.', {
    tools: recipe.tools,
    beforeStep: recipe.beforeStep,
  });
  return (await turn.wait()).finalOutput;
}

if (typeof require !== 'undefined' && require.main === module) {
  runExample().then(console.log, (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
