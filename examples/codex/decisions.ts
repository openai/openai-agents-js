import OpenAI from 'openai';
import { Agent, ContinueTurn, OpenAIDecisions } from '@openai/agents';

const request =
  process.argv[2] ?? 'How can I update the payment method on my account?';
const decisions = new OpenAIDecisions({
  client: new OpenAI(),
  // Free-form schemas use Responses only when this fallback is explicitly configured.
  ...(process.env.DECISIONS_FALLBACK_MODEL
    ? { fallbackModel: process.env.DECISIONS_FALLBACK_MODEL }
    : {}),
});
const support = new Agent({
  model: process.env.SUPPORT_MODEL ?? 'gpt-5.5',
  instructions: 'Help the customer. Give them a concrete next step.',
  decisions,
  async beforeComplete(context) {
    if (context.continuationCount !== 0 || !context.text) return;
    const clear = await context.decide(
      'Does the customer have a clear next step?',
      {
        input: context.text,
      },
    );
    if (!clear)
      return new ContinueTurn('Give the customer one concrete next step.');
  },
});
const result = await support.run(request);
console.log(result.finalOutput);
console.log(result.threadUsage?.totalTokenUsage);
