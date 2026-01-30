import { describe, it, expect } from 'vitest';

import {
  AgentAsToolInputSchema,
  resolveAgentToolInput,
} from '../src/agentToolInput';
import type { AgentInputItem } from '../src/types';

describe('agentToolInput', () => {
  it('AgentAsToolInputSchema accepts only string input', () => {
    expect(AgentAsToolInputSchema.safeParse({ input: 'hi' }).success).toBe(
      true,
    );
    expect(AgentAsToolInputSchema.safeParse({ input: [] }).success).toBe(false);
  });

  it('resolveAgentToolInput returns string input when provided', async () => {
    const result = await resolveAgentToolInput({ params: { input: 'hello' } });
    expect(result).toBe('hello');
  });

  it('resolveAgentToolInput falls back to JSON when no schema info', async () => {
    const result = await resolveAgentToolInput({ params: { foo: 'bar' } });
    expect(result).toBe(JSON.stringify({ foo: 'bar' }));
  });

  it('resolveAgentToolInput preserves structured fields alongside input', async () => {
    const result = await resolveAgentToolInput({
      params: { input: 'hello', target: 'world' },
    });
    expect(result).toBe(JSON.stringify({ input: 'hello', target: 'world' }));
  });

  it('resolveAgentToolInput uses the default builder when schema info exists', async () => {
    const result = await resolveAgentToolInput({
      params: { foo: 'bar' },
      schemaInfo: { summary: 'Summary' },
    });
    expect(typeof result).toBe('string');
    expect(result).toContain('Input Schema Summary:');
    expect(result).toContain('Summary');
  });

  it('resolveAgentToolInput returns builder output for items', async () => {
    const items = [
      { role: 'user', content: 'custom input' },
    ] satisfies AgentInputItem[];
    const result = await resolveAgentToolInput({
      params: { input: 'ignored' },
      inputBuilder: async () => items,
    });
    expect(result).toEqual(items);
  });
});
