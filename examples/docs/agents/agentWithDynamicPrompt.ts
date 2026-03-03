import { Agent, RunContext } from '@openai/agents';

interface PromptContext {
  customerTier: 'free' | 'pro';
}

function buildPrompt(runContext: RunContext<PromptContext>) {
  return {
    promptId: 'pmpt_support_agent',
    version: '7',
    variables: {
      customer_tier: runContext.context.customerTier,
    },
  };
}

const agent = new Agent<PromptContext>({
  name: 'Prompt-backed helper',
  prompt: buildPrompt,
});
