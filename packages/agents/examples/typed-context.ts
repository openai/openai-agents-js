import {
  Agent,
  NativeProvider,
  tool,
  type NativeProviderOptions,
  type ToolContext,
} from '@openai/agents';
import { z } from 'zod';

export interface Account {
  readonly displayName: string;
}
const answerSchema = z.strictObject({ greeting: z.string() });
export type Answer = z.infer<typeof answerSchema>;

/** Keep application context separate from the model-visible tool parameters. */
export async function runTypedContext(
  account: Account,
  options: NativeProviderOptions = {},
): Promise<Answer> {
  await using provider = new NativeProvider(options);
  const accountName = tool({
    name: 'account_name',
    description: 'Read the display name for this account.',
    parameters: z.strictObject({}),
    execute: async (_args, { context }: ToolContext<Account>) =>
      context.displayName,
  });
  const agent = new Agent<Account, Answer>({
    name: 'Account assistant',
    instructions: 'Use account_name, then return a short greeting.',
    tools: [accountName],
    outputType: answerSchema,
    provider,
  });
  const result = await agent.run('Greet this account.', { context: account });
  return result.finalOutput;
}

if (typeof require !== 'undefined' && require.main === module) {
  runTypedContext(
    { displayName: 'Ada' },
    { baseUrl: process.env.OPENAI_BASE_URL },
  ).then(
    (answer) => console.log(answer.greeting),
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
