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
  it('returns all items when no trailing reasoning', () => {
    const items = [
      new RunReasoningItem(
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'thinking...' }],
        },
        agent,
      ),
      new RunMessageOutputItem(
        {
          type: 'assistant_message',
          content: [{ type: 'output_text', text: 'hello' }],
        },
        agent,
      ),
    ];

    const result = extractOutputItemsFromRunItems(items);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      type: 'reasoning',
      content: [{ type: 'input_text', text: 'thinking...' }],
    });
    expect(result[1]).toEqual({
      type: 'assistant_message',
      content: [{ type: 'output_text', text: 'hello' }],
    });
  });

  it('strips trailing reasoning items not followed by output', () => {
    const items = [
      new RunMessageOutputItem(
        {
          type: 'assistant_message',
          content: [{ type: 'output_text', text: 'hi' }],
        },
        agent,
      ),
      new RunReasoningItem(
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'trailing thought' }],
        },
        agent,
      ),
    ];

    const result = extractOutputItemsFromRunItems(items);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'assistant_message',
      content: [{ type: 'output_text', text: 'hi' }],
    });
  });

  it('strips multiple trailing reasoning items', () => {
    const items = [
      new RunMessageOutputItem(
        {
          type: 'assistant_message',
          content: [{ type: 'output_text', text: 'msg' }],
        },
        agent,
      ),
      new RunReasoningItem(
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'thought 1' }],
        },
        agent,
      ),
      new RunReasoningItem(
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'thought 2' }],
        },
        agent,
      ),
    ];

    const result = extractOutputItemsFromRunItems(items);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'assistant_message',
      content: [{ type: 'output_text', text: 'msg' }],
    });
  });

  it('strips when only reasoning items exist (no assistant output)', () => {
    const items = [
      new RunReasoningItem(
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'orphan thought' }],
        },
        agent,
      ),
    ];

    const result = extractOutputItemsFromRunItems(items);
    expect(result).toHaveLength(0);
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
          type: 'assistant_message',
          content: [{ type: 'output_text', text: 'ok' }],
        },
        agent,
      ),
    ];

    const result = extractOutputItemsFromRunItems(items);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'assistant_message',
      content: [{ type: 'output_text', text: 'ok' }],
    });
  });

  it('keeps reasoning items that are followed by a tool call', () => {
    const items = [
      new RunReasoningItem(
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'deciding...' }],
        },
        agent,
      ),
      new RunToolCallItem(
        {
          type: 'function_call',
          callId: 'call-1',
          name: 'search',
          arguments: '{}',
        },
        agent,
      ),
      new RunToolCallOutputItem(
        {
          type: 'function_call_result',
          callId: 'call-1',
          output: 'result',
        },
        agent,
        'result',
      ),
    ];

    const result = extractOutputItemsFromRunItems(items);
    expect(result).toHaveLength(3);
  });

  it('strips trailing reasoning after tool call results', () => {
    const items = [
      new RunToolCallItem(
        {
          type: 'function_call',
          callId: 'call-1',
          name: 'search',
          arguments: '{}',
        },
        agent,
      ),
      new RunToolCallOutputItem(
        {
          type: 'function_call_result',
          callId: 'call-1',
          output: 'done',
        },
        agent,
        'done',
      ),
      new RunReasoningItem(
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'hmm...' }],
        },
        agent,
      ),
    ];

    const result = extractOutputItemsFromRunItems(items);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(
      expect.objectContaining({ type: 'function_call' }),
    );
    expect(result[1]).toEqual(
      expect.objectContaining({ type: 'function_call_result' }),
    );
  });

  it('returns empty array for empty input', () => {
    expect(extractOutputItemsFromRunItems([])).toEqual([]);
  });
});
