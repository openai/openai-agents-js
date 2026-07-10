import OpenAI from 'openai';
import { Agent, run, tool } from '@openai/agents';
import {
  OpenAIHostedMultiAgentModel,
  getHostedAgentMetadata,
} from '@openai/agents-openai/experimental/hosted-multi-agent';
import { z } from 'zod';

const lookupProject = tool({
  name: 'lookup_project',
  description: 'Return details about a project.',
  parameters: z.object({ project: z.string() }),
  execute: async ({ project }, _context, details) => {
    const caller = getHostedAgentMetadata(details);
    console.log(`Tool called by ${caller?.agentName ?? 'unknown'}`);
    return { project, status: 'on track' };
  },
});

const model = new OpenAIHostedMultiAgentModel(new OpenAI(), 'gpt-5.6-sol', {
  maxConcurrentSubagents: 3,
});

try {
  const agent = new Agent({
    name: 'Hosted coordinator',
    model,
    tools: [lookupProject],
    instructions:
      'Delegate project research to hosted subagents, wait for them, and synthesize the result.',
  });

  const result = await run(agent, 'Compare projects alpha and beta.');
  console.log(result.finalOutput);
} finally {
  await model.close();
}
