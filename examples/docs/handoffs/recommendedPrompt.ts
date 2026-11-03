import { Agent } from '@openai/agents/classic';
import { RECOMMENDED_PROMPT_PREFIX } from '@openai/agents-core/extensions';

const billingAgent = new Agent({
  name: 'Billing agent',
  instructions: `${RECOMMENDED_PROMPT_PREFIX}
Fill in the rest of your prompt here.`,
});
