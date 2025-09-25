import { Agent } from '@openai/agents';

const bookingAgent = new Agent({
  name: 'Booking Agent',
  instructions: 'Help users with booking requests.',
});

const refundAgent = new Agent({
  name: 'Refund Agent',
  instructions: 'Process refund requests politely and efficiently.',
});

// Use Agent.create method to ensure the finalOutput type considers handoffs
const triageAgent = Agent.create({
  name: 'Triage Agent',
  instructions: `Help the user with their questions. 
  If the user asks about booking, hand off to the booking agent. 
  If the user asks about refunds, hand off to the refund agent.`.trimStart(),
  handoffs: [bookingAgent, refundAgent],
});
