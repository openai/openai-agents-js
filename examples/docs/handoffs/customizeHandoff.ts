import { z } from 'zod';
import { Agent, handoff, RunContext } from '@openai/agents';

function onHandoff(ctx: RunContext, input: { foo: string }) {
  console.log('Handoff called with:', input.foo);
}

const agent = new Agent({ name: 'My agent' });

const handoffObj = handoff(agent, {
  onHandoff,
  inputType: z.object({ foo: z.string() }),
  toolNameOverride: 'custom_handoff_tool',
  toolDescriptionOverride: 'Custom description',
});
