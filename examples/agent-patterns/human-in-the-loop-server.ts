/**
 * A CLI simulation, not an HTTP service or authentication implementation.
 * Complete snapshots and RunResult objects stay in the server implementation.
 * Production needs trusted authentication, request protections, atomic shared
 * storage, bounded retention, and recovery that reconciles tool side effects.
 */
import { Agent, tool } from '@openai/agents';
import { z } from 'zod';
import readline from 'node:readline/promises';
import { ApprovalServer } from '../docs/human-in-the-loop/server';

async function main() {
  const server = new ApprovalServer(
    new Agent({
      name: 'Weather assistant',
      instructions: 'Use get_temperature to answer temperature questions.',
      tools: [
        tool({
          name: 'get_temperature',
          description: 'Return a sample temperature for a city.',
          parameters: z.object({ city: z.string() }),
          needsApproval: true,
          execute: async ({ city }) =>
            `The temperature in ${city} is 20 Celsius.`,
        }),
      ],
    }),
  );
  // Server-side simulation of authenticated middleware; never a request-body field.
  const authenticatedUserId = 'example-user';
  let response = await server.start(
    authenticatedUserId,
    'What is the temperature in Oakland?',
  );
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    while (response.kind === 'approval') {
      const decisions: Record<string, boolean> = {};
      for (const prompt of response.prompts) {
        // JSON quoting also keeps terminal control characters out of the prompt.
        const answer = await rl.question(
          `Allow ${JSON.stringify(prompt.toolName)} with ${JSON.stringify(prompt.arguments)}? (y/n): `,
        );
        decisions[prompt.decisionId] = answer.trim().toLowerCase() === 'y';
      }
      response = await server.decide(
        authenticatedUserId,
        response.requestId,
        decisions,
      );
    }
    console.log(response.output);
  } finally {
    rl.close();
  }
}

main().catch(() => {
  // Raw SDK errors can contain execution state. Keep diagnostics server-side.
  console.error(
    'The approval run failed. Reconcile side effects before retrying.',
  );
  process.exitCode = 1;
});
