import { Agent, Handoff, tool, type ToolContext } from '../src';
import { z } from 'zod';

type Application = { account: string };
const target = new Agent<Application>({ instructions: 'Resolve.' });
const matching = tool({
  name: 'route',
  parameters: z.object({ ticket: z.number() }),
  execute: ({ ticket }, context: ToolContext<Application>) =>
    `${context.context.account}:${ticket}`,
});
new Handoff(target, matching);
const mismatched = tool({
  name: 'route',
  parameters: z.object({}),
  execute: (_args, context: ToolContext<number>) => String(context.context),
});
// @ts-expect-error Callback and target require a shared application context.
new Handoff<Application>(target, mismatched);
