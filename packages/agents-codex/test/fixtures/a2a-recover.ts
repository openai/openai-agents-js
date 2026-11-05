import { ServerCallContext } from '@a2a-js/sdk/server';
import { Task } from '@a2a-js/sdk';
import { NativeA2AExecutor } from '../../src/a2a/executor';
import { FileA2AStore } from '../a2a-store';

async function main() {
  const [path, taskId, contextId] = process.argv.slice(2);
  const context = new ServerCallContext({
    user: { isAuthenticated: true, userName: 'user' },
    requestedVersion: '1.0',
  });
  const store = new FileA2AStore(path);
  let executions = 0;
  const executor = new NativeA2AExecutor({
    store,
    agentFactory: async () => {
      executions++;
      throw new Error('Recovery must not execute');
    },
  });
  await executor.recover(
    { tenant: '', principal: 'user', taskId, contextId },
    context,
  );
  console.log(
    JSON.stringify({
      executions,
      task: Task.toJSON((await store.load(taskId, context))!),
      record: store.record(taskId, context),
    }),
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
