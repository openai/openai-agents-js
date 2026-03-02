import { Agent } from '@openai/agents';

const billingAgent = new Agent({
  name: 'Billing Agent',
  instructions: 'Handle billing questions and subscription changes.',
});

const billingTool = billingAgent.asTool({
  toolName: 'billing_agent',
  toolDescription: 'Handles customer billing questions.',
  customOutputExtractor(result) {
    console.log('tool', result.agentToolInvocation.toolName);
    // Direct invoke() calls may not have a model-generated tool call id.
    console.log('call', result.agentToolInvocation.toolCallId);
    console.log('args', result.agentToolInvocation.toolArguments);

    return String(result.finalOutput ?? '');
  },
});

const orchestrator = new Agent({
  name: 'Support Orchestrator',
  instructions: 'Delegate billing questions to the billing agent tool.',
  tools: [billingTool],
});
