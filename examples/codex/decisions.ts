import { Agent, OpenAIDecisions } from '@openai/agents';

const request =
  process.argv[2] ?? 'How can I update the payment method on my account?';
const decisions = new OpenAIDecisions();
const support = new Agent({
  ...(process.env.SUPPORT_MODEL ? { model: process.env.SUPPORT_MODEL } : {}),
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
      return {
        action: 'continue',
        instructions: 'Give the customer one concrete next step.',
      };
  },
});
const result = await support.run(request);
console.log(result.finalOutput);
