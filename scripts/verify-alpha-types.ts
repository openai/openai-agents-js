import { Agent, NativeProvider, tool } from '@openai/agents';
import * as classic from '@openai/agents/classic';
import {
  ScriptedModel,
  modelResponse,
  assistantMessage,
} from '@openai/agents/classic/testing';
import { z } from 'zod';

const greeting = tool({
  name: 'greeting',
  parameters: z.strictObject({ name: z.string() }),
  execute: ({ name }) => `Hello, ${name.toUpperCase()}!`,
});
const provider = new NativeProvider();
const agent = new Agent<unknown, { count: number }>({
  instructions: 'Return a count.',
  outputType: z.strictObject({ count: z.number() }),
  tools: [greeting],
  provider,
});

async function checkNativeResult() {
  const result = await agent.run('Count the items.');
  const count: number = result.finalOutput.count;
  // @ts-expect-error Structured native output must retain its declared type.
  const wrong: string = result.finalOutput.count;
  return { count, wrong };
}

const model = new ScriptedModel([modelResponse([assistantMessage('hello')])]);
const classicAgent = new classic.Agent({ name: 'Classic', model });
const runner = new classic.Runner({ tracingDisabled: true });
const session = new classic.MemorySession({ sessionId: 'types' });
void checkNativeResult;
void runner.run(classicAgent, 'Hello', { session });
