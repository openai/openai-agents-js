import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  RealtimeAgent,
  tool,
  RealtimeContextData,
  type RealtimeAgentConfiguration,
} from '../src';

describe('RealtimeAgent handoffs', () => {
  it('accepts handoffs sharing the session context', () => {
    type SessionContext = { userId: string };

    const specialist = new RealtimeAgent<SessionContext>({
      name: 'specialist',
    });

    const mainAgent = new RealtimeAgent<SessionContext>({
      name: 'main',
      handoffs: [specialist],
    });

    expect(mainAgent.handoffs).toEqual([specialist]);
  });

  it('accepts handoffs with default context parameters', () => {
    const specialist = new RealtimeAgent({
      name: 'specialist',
    });

    const mainAgent = new RealtimeAgent({
      name: 'main',
      handoffs: [specialist],
    });

    expect(mainAgent.handoffs).toEqual([specialist]);
  });

  it('supports tool definitions without RealtimeContextData', () => {
    type SessionContext = { userId: string };
    const parameters = z.object({ message: z.string() });
    const echoTool = tool<typeof parameters, SessionContext>({
      name: 'echo',
      description: 'Echo the user id with the provided message.',
      parameters,
      execute: async ({ message }, runContext) => {
        // if you want to access history data, the type parameter must be RealtimeContextData<SessionContext>
        // console.log(runContext?.context?.history);
        return `${runContext?.context?.userId}: ${message}`;
      },
    });

    const agent = new RealtimeAgent<SessionContext>({
      name: 'Tool Agent',
      tools: [echoTool],
    });
    expect(agent.tools).toContain(echoTool);
  });

  it('supports tool definitions that rely on RealtimeContextData', () => {
    type SessionContext = { userId: string };
    const parameters = z.object({ message: z.string() });
    const echoTool = tool<
      typeof parameters,
      RealtimeContextData<SessionContext>
    >({
      name: 'echo',
      description: 'Echo the user id with the provided message.',
      parameters,
      execute: async ({ message }, runContext) => {
        // if you want to access history data, the type parameter must be RealtimeContextData<SessionContext>
        void runContext?.context?.history;
        return `${runContext?.context?.userId}: ${message}`;
      },
    });

    const agent = new RealtimeAgent<SessionContext>({
      name: 'Tool Agent',
      tools: [echoTool],
    });
    expect(agent.tools).toContain(echoTool);
  });

  it('rejects handoffs with incompatible session contexts', () => {
    type SessionContext = { userId: string };
    type OtherContext = { language: string };

    const specialist = new RealtimeAgent<SessionContext>({
      name: 'specialist',
    });

    const validConfig: RealtimeAgentConfiguration<SessionContext> = {
      name: 'main',
      handoffs: [specialist],
    };

    expect(validConfig.handoffs).toEqual([specialist]);

    const invalidConfig: RealtimeAgentConfiguration<OtherContext> = {
      name: 'incompatible',
      // @ts-expect-error - mismatched handoff context should not be allowed
      handoffs: [specialist],
    };

    expect(invalidConfig).toBeDefined();
  });
});
