import { z } from 'zod';
import { Agent, NativeProvider, manualTool } from '../../src/index';
import { NativeA2AExecutor } from '../../src/a2a/executor';
import { FileA2AStore } from '../a2a-store';
import { AgentCard, Message, Part, Role, Task } from '@a2a-js/sdk';
import { DefaultRequestHandler, ServerCallContext } from '@a2a-js/sdk/server';

async function main() {
  const [path, baseUrl, taskId, contextId, challenge, generation] =
    process.argv.slice(2);
  const store = new FileA2AStore(path);
  const decision = manualTool({
    name: 'decision',
    description: 'Choose.',
    parameters: z.strictObject({}),
    result: z.boolean(),
  });
  const agent = new Agent({
    instructions: 'Ask for a decision.',
    model: 'gpt-5.5',
    provider: new NativeProvider({ baseUrl, apiKey: 'scripted-test-key' }),
    tools: [decision],
  });
  const executor = new NativeA2AExecutor({
    store,
    agentFactory: async () => ({ agent, context: undefined }),
  });
  const handler = new DefaultRequestHandler(
    AgentCard.fromJSON({ name: 'native', version: '1' }),
    store,
    executor,
  );
  const context = new ServerCallContext({
    user: { isAuthenticated: true, userName: 'user' },
    requestedVersion: '1.0',
  });
  const result = await handler.sendMessage(
    {
      tenant: '',
      metadata: undefined,
      configuration: undefined,
      message: {
        ...Message.fromJSON({}),
        messageId: 'fresh-worker-reply',
        role: Role.ROLE_USER,
        taskId,
        contextId,
        parts: [
          Part.fromJSON({
            data: {
              challenge,
              generation: Number(generation),
              result: true,
            },
          }),
        ],
      },
    },
    context,
  );
  if (!('id' in result)) throw new Error('Expected task');
  console.log(
    JSON.stringify({
      task: Task.toJSON(result),
      state: store.record(taskId, context)?.state,
    }),
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
