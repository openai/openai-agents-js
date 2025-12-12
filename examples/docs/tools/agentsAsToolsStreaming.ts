import { Agent } from '@openai/agents';

const billingAgent = new Agent({
  name: 'Billing Agent',
  instructions: 'Answer billing questions and compute simple charges.',
});

const billingTool = billingAgent.asTool({
  toolName: 'billing_agent',
  toolDescription: 'Handles customer billing questions.',
  // onStream: simplest catch-all when you define the tool inline.
  onStream: (event) => {
    console.log(`[onStream] ${event.event.type}`, event);
  },
});

// on(eventName) lets you subscribe selectively (or use '*' for all).
billingTool.on('run_item_stream_event', (event) => {
  console.log('[on run_item_stream_event]', event);
});
billingTool.on('raw_model_stream_event', (event) => {
  console.log('[on raw_model_stream_event]', event);
});

const orchestrator = new Agent({
  name: 'Support Orchestrator',
  instructions: 'Delegate billing questions to the billing agent tool.',
  tools: [billingTool],
});
