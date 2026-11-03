import { Agent, tool } from '@openai/agents/classic';
import {
  ScriptedModel,
  assistantMessage,
  modelResponse,
} from '@openai/agents/classic/testing';
import { SDKRunner, MigrationCleanupError } from '@openai/agents/migration';
import { z } from 'zod';

/** Run a scripted classic Model through the native loop without API credentials. */
export async function runMigration() {
  const agent = new Agent({
    name: 'Migration example',
    instructions: 'Answer with plain text.',
    model: new ScriptedModel([
      modelResponse([assistantMessage('Hello from the native loop.')]),
    ]),
    modelSettings: {},
    tools: [
      tool({
        name: 'echo',
        description: 'Repeat text.',
        parameters: z.object({ text: z.string() }),
        execute: ({ text }) => text,
      }),
    ],
  });

  try {
    const result = await SDKRunner.run(agent, 'Say hello.', {
      context: undefined,
    });
    console.log(result.finalOutput, result.native.sessionId);
  } catch (error) {
    if (error instanceof MigrationCleanupError) await error.retryCleanup();
    throw error;
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  runMigration().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
