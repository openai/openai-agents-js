import { describe, expect, it } from 'vitest';
import { extractOutputItemsFromRunItems } from '../../src/runner/items';
import { Agent } from '../../src/agent';
import {
  RunMessageOutputItem,
  RunReasoningItem,
  RunToolCallItem,
  RunToolCallOutputItem,
  RunToolApprovalItem,
} from '../../src/items';

const agent = new Agent({ name: 'TestAgent' });

describe('extractOutputItemsFromRunItems', () => {
  it('returns all items including trailing reasoning by default', () => {
    const items = [
      new RunMessageOutputItem(
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hi' }],
        },
        agent,
      ),
      new RunReasoningItem(
        {
          type: 'reasoning',
          id: 'rs_abc',
          content: [{ type: 'input_text', text: 'trailing thought' }],
        },
        agent,
      ),
    ];

    const result = extractOutputItemsFromRunItems(items);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      type: 'reasoning',
      id: 'rs_abc',
      content: [{ type: 'input_text', text: 'trailing thought' }],
    });
  });

  it('preserves reasoning item id when stripReasoningItemIds is false', () => {
    const items = [
      new RunReasoningItem(
        {
          type: 'reasoning',
          id: 'rs_123',
          content: [{ type: 'input_text', text: 'thinking...' }],
        },
        agent,
      ),
      new RunMessageOutputItem(
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hello' }],
        },
        agent,
      ),
    ];

    const result = extractOutputItemsFromRunItems(items, {
      stripReasoningItemIds: false,
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      type: 'reasoning',
      id: 'rs_123',
      content: [{ type: 'input_text', text: 'thinking...' }],
    });
  });

  it('strips id from reasoning items when stripReasoningItemIds is true', () => {
    const items = [
      new RunReasoningItem(
        {
          type: 'reasoning',
          id: 'rs_123',
          content: [{ type: 'input_text', text: 'thinking...' }],
        },
        agent,
      ),
      new RunMessageOutputItem(
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hello' }],
        },
        agent,
      ),
    ];

    const result = extractOutputItemsFromRunItems(items, {
      stripReasoningItemIds: true,
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      type: 'reasoning',
      content: [{ type: 'input_text', text: 'thinking...' }],
    });
    expect(result[0]).not.toHaveProperty('id');
  });

  it('strips id from multiple reasoning items', () => {
    const items = [
      new RunReasoningItem(
        {
          type: 'reasoning',
          id: 'rs_1',
          content: [{ type: 'input_text', text: 'thought 1' }],
        },
        agent,
      ),
      new RunMessageOutputItem(
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'msg' }],
        },
        agent,
      ),
      new RunReasoningItem(
        {
          type: 'reasoning',
          id: 'rs_2',
          content: [{ type: 'input_text', text: 'thought 2' }],
        },
        agent,
      ),
    ];

    const result = extractOutputItemsFromRunItems(items, {
      stripReasoningItemIds: true,
    });
    expect(result).toHaveLength(3);
    expect(result[0]).not.toHaveProperty('id');
    expect(result[2]).not.toHaveProperty('id');
  });

  it('leaves reasoning items without id unchanged when stripReasoningItemIds is true', () => {
    const items = [
      new RunReasoningItem(
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'no id reasoning' }],
        },
        agent,
      ),
      new RunMessageOutputItem(
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'ok' }],
        },
        agent,
      ),
    ];

    const result = extractOutputItemsFromRunItems(items, {
      stripReasoningItemIds: true,
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      type: 'reasoning',
      content: [{ type: 'input_text', text: 'no id reasoning' }],
    });
  });

  it('does not strip id from non-reasoning items when stripReasoningItemIds is true', () => {
    const items = [
      new RunToolCallItem(
        {
          type: 'function_call',
          id: 'fc_1',
          callId: 'call-1',
          name: 'search',
          arguments: '{}',
        },
        agent,
      ),
      new RunToolCallOutputItem(
        {
          type: 'function_call_result',
          name: 'search',
          callId: 'call-1',
          status: 'completed',
          output: 'result',
        },
        agent,
        'result',
      ),
    ];

    const result = extractOutputItemsFromRunItems(items, {
      stripReasoningItemIds: true,
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty('id', 'fc_1');
  });

  it('still excludes tool_approval_item entries', () => {
    const items = [
      new RunToolApprovalItem(
        {
          type: 'function_call',
          callId: 'call-1',
          name: 'approve',
          arguments: '{}',
        },
        agent,
      ),
      new RunMessageOutputItem(
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'ok' }],
        },
        agent,
      ),
    ];

    const result = extractOutputItemsFromRunItems(items);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'ok' }],
    });
  });

  it('returns empty array for empty input', () => {
    expect(extractOutputItemsFromRunItems([])).toEqual([]);
  });
});
