import type { Session } from '@openai/agents';

/** Run one command on the caller's configured Session and retain its receipt. */
export async function runEmbeddedCommand<Output, Context>(
  session: Session<Output, Context>,
  input: string,
) {
  const receipt = await session.executeCommand(input);
  if (receipt.command === 'compact' || receipt.command === 'review') {
    const completed = await receipt.turn.wait();
    return { receipt, completed };
  }
  return { receipt };
}
