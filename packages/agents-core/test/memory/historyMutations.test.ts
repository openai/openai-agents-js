import { describe, expect, it } from 'vitest';

import type { AgentInputItem } from '../../src';
import { applySessionHistoryMutations } from '../../src/memory/historyMutations';

describe('applySessionHistoryMutations', () => {
  it('replaces the first matching function call and drops later duplicates', () => {
    const items: AgentInputItem[] = [
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'function_call',
        callId: 'call_override',
        name: 'lookup_customer_profile',
        status: 'completed',
        arguments: JSON.stringify({ id: '1' }),
      },
      {
        type: 'function_call',
        callId: 'call_override',
        name: 'lookup_customer_profile',
        status: 'completed',
        arguments: JSON.stringify({ id: 'stale-duplicate' }),
      },
      {
        type: 'function_call_result',
        name: 'lookup_customer_profile',
        callId: 'call_override',
        status: 'completed',
        output: {
          type: 'text',
          text: 'Customer 2 details.',
        },
      },
    ];

    const rewritten = applySessionHistoryMutations(items, [
      {
        type: 'replace_function_call',
        callId: 'call_override',
        replacement: {
          type: 'function_call',
          callId: 'call_override',
          name: 'lookup_customer_profile',
          status: 'completed',
          arguments: JSON.stringify({ id: '2' }),
        },
      },
    ]);

    expect(rewritten).toEqual([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'function_call',
        callId: 'call_override',
        name: 'lookup_customer_profile',
        status: 'completed',
        arguments: JSON.stringify({ id: '2' }),
      },
      {
        type: 'function_call_result',
        name: 'lookup_customer_profile',
        callId: 'call_override',
        status: 'completed',
        output: {
          type: 'text',
          text: 'Customer 2 details.',
        },
      },
    ]);
  });

  it('leaves history unchanged when compaction already removed the target function call', () => {
    const items: AgentInputItem[] = [
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'function_call_result',
        name: 'lookup_customer_profile',
        callId: 'call_override',
        status: 'completed',
        output: {
          type: 'text',
          text: 'Customer 2 details.',
        },
      },
    ];

    const rewritten = applySessionHistoryMutations(items, [
      {
        type: 'replace_function_call',
        callId: 'call_override',
        replacement: {
          type: 'function_call',
          callId: 'call_override',
          name: 'lookup_customer_profile',
          status: 'completed',
          arguments: JSON.stringify({ id: '2' }),
        },
      },
    ]);

    expect(rewritten).toEqual(items);
  });
});
