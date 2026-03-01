import type { Agent } from '@openai/agents';

type RunAgentUpdatedStreamEvent = {
  type: 'agent_updated_stream_event';
  agent: Agent<any, any>;
};

void ({} as RunAgentUpdatedStreamEvent);
