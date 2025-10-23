import { Agent, handoff } from '@openai/agents';

const agent = new Agent({ name: 'My agent' });

const handoffObj = handoff(agent, {
  toolNameOverride: 'custom_handoff_tool',
  toolDescriptionOverride: 'Custom description',
});
