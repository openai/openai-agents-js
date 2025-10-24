import { z } from 'zod';
import { Agent, handoff, RunContext } from '@openai/agents';

const FooSchema = z.object({ foo: z.string() });

function onHandoff(ctx: RunContext, input?: { foo: string }) {
  console.log('Handoff called with:', input?.foo);
}

const agent = new Agent({ name: 'My agent' });

const handoffObj = handoff(agent, {
  onHandoff,
  inputType: FooSchema,
  toolNameOverride: 'custom_handoff_tool',
  toolDescriptionOverride: 'Custom description',
});
