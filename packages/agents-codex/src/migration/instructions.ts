import type { Agent, RunContext } from '@openai/agents-core';

/** Resolve trusted SDK instructions within the caller's awaited operation. */
export async function resolveInstructions<Context>(
  agent: Agent<Context, any>,
  context: RunContext<Context>,
  signal: AbortSignal,
): Promise<string | undefined> {
  signal.throwIfAborted();
  const instructions = await agent.getSystemPrompt(context);
  signal.throwIfAborted();
  if (instructions !== undefined && typeof instructions !== 'string')
    throw new TypeError('Migration instructions must be a string or undefined');
  return instructions;
}
