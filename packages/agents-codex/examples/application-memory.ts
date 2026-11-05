import {
  Agent,
  NativeProvider,
  tool,
  type NativeProviderOptions,
  type ToolContext,
} from '@openai/agents';
import { z } from 'zod';

/** The application supplies its own asynchronous memory API. */
export interface ApplicationMemory {
  readNote(tenantId: string, key: string): Promise<string | undefined>;
}

export interface MemoryContext {
  readonly tenantId: string;
  readonly memory: ApplicationMemory;
}

export const readMemory = tool({
  name: 'read_memory',
  description: 'Read a note from the current application memory scope.',
  parameters: z.strictObject({ key: z.string() }),
  execute: async ({ key }, { context }: ToolContext<MemoryContext>) =>
    (await context.memory.readNote(context.tenantId, key)) ??
    'No saved note for that key.',
});

/** Read the selected note with the tenant chosen by the application. */
export async function runMemoryNote(
  context: MemoryContext,
  key: string,
  options: NativeProviderOptions = {},
): Promise<string> {
  await using provider = new NativeProvider(options);
  const agent = new Agent<MemoryContext>({
    instructions:
      'Use read_memory to read the requested note, then answer using that note.',
    tools: [readMemory],
    provider,
  });
  const result = await agent.run(
    `Read the saved note with key ${JSON.stringify(key)}.`,
    {
      context,
    },
  );
  return result.finalOutput;
}

// tsx runs these source examples as CommonJS in this checkout.
if (typeof require !== 'undefined' && require.main === module) {
  const notes = new Map([
    [
      'tenant-a',
      new Map([['audience', 'Explain the result in plain language.']]),
    ],
    [
      'tenant-b',
      new Map([['audience', 'Use technical terms for the engineering team.']]),
    ],
  ]);
  const memory: ApplicationMemory = {
    async readNote(tenantId, key) {
      return notes.get(tenantId)?.get(key);
    },
  };
  // Authentication in a real application chooses this tenant before Agent.run.
  runMemoryNote({ tenantId: 'tenant-a', memory }, 'audience', {
    baseUrl: process.env.OPENAI_BASE_URL,
  }).then(
    (answer) => console.log(answer),
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
