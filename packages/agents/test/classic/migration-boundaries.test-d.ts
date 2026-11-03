import { Agent, RunContext } from '@openai/agents-core';
import { z } from 'zod';
import { emitAgentEnd } from '../../src/migration/boundaries';

const agent = new Agent({ name: 'text events' });
const context = new RunContext();
const structuredAgent = new Agent({
  name: 'structured events',
  outputType: z.object({ result: z.string() }),
});

emitAgentEnd({ agent, context, output: 'done' });
emitAgentEnd({ agent: structuredAgent, context, output: { result: 'done' } });
emitAgentEnd({
  agent: structuredAgent,
  context,
  // @ts-expect-error A structured-output agent requires its declared output shape.
  output: 'done',
});
// @ts-expect-error A text-output agent cannot emit a structured output object.
emitAgentEnd({ agent, context, output: { result: 'done' } });
