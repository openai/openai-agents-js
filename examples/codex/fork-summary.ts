import type { Agent } from '@openai/agents';

/** Explore another answer with a summary chosen by the application. */
export async function exploreAlternative(
  agent: Agent,
  input: string,
  summary: string,
) {
  const source = await agent.session();
  try {
    const original = await (await source.submit(input)).wait();
    // Audit history stays intact. The summary replaces only model working context.
    await source.compact({ summary });
    const state = await source.fork();
    // The new Session uses this Agent's current provider and tool declarations.
    const branch = await agent.session({ state });
    try {
      const alternative = await (
        await branch.submit('Explore another approach to the same task.')
      ).wait();
      return {
        original: original.finalOutput,
        alternative: alternative.finalOutput,
      };
    } finally {
      await branch.close();
    }
  } finally {
    await source.close();
  }
}
