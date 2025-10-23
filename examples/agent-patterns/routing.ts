import { Agent, run, withTrace } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents';
import type { StreamedRunResult } from '@openai/agents';
import readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const frenchAgent = new Agent({
  name: 'french_agent',
  instructions: 'You only speak French',
});

const spanishAgent = new Agent({
  name: 'spanish_agent',
  instructions: 'You only speak Spanish',
});

const englishAgent = new Agent({
  name: 'english_agent',
  instructions: 'You only speak English',
});

const triageAgent = new Agent({
  name: 'triage_agent',
  instructions:
    'Handoff to the appropriate agent based on the language of the request.',
  handoffs: [frenchAgent, spanishAgent, englishAgent],
});

async function main() {
  const conversationId = randomUUID().replace(/-/g, '').slice(0, 16);

  let userMsg = await rl.question(
    'Hi! We speak French, Spanish and English. How can I help?\n',
  );

  let agent: Agent<any, any> = triageAgent;
  let inputs: AgentInputItem[] = [{ role: 'user', content: userMsg }];

  while (true) {
    let result: StreamedRunResult<any, Agent<any, any>> | undefined;
    await withTrace(
      'Routing example',
      async () => {
        result = await run(agent, inputs, { stream: true });

        result
          .toTextStream({ compatibleWithNodeStreams: true })
          .pipe(process.stdout);

        await result.completed;
      },
      { groupId: conversationId },
    );

    if (!result) {
      throw new Error('No result');
    }

    inputs = result.history;
    process.stdout.write('\n');

    userMsg = await rl.question('Enter a message:\n');
    inputs.push({ role: 'user', content: userMsg });
    agent = result.currentAgent ?? agent;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
