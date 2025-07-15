import { Agent, run, RunContext, tool } from '@openai/agents';
import { z } from '@openai/zod';

interface UserInfo {
  name: string;
  uid: number;
}

const fetchUserAge = tool({
  name: 'fetch_user_age',
  description: 'Return the age of the current user',
  parameters: z.object({}),
  execute: async (
    _args,
    runContext?: RunContext<UserInfo>,
  ): Promise<string> => {
    return `User ${runContext?.context.name} is 47 years old`;
  },
});

async function main() {
  const userInfo: UserInfo = { name: 'John', uid: 123 };

  const agent = new Agent<UserInfo>({
    name: 'Assistant',
    tools: [fetchUserAge],
  });

  const result = await run(agent, 'What is the age of the user?', {
    context: userInfo,
  });

  console.log(result.finalOutput);
  // The user John is 47 years old.
}

if (require.main === module) {
  main().catch(console.error);
}
