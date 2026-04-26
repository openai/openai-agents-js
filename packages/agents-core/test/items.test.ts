import { describe, it, expect } from 'vitest';
import { z } from 'zod';

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
import { tool } from '../src/tool';
import {
  FUNCTION_TOOL_NAMESPACE,
  FUNCTION_TOOL_NAMESPACE_DESCRIPTION,
} from '../src/toolIdentity';
import type * as protocol from '../src/types/protocol';

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
  function createLegacyNamespacedTool<T extends Record<string, any>>(
    tool: T,
    namespace: string,
    description: string,
  ): T {
    return Object.defineProperties(tool, {
      [FUNCTION_TOOL_NAMESPACE]: {
        value: namespace,
        enumerable: false,
        configurable: true,
      },
      [FUNCTION_TOOL_NAMESPACE_DESCRIPTION]: {
        value: description,
        enumerable: false,
        configurable: true,
      },
    });
  }

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

    it('exposes the tool name and call id from function calls', () => {
      expect(item.toolName).toBe('test');
      expect(item.callId).toBe('test');
    });

    it('exposes the hosted tool name and falls back to the item id for call id', () => {
      const hostedToolCall = new ToolCallItem(
        {
          id: 'hosted-call-id',
          type: 'hosted_tool_call',
          name: 'web_search_call',
          arguments: '{"query":"OpenAI"}',
          status: 'completed',
        },
        new Agent({ name: 'TestAgent' }),
      );

      expect(hostedToolCall.toolName).toBe('web_search_call');
      expect(hostedToolCall.callId).toBe('hosted-call-id');
    });

    it('returns undefined for missing tool names', () => {
      const shellCall = new ToolCallItem(
        {
          id: 'shell-id',
          type: 'shell_call',
          callId: 'shell-call-id',
          action: { commands: ['echo hi'] },
          status: 'completed',
        },
        new Agent({ name: 'TestAgent' }),
      );

      expect(shellCall.toolName).toBeUndefined();
      expect(shellCall.callId).toBe('shell-call-id');
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

    it('exposes the call id from tool call outputs', () => {
      expect(item.callId).toBe('test');
    });

    it('falls back to the raw item id for call id', () => {
      const rawItem = {
        id: 'result-id',
        type: 'function_call_result',
        name: 'test',
        output: 'ok',
        status: 'completed',
      } as unknown as protocol.FunctionCallResultItem;
      const outputItem = new ToolCallOutputItem(
        rawItem,
        new Agent({ name: 'TestAgent' }),
        'ok',
      );

      expect(outputItem.callId).toBe('result-id');
    });

    it('returns undefined when no call id is available', () => {
      const rawItem = {
        type: 'function_call_result',
        name: 'test',
        output: 'ok',
        status: 'completed',
      } as unknown as protocol.FunctionCallResultItem;
      const outputItem = new ToolCallOutputItem(
        rawItem,
        new Agent({ name: 'TestAgent' }),
        'ok',
      );

      expect(outputItem.callId).toBeUndefined();
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

    it('keeps top-level deferred approval names unqualified without agent tool metadata', () => {
      const deferredItem = new ToolApprovalItem(
        {
          id: 'approval_1',
          type: 'function_call',
          callId: 'call_1',
          name: 'get_shipping_eta',
          namespace: 'get_shipping_eta',
          arguments: '{}',
          status: 'completed',
        },
        new Agent({ name: 'DeferredApprovalAgent' }),
      );

      expect(deferredItem.toolName).toBe('get_shipping_eta');
      expect(deferredItem.name).toBe('get_shipping_eta');
    });

    it('keeps qualified approval names when agent tools resolve a same-name namespace', () => {
      const namespacedLookupAccount = createLegacyNamespacedTool(
        tool({
          name: 'lookup_account',
          description: 'Look up an account.',
          parameters: z.object({
            accountId: z.string(),
          }),
          deferLoading: true,
          execute: async () => 'ok',
        }),
        'lookup_account',
        'Resolve same-name namespace members.',
      );

      const namespacedItem = new ToolApprovalItem(
        {
          id: 'approval_2',
          type: 'function_call',
          callId: 'call_2',
          name: 'lookup_account',
          namespace: 'lookup_account',
          arguments: '{}',
          status: 'completed',
        },
        new Agent({
          name: 'NamespacedApprovalAgent',
          tools: [namespacedLookupAccount],
        }),
      );

      expect(namespacedItem.toolName).toBe('lookup_account.lookup_account');
      expect(namespacedItem.name).toBe('lookup_account.lookup_account');
    });
  });
});
