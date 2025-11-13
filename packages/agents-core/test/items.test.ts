import { describe, it, expect } from 'vitest';

import { Agent } from '../src/agent';
import {
  RunHandoffCallItem as HandoffCallItem,
  RunHandoffOutputItem as HandoffOutputItem,
  RunMessageOutputItem as MessageOutputItem,
  RunReasoningItem as ReasoningItem,
  RunToolApprovalItem as ToolApprovalItem,
  RunToolCallItem as ToolCallItem,
  RunToolCallOutputItem as ToolCallOutputItem,
  extractAllTextOutput,
} from '../src/items';

import { TEST_MODEL_MESSAGE, TEST_MODEL_FUNCTION_CALL } from './stubs';

/**
 * The Item utilities are a foundational building block that a lot of higher
 * level logic (like `Runner`) relies on, therefore we add a few focused tests
 * that make sure the helpers work as intended. The goal is not to exhaustively
 * test every edge‑case, but to provide a good safety‑net so that accidental
 * regressions surface quickly.
 */

describe('items.extractAllTextOutput', () => {
  const agent = new Agent({ name: 'TestAgent' });

  it('returns an empty string when no items are passed', () => {
    expect(extractAllTextOutput([])).toBe('');
  });

  it('extracts text from message output items only', () => {
    const message1 = new MessageOutputItem(TEST_MODEL_MESSAGE, agent);
    const message2 = new MessageOutputItem(
      {
        ...TEST_MODEL_MESSAGE,
        content: [
          {
            type: 'output_text' as const,
            text: 'Good bye',
          },
        ],
      },
      agent,
    );

    // Add a non‑message item to make sure it doesn't influence the output.
    const toolCall = new ToolCallItem(TEST_MODEL_FUNCTION_CALL, agent);

    const combined = extractAllTextOutput([message1, toolCall, message2]);

    expect(combined).toBe('Hello WorldGood bye');
  });
});

describe('items toJSON()', () => {
  describe('ToolCallItem', () => {
    const item = new ToolCallItem(
      {
        id: 'test',
        type: 'function_call',
        callId: 'test',
        name: 'test',
        arguments: 'test',
        status: 'completed',
      },
      new Agent({ name: 'TestAgent' }),
    );

    it('returns the correct JSON', () => {
      expect(item.toJSON()).toEqual({
        type: 'tool_call_item',
        rawItem: item.rawItem,
        agent: item.agent.toJSON(),
      });
    });
  });

  describe('ToolCallOutputItem', () => {
    const item = new ToolCallOutputItem(
      {
        id: 'test',
        type: 'function_call_result',
        callId: 'test',
        name: 'test',
        output: { text: 'test', type: 'text' },
        status: 'completed',
      },
      new Agent({ name: 'TestAgent' }),
      'test',
    );

    it('returns the correct JSON', () => {
      expect(item.toJSON()).toEqual({
        type: 'tool_call_output_item',
        rawItem: item.rawItem,
        agent: item.agent.toJSON(),
        output: item.output,
      });
    });
  });

  describe('ReasoningItem', () => {
    const item = new ReasoningItem(
      {
        id: 'test',
        type: 'reasoning',
        content: [{ text: 'test', type: 'input_text' }],
      },
      new Agent({ name: 'TestAgent' }),
    );

    it('returns the correct JSON', () => {
      expect(item.toJSON()).toEqual({
        type: 'reasoning_item',
        rawItem: item.rawItem,
        agent: item.agent.toJSON(),
      });
    });
  });

  describe('HandoffCallItem', () => {
    const item = new HandoffCallItem(
      {
        id: 'test',
        type: 'function_call',
        callId: 'test',
        name: 'test',
        arguments: 'test',
        status: 'completed',
      },
      new Agent({ name: 'TestAgent' }),
    );

    it('returns the correct JSON', () => {
      expect(item.toJSON()).toEqual({
        type: 'handoff_call_item',
        rawItem: item.rawItem,
        agent: item.agent.toJSON(),
      });
    });
  });

  describe('HandoffOutputItem', () => {
    const item = new HandoffOutputItem(
      {
        id: 'test',
        type: 'function_call_result',
        callId: 'test',
        name: 'test',
        output: { type: 'text', text: 'test' },
        status: 'completed',
      },
      new Agent({ name: 'TestAgent' }),
      new Agent({ name: 'TestAgent' }),
    );

    it('returns the correct JSON', () => {
      expect(item.toJSON()).toEqual({
        type: 'handoff_output_item',
        rawItem: item.rawItem,
        sourceAgent: item.sourceAgent.toJSON(),
        targetAgent: item.targetAgent.toJSON(),
      });
    });
  });

  describe('ToolApprovalItem', () => {
    const item = new ToolApprovalItem(
      {
        id: 'test',
        type: 'function_call',
        callId: 'test',
        name: 'test',
        arguments: 'test',
        status: 'completed',
      },
      new Agent({ name: 'TestAgent' }),
    );

    it('returns the correct JSON', () => {
      expect(item.toJSON()).toEqual({
        type: 'tool_approval_item',
        rawItem: item.rawItem,
        agent: item.agent.toJSON(),
        toolName: 'test',
      });
    });
  });
});
