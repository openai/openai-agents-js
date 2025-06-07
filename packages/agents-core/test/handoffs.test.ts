import { describe, it, expect, beforeAll } from 'vitest';
import {
  Agent,
  run,
  setDefaultModelProvider,
  setTracingDisabled,
} from '../src/index';
import { z } from 'zod/v3';
import { FakeModelProvider } from './stubs';
import { getTransferMessage, handoff } from '../src/handoff';

describe('Agent + handoffs', () => {
  beforeAll(() => {
    setTracingDisabled(true);
    setDefaultModelProvider(new FakeModelProvider());
  });

  it('should resolve its valid finalOuptut type', async () => {
    const agentA = new Agent({
      name: 'Agent A',
      outputType: z.object({
        a: z.string(),
      }),
    });
    const agentB = new Agent({
      name: 'Agent B',
      outputType: z.object({
        b: z.optional(z.number()),
      }),
    });
    const agentC = Agent.create({
      name: 'Agent C',
      outputType: z.object({
        c: z.boolean(),
      }),
      handoffs: [agentA, agentB],
    });
    const agentD = Agent.create({
      name: 'Agent D',
      outputType: z.object({
        d: z.string(),
      }),
      handoffs: [agentC],
    });
    // Note that FakeModel requires "text" output type
    const agentE = Agent.create({
      name: 'Agent E',
      handoffs: [agentD],
    });

    const result = await run(agentE, 'Hey!');

    // Verifying the types of the final output
    // If it does not work here, TS transpilation fails
    const finalOutput:
      | string
      | { a: string }
      | { b?: number }
      | { c: boolean }
      | { d: string }
      | undefined = result.finalOutput;
    expect(finalOutput).toBeDefined();
  });

  it('getTransferMessage', async () => {
    const result = getTransferMessage(
      new Agent({
        name: 'Agent A',
        outputType: z.object({ a: z.string() }),
      }),
    );
    expect(result).toBe('{"assistant":"Agent A"}');
  });

  it('getTransferMessage produces valid JSON', () => {
    const result = getTransferMessage(
      new Agent({
        name: 'Agent A',
        outputType: z.object({ a: z.string() }),
      }),
    );
    expect(JSON.parse(result)).toEqual({ assistant: 'Agent A' });
  });

  it('Handoff#getHandoffAsFunctionTool', async () => {
    const agent = new Agent({
      name: 'Agent A',
      outputType: z.object({
        a: z.string(),
      }),
    });
    const result = handoff(agent).getHandoffAsFunctionTool();
    expect(result).toEqual({
      type: 'function' as const,
      name: 'transfer_to_Agent_A',
      description: 'Handoff to the Agent A agent to handle the request. ',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    });
  });
});
