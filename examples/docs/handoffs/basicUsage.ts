import { Agent, handoff } from '@openai/agents/classic';

const billingAgent = new Agent({ name: 'Billing agent' });
const refundAgent = new Agent({ name: 'Refund agent' });

// Use Agent.create method to ensure the finalOutput type considers handoffs
const triageAgent = Agent.create({
  name: 'Triage agent',
  handoffs: [billingAgent, handoff(refundAgent)],
});
