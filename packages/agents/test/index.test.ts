import { Agent, toolNamespace, toolSearchTool } from '../src/index';
import { RealtimeAgent } from '../src/realtime';
import { isZodObject } from '../src/utils';
import { describe, test, expect } from 'vitest';

describe('Exports', () => {
  test('Agent is out there', () => {
    const agent = new Agent({ name: 'Test' });
    expect(agent.name).toBe('Test');
  });
});

describe('RealtimeAgent', () => {
  test('should be available', () => {
    const agent = new RealtimeAgent({ name: 'Test' });
    expect(agent.name).toBe('Test');
  });
});

describe('isZodObject', () => {
  test('should be available', () => {
    expect(isZodObject({})).toBe(false);
  });
});

describe('Tool search exports', () => {
  test('toolNamespace and toolSearchTool should be available', () => {
    expect(typeof toolNamespace).toBe('function');
    expect(toolSearchTool()).toMatchObject({
      type: 'hosted_tool',
      name: 'tool_search',
      providerData: { type: 'tool_search' },
    });
    expect(
      toolSearchTool({
        execution: 'client',
      }),
    ).toMatchObject({
      providerData: {
        type: 'tool_search',
        execution: 'client',
      },
    });
  });
});
