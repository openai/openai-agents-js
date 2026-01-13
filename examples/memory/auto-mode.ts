import { Agent, RunResult, run, type Session } from '@openai/agents';
import type { Interface as ReadlineInterface } from 'node:readline/promises';

/**
 * Helper used only for automated example runs (CI/auto mode).
 * It drives a single turn with auto-approval and a one-time retry for transient messages.
 */
export async function runAutoTurn<S extends Session>(
  agent: Agent<any, any>,
  session: S,
  resolver: (
    rl: ReadlineInterface,
    agent: Agent<any, any>,
    result: RunResult<any, any>,
    session: S,
  ) => Promise<RunResult<any, any>>,
  message: string,
  log: (text: string) => void,
): Promise<void> {
  const autoRl = {
    question: async () => '',
    close: () => {},
  } as unknown as ReadlineInterface;

  const runOnce = async (): Promise<string> => {
    let result: RunResult<any, any> = await run(agent, message, { session });
    result = await resolver(autoRl, agent, result, session);
    const reply = result.finalOutput ?? '[No final output produced]';
    return reply;
  };

  let reply = await runOnce();
  log(`Assistant: ${reply}`);

  const needsRetry =
    reply.toLowerCase().includes('retry') ||
    reply.toLowerCase().includes('temporary');
  if (needsRetry) {
    reply = await runOnce();
    log(`Assistant (retry): ${reply}`);
  }
}
