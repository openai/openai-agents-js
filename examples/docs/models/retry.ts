import { Agent, Runner, retryPolicies } from '@openai/agents';

const sharedRetry = {
  maxRetries: 4,
  backoff: {
    initialDelayMs: 500,
    maxDelayMs: 5_000,
    multiplier: 2,
    jitter: true,
  },
  policy: retryPolicies.any(
    retryPolicies.providerSuggested(),
    retryPolicies.retryAfter(),
    retryPolicies.networkError(),
    retryPolicies.httpStatus([408, 409, 429, 500, 502, 503, 504]),
  ),
};

const runner = new Runner({
  modelSettings: {
    retry: sharedRetry,
  },
});

const agent = new Agent({
  name: 'Assistant',
  instructions: 'You are a concise assistant.',
  modelSettings: {
    retry: {
      maxRetries: 2,
      backoff: {
        maxDelayMs: 2_000,
      },
    },
  },
});

await runner.run(agent, 'Summarize exponential backoff in plain English.');
