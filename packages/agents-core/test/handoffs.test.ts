import { describe, it, expect, beforeAll } from 'vitest';
import {
  Agent,
  run,
  setDefaultModelProvider,
  setTracingDisabled,
} from '../src/index';
import { z } from 'zod';
import { FakeModelProvider } from './stubs';
import { getTransferMessage, handoff } from '../src/handoff';
import { RunContext } from '../src/runContext';

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

  it('filters handoffs using isEnabled predicates', async () => {
    const subAgent = new Agent({
      name: 'Sub Agent',
      instructions: 'sub',
    });

    const mainAgent = new Agent<{ allow: boolean }>({
      name: 'Main',
      instructions: 'main',
      handoffs: [
        handoff(subAgent, {
          isEnabled: ({
            runContext,
          }: {
            runContext: RunContext<unknown>;
            agent: Agent<any, any>;
          }) => (runContext.context as { allow: boolean }).allow,
        }),
      ],
    });

    const disabled = await mainAgent.getEnabledHandoffs(
      new RunContext({ allow: false }),
    );
    expect(disabled).toEqual([]);

    const enabled = await mainAgent.getEnabledHandoffs(
      new RunContext({ allow: true }),
    );
    expect(enabled.map((h) => h.agentName)).toEqual(['Sub Agent']);
  });

  it('supports object argument in handoff isEnabled option', async () => {
    const subAgent = new Agent({
      name: 'Obj Agent',
      instructions: 'sub',
    });

    const mainAgent = new Agent<{ allow: boolean }>({
      name: 'Main',
      instructions: 'main',
      handoffs: [
        handoff(subAgent, {
          isEnabled: ({
            runContext,
            agent,
          }: {
            runContext: RunContext<unknown>;
            agent: Agent<any, any>;
          }) => {
            expect(agent).toBe(mainAgent);
            return (runContext.context as { allow: boolean }).allow;
          },
        }),
      ],
    });

    const enabled = await mainAgent.getEnabledHandoffs(
      new RunContext({ allow: true }),
    );
    expect(enabled.map((h) => h.agentName)).toEqual(['Obj Agent']);

    const disabled = await mainAgent.getEnabledHandoffs(
      new RunContext({ allow: false }),
    );
    expect(disabled).toEqual([]);
  });

  it('enables layered handoffs based on language preference', async () => {
    type LanguagePreference = 'spanish_only' | 'french_spanish' | 'european';

    type AppContext = {
      languagePreference: LanguagePreference;
    };

    const spanishAgent = new Agent<AppContext>({
      name: 'spanish_agent',
      instructions: 'Reply in Spanish.',
    });
    const frenchAgent = new Agent<AppContext>({
      name: 'french_agent',
      instructions: 'Reply in French.',
    });
    const italianAgent = new Agent<AppContext>({
      name: 'italian_agent',
      instructions: 'Reply in Italian.',
    });

    const triageAgent = new Agent<AppContext>({
      name: 'triage',
      instructions: 'Delegate to specialists when available.',
      handoffs: [
        handoff(spanishAgent, {
          isEnabled: true,
        }),
        handoff(frenchAgent, {
          isEnabled: ({ runContext }) =>
            ['french_spanish', 'european'].includes(
              runContext.context.languagePreference,
            ),
        }),
        handoff(italianAgent, {
          isEnabled: ({ runContext }) =>
            runContext.context.languagePreference === 'european',
        }),
      ],
    });

    const collect = async (preference: LanguagePreference) =>
      (
        await triageAgent.getEnabledHandoffs(
          new RunContext<AppContext>({ languagePreference: preference }),
        )
      ).map((handoffInstance) => handoffInstance.agentName);

    await expect(collect('spanish_only')).resolves.toEqual(['spanish_agent']);
    await expect(collect('french_spanish')).resolves.toEqual([
      'spanish_agent',
      'french_agent',
    ]);
    await expect(collect('european')).resolves.toEqual([
      'spanish_agent',
      'french_agent',
      'italian_agent',
    ]);
  });
});
