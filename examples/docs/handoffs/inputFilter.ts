import { Agent, handoff } from '@openai/agents/classic';
import { removeAllTools } from '@openai/agents-core/extensions';

const agent = new Agent({ name: 'FAQ agent' });

const handoffObj = handoff(agent, {
  inputFilter: removeAllTools,
});
