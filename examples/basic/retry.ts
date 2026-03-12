import {
  Agent,
  ModelRetrySettings,
  Runner,
  retryPolicies,
} from '@openai/agents';

async function main() {
  const applyPolicies = retryPolicies.any(
    // On OpenAI-backed models, providerSuggested() follows provider retry advice,
    // including the OpenAI package's fallback retryable statuses when
    // x-should-retry is absent (for example 408/409/429/5xx).
    retryPolicies.providerSuggested(),
    retryPolicies.retryAfter(),
    retryPolicies.networkError(),
    retryPolicies.httpStatus([408, 409, 429, 500, 502, 503, 504]),
  );

  const retry: ModelRetrySettings = {
    maxRetries: 4,
    backoff: {
      initialDelayMs: 500,
      maxDelayMs: 5_000,
      multiplier: 2,
      jitter: true,
    },
    policy: async (context) => {
      const decision = await applyPolicies(context);
      if (!decision) {
        console.error(
          `[retry] stop after attempt ${context.attempt}/${context.maxRetries + 1}: ${formatError(context.error)}`,
        );
        return false;
      }
      const delayMs =
        typeof decision === 'object' ? decision.delayMs : undefined;
      const reason = typeof decision === 'object' ? decision.reason : undefined;

      console.error(
        [
          `[retry] retry attempt ${context.attempt}/${context.maxRetries + 1}`,
          delayMs !== undefined
            ? `waiting ${delayMs}ms`
            : 'using default backoff',
          reason ? `reason: ${reason}` : null,
          `error: ${formatError(context.error)}`,
        ]
          .filter(Boolean)
          .join(' | '),
      );
      return decision;
    },
  };
  // Runner-level modelSettings are shared defaults for every run.
  // If an Agent also defines modelSettings, the Agent wins for overlapping
  // keys, while nested objects like retry/backoff are merged.
  const runner = new Runner({ modelSettings: { retry } });

  const agent = new Agent({
    name: 'Assistant',
    instructions:
      'You are a concise assistant. Answer in 3 short bullet points at most.',
    // This Agent repeats the same retry config for clarity. In real code you
    // can keep shared defaults on the Runner and only put per-agent overrides
    // here when you need different retry behavior.
    modelSettings: { retry },
  });

  console.log(
    'Retry support is configured. You will only see [retry] logs if a transient failure happens.',
  );

  const result = await runner.run(
    agent,
    'Explain exponential backoff for API retries in plain English.',
  );

  console.log('\nFinal output:\n');
  console.log(result.finalOutput);
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Unknown error';
  }
  return error.message || error.name;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
