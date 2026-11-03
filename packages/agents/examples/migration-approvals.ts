import { Agent, setTracingDisabled, tool } from '@openai/agents/classic';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
} from '@openai/agents/classic/testing';
import { MigrationCleanupError, SDKRunner } from '@openai/agents/migration';
import { z } from 'zod';

/** One in-process consent decision over an actual native-held function call. */
export async function runHeldFunction(allow: boolean) {
  setTracingDisabled(true);
  let effects = 0;
  const context = { account: 'example-account' };
  const model = new ScriptedModel([
    modelResponse([functionCall('lookup', '{}', { callId: 'example-call' })]),
    modelResponse([
      assistantMessage(allow ? 'Lookup completed.' : 'Lookup declined.'),
    ]),
  ]);
  const lookup = tool({
    name: 'lookup',
    description: 'Read this example account.',
    parameters: z.object({}),
    needsApproval: true,
    execute: () => {
      effects++;
      return 'Example record';
    },
  });
  const agent = new Agent({ name: 'Consent example', tools: [lookup], model });
  const controller = new AbortController();
  const first = await SDKRunner.run(agent, 'Look up the example account.', {
    context,
    signal: controller.signal,
    approvals: 'manual',
  });
  if (!('status' in first)) throw new Error('Expected a held call');
  try {
    if (effects !== 0) throw new Error('Tool executed before consent');
    const [item] = first.interruptions;
    // Show the actual request to the user, then apply their explicit decision.
    // A saved description or copied item is not live approval authority.
    if (allow) first.approve(item);
    else first.reject(item);
    const result = await first.continue();
    model.assertComplete();
    return { finalOutput: result.finalOutput, effects };
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled([first.completed]);
    if (error instanceof MigrationCleanupError) await error.retryCleanup();
    throw error;
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  runHeldFunction(process.argv[2] !== 'reject')
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
