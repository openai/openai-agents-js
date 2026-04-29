import { describe, expect, it } from 'vitest';
import { Agent, type AgentOutputType } from '../src/agent';
import { isSandboxRuntimeAgent } from '../src/runner/sandbox';
import { SandboxAgent } from '../src/sandbox';
import {
  allocateAgentKeys,
  isSandboxAgent,
} from '../src/sandbox/runtime/agentKeys';

class AgentWithCapabilities extends Agent<unknown, AgentOutputType> {
  capabilities: unknown[] = [];
}

describe('sandbox agent key allocation', () => {
  it('avoids collisions between duplicate-name keys and existing agent names', () => {
    const firstFoo = new Agent<unknown, AgentOutputType>({ name: 'foo' });
    const existingFoo2 = new Agent<unknown, AgentOutputType>({
      name: 'foo_2',
    });
    const secondFoo = new Agent<unknown, AgentOutputType>({ name: 'foo' });
    const root = new Agent<unknown, AgentOutputType>({
      name: 'root',
      handoffs: [firstFoo, existingFoo2, secondFoo],
    });

    const values = [...allocateAgentKeys(root).values()];

    expect(values).toEqual(['root', 'foo', 'foo_2', 'foo_3']);
    expect(new Set(values).size).toBe(values.length);
  });

  it('only detects real SandboxAgent instances as sandbox agents', () => {
    const sandboxAgent = new SandboxAgent<unknown, AgentOutputType>({
      name: 'sandbox',
    });
    const regularAgent = new AgentWithCapabilities({ name: 'regular' });

    expect(isSandboxAgent(sandboxAgent)).toBe(true);
    expect(isSandboxRuntimeAgent(sandboxAgent)).toBe(true);
    expect(isSandboxAgent(regularAgent)).toBe(false);
    expect(isSandboxRuntimeAgent(regularAgent)).toBe(false);
  });
});
