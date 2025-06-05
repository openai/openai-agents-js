import { describe, it, expect, vi } from 'vitest';

import { RealtimeAgent } from '../src/realtimeAgent';
import { Agent } from '@openai/agents-core';

const mockResponses = [true, false];
vi.mock('@openai/agents-core/_shims', async (importOriginal) => {
  return {
    ...(await importOriginal()),
    isBrowserEnvironment: vi.fn(() => mockResponses.shift() ?? true),
  };
});

describe('RealtimeAgent', () => {
  it('detects local agents as tools (browser)', async () => {
    const localToolAgent = new Agent({
      name: 'local_agent',
      instructions: 'You are a local agent',
    });
    expect(() => {
      new RealtimeAgent({
        name: 'A',
        tools: [
          localToolAgent.asTool({
            toolName: 'local_agent tool',
            toolDescription: 'You are a local agent',
          }),
        ],
      });
    }).toThrowError(
      'Local agent as a tool detected: local_agent_tool. Please use a tool that makes requests to your server-side agent logic, rather than converting a locally running client-side agent into a tool.',
    );
  });

  it('does not detect local agents as tools (server)', () => {
    const localToolAgent = new Agent({
      name: 'local_agent',
      instructions: 'You are a local agent',
    });
    const realtimeAgent = new RealtimeAgent({
      name: 'A',
      tools: [
        localToolAgent.asTool({
          toolName: 'local_agent tool',
          toolDescription: 'You are a local agent',
        }),
      ],
    });
    expect(realtimeAgent).toBeDefined();
  });
});
