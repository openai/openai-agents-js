import { describe, expect, it } from 'vitest';
import { sanitizeOpenAIResponsesInputItems } from '../src/sanitizeOpenAIResponsesInputItems';
import type { AgentInputItem } from '@openai/agents-core';

describe('sanitizeOpenAIResponsesInputItems', () => {
  it('minimizes reasoning and reorders before tool calls in repair mode', () => {
    const items: AgentInputItem[] = [
      { role: 'user', content: 'hello' },
      {
        type: 'function_call',
        id: 'fc_1',
        name: 'tool',
        callId: 'call_1',
        arguments: '{}',
        status: 'completed',
      },
      {
        type: 'function_call_result',
        id: 'fcr_1',
        name: 'tool',
        callId: 'call_1',
        status: 'completed',
        output: 'ok',
      },
      {
        type: 'reasoning',
        id: 'rs_1',
        content: [{ type: 'input_text', text: 'summary' }],
        providerData: { encrypted_content: 'enc' },
      },
    ];

    const repaired = sanitizeOpenAIResponsesInputItems(items, {
      store: true,
      mode: 'repair',
    });
    const reasoningIndex = repaired.findIndex(
      (item) => (item as { type?: string }).type === 'reasoning',
    );
    const callIndex = repaired.findIndex(
      (item) => (item as { type?: string }).type === 'function_call',
    );
    expect(reasoningIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeGreaterThan(-1);
    expect(reasoningIndex).toBeLessThan(callIndex);
    const reasoning = repaired[reasoningIndex] as {
      id?: string;
      content: Array<{ type: string }>;
    };
    expect(reasoning.id).toBeUndefined();
    expect(reasoning.content).toEqual([]);
  });

  it('drops reasoning when store is false', () => {
    const items: AgentInputItem[] = [
      { role: 'user', content: 'hello' },
      {
        type: 'reasoning',
        id: 'rs_1',
        content: [{ type: 'input_text', text: 'summary' }],
        providerData: { encrypted_content: 'enc' },
      },
      {
        type: 'function_call',
        id: 'fc_1',
        name: 'tool',
        callId: 'call_1',
        arguments: '{}',
        status: 'completed',
      },
    ];

    const repaired = sanitizeOpenAIResponsesInputItems(items, {
      store: false,
      mode: 'repair',
    });
    const hasReasoning = repaired.some(
      (item) => (item as { type?: string }).type === 'reasoning',
    );
    expect(hasReasoning).toBe(false);
  });

  it('strips providerData ids to avoid reintroducing item ids', () => {
    const items: AgentInputItem[] = [
      {
        type: 'reasoning',
        id: 'rs_1',
        content: [{ type: 'input_text', text: 'summary' }],
        providerData: { encrypted_content: 'enc', id: 'rs_1' },
      },
    ];

    const repaired = sanitizeOpenAIResponsesInputItems(items, {
      store: true,
      mode: 'repair',
    });
    const reasoning = repaired[0] as {
      id?: string;
      providerData?: { id?: string };
    };
    expect(reasoning.id).toBeUndefined();
    expect(reasoning.providerData?.id).toBeUndefined();
  });

  it('drops tool items in repair mode when outputs are unpaired', () => {
    const items: AgentInputItem[] = [
      {
        type: 'function_call_result',
        id: 'fcr_1',
        name: 'tool',
        callId: 'call_1',
        status: 'completed',
        output: 'ok',
      },
    ];

    const repaired = sanitizeOpenAIResponsesInputItems(items, {
      store: true,
      mode: 'repair',
    });
    const hasToolItems = repaired.some(
      (item) =>
        (item as { type?: string }).type === 'function_call' ||
        (item as { type?: string }).type === 'function_call_result',
    );
    expect(hasToolItems).toBe(false);
    const fallbackMessage = repaired.find(
      (item) =>
        (item as { role?: string }).role === 'user' &&
        typeof (item as { content?: string }).content === 'string' &&
        (item as { content?: string }).content?.includes(
          'Tool outputs (fallback):',
        ),
    );
    expect(fallbackMessage).toBeTruthy();
  });

  it('drops tool items when only tool calls are present', () => {
    const items: AgentInputItem[] = [
      {
        type: 'function_call',
        id: 'fc_1',
        name: 'tool',
        callId: 'call_1',
        arguments: '{}',
        status: 'completed',
      },
    ];

    const repaired = sanitizeOpenAIResponsesInputItems(items, {
      store: true,
      mode: 'repair',
    });
    const hasToolItems = repaired.some(
      (item) =>
        (item as { type?: string }).type === 'function_call' ||
        (item as { type?: string }).type === 'function_call_result',
    );
    expect(hasToolItems).toBe(false);
  });

  it('moves reasoning before hosted tool calls', () => {
    const items: AgentInputItem[] = [
      { role: 'user', content: 'hello' },
      {
        type: 'hosted_tool_call',
        id: 'hs_1',
        name: 'web_search_call',
        status: 'completed',
        output: 'result',
      },
      {
        type: 'reasoning',
        id: 'rs_1',
        content: [{ type: 'input_text', text: 'summary' }],
        providerData: { encrypted_content: 'enc' },
      },
    ];

    const repaired = sanitizeOpenAIResponsesInputItems(items, {
      store: true,
      mode: 'repair',
    });
    const reasoningIndex = repaired.findIndex(
      (item) => (item as { type?: string }).type === 'reasoning',
    );
    const toolIndex = repaired.findIndex(
      (item) => (item as { type?: string }).type === 'hosted_tool_call',
    );
    expect(reasoningIndex).toBeGreaterThan(-1);
    expect(toolIndex).toBeGreaterThan(-1);
    expect(reasoningIndex).toBeLessThan(toolIndex);
  });

  it('drops non-function tool outputs when unpaired', () => {
    const items: AgentInputItem[] = [
      {
        type: 'shell_call_output',
        id: 'sh_1',
        callId: 'call_1',
        output: [
          {
            stdout: 'ok',
            stderr: '',
            outcome: { type: 'exit', exitCode: 0 },
          },
        ],
      },
    ];

    const repaired = sanitizeOpenAIResponsesInputItems(items, {
      store: true,
      mode: 'repair',
    });
    const hasToolItems = repaired.some((item) =>
      ['shell_call', 'shell_call_output'].includes(
        (item as { type?: string }).type ?? '',
      ),
    );
    expect(hasToolItems).toBe(false);
    const fallbackMessage = repaired.find(
      (item) =>
        (item as { role?: string }).role === 'user' &&
        typeof (item as { content?: string }).content === 'string' &&
        (item as { content?: string }).content?.includes(
          'Tool outputs (fallback):',
        ),
    );
    expect(fallbackMessage).toBeTruthy();
  });

  it('drops non-function tool items in last_resort mode', () => {
    const items: AgentInputItem[] = [
      {
        type: 'computer_call',
        id: 'cc_1',
        callId: 'call_1',
        status: 'completed',
        action: { type: 'click', x: 1, y: 2, button: 'left' },
      },
      {
        type: 'computer_call_result',
        id: 'ccr_1',
        callId: 'call_1',
        output: { type: 'computer_screenshot', data: 'data:' },
      },
    ];

    const repaired = sanitizeOpenAIResponsesInputItems(items, {
      store: true,
      mode: 'last_resort',
    });
    const hasToolItems = repaired.some((item) =>
      ['computer_call', 'computer_call_result'].includes(
        (item as { type?: string }).type ?? '',
      ),
    );
    expect(hasToolItems).toBe(false);
  });

  it('drops tool items and appends a fallback message in last_resort mode', () => {
    const items: AgentInputItem[] = [
      {
        type: 'function_call_result',
        id: 'fcr_1',
        name: 'tool',
        callId: 'call_1',
        status: 'completed',
        output: 'ok',
      },
    ];

    const repaired = sanitizeOpenAIResponsesInputItems(items, {
      store: true,
      mode: 'last_resort',
    });
    const hasToolItems = repaired.some(
      (item) =>
        (item as { type?: string }).type === 'function_call' ||
        (item as { type?: string }).type === 'function_call_result',
    );
    expect(hasToolItems).toBe(false);
    const fallbackMessage = repaired.find(
      (item) =>
        (item as { role?: string }).role === 'user' &&
        typeof (item as { content?: string }).content === 'string' &&
        (item as { content?: string }).content?.includes(
          'Tool outputs (fallback):',
        ),
    );
    expect(fallbackMessage).toBeTruthy();
  });

  it('drops tool items when call_ids do not match', () => {
    const items: AgentInputItem[] = [
      {
        type: 'function_call',
        id: 'fc_1',
        name: 'tool',
        callId: 'call_1',
        arguments: '{}',
        status: 'completed',
      },
      {
        type: 'function_call_result',
        id: 'fcr_1',
        name: 'tool',
        callId: 'call_2',
        status: 'completed',
        output: 'ok',
      },
    ];

    const repaired = sanitizeOpenAIResponsesInputItems(items, {
      store: true,
      mode: 'repair',
    });
    const hasToolItems = repaired.some(
      (item) =>
        (item as { type?: string }).type === 'function_call' ||
        (item as { type?: string }).type === 'function_call_result',
    );
    expect(hasToolItems).toBe(false);
    const fallbackMessage = repaired.find(
      (item) =>
        (item as { role?: string }).role === 'user' &&
        typeof (item as { content?: string }).content === 'string' &&
        (item as { content?: string }).content?.includes(
          'Tool outputs (fallback):',
        ),
    );
    expect(fallbackMessage).toBeTruthy();
  });

  it('strips ids from duplicate reasoning items', () => {
    const items: AgentInputItem[] = [
      {
        type: 'reasoning',
        id: 'rs_dup',
        content: [{ type: 'input_text', text: 'summary' }],
        providerData: { encrypted_content: 'enc', id: 'rs_dup' },
      },
      {
        type: 'reasoning',
        id: 'rs_dup',
        content: [{ type: 'input_text', text: 'summary 2' }],
        providerData: { encrypted_content: 'enc2', id: 'rs_dup' },
      },
    ];

    const repaired = sanitizeOpenAIResponsesInputItems(items, {
      store: true,
      mode: 'repair',
    });
    const reasoningIds = repaired
      .filter((item) => (item as { type?: string }).type === 'reasoning')
      .map((item) => (item as { id?: string }).id);
    expect(reasoningIds).toEqual([undefined, undefined]);
  });
});
