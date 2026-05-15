import { Agent, run } from '@openai/agents';

const REQUEST_BUDGET = 3;
const TOKEN_BUDGET = 2_000;

const agent = new Agent({
  name: 'Usage Tracker',
  instructions: 'Summarize the latest project update in one sentence.',
});

const result = await run(
  agent,
  'Summarize this: key customer feedback themes and the next product iteration.',
);

const usage = result.state.usage;
console.log({
  requests: usage.requests,
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  totalTokens: usage.totalTokens,
});

if (usage.requestUsageEntries) {
  for (const entry of usage.requestUsageEntries) {
    console.log('request', {
      endpoint: entry.endpoint,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      totalTokens: entry.totalTokens,
    });
  }
}

if (usage.requests > REQUEST_BUDGET || usage.totalTokens > TOKEN_BUDGET) {
  throw new Error(
    `Usage budget exceeded: ${usage.requests} requests and ${usage.totalTokens} tokens`,
  );
}
