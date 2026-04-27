import { describe, expect, it } from 'vitest';
import { applySessionHistoryMutations } from '../src/memory/historyMutations';
import type { SessionHistoryMutation } from '../src/memory/session';
import type { AgentInputItem } from '../src/types';

const userMessage = (content: string): AgentInputItem => ({
  type: 'message',
  role: 'user',
  content,
});

const functionCall = (
  callId: string,
  name: string,
  args: string,
): Extract<AgentInputItem, { type: 'function_call' }> => ({
  type: 'function_call',
  callId,
  name,
  arguments: args,
  status: 'completed',
});

describe('applySessionHistoryMutations', () => {
  it('replaces matching function calls once and removes duplicates', () => {
    const replacement = functionCall('call_1', 'fixed', '{"ok":true}');
    const mutation: SessionHistoryMutation = {
      type: 'replace_function_call',
      callId: 'call_1',
      replacement,
    };
    const items: AgentInputItem[] = [
      userMessage('before'),
      functionCall('call_1', 'broken', '{}'),
      functionCall('call_2', 'keep', '{}'),
      functionCall('call_1', 'duplicate', '{}'),
      userMessage('after'),
    ];

    expect(applySessionHistoryMutations(items, [mutation])).toEqual([
      userMessage('before'),
      replacement,
      functionCall('call_2', 'keep', '{}'),
      userMessage('after'),
    ]);
  });

  it('returns cloned items and cloned replacements', () => {
    const original = functionCall('call_1', 'broken', '{}');
    const replacement = functionCall('call_1', 'fixed', '{"ok":true}');

    const result = applySessionHistoryMutations(
      [original],
      [
        {
          type: 'replace_function_call',
          callId: 'call_1',
          replacement,
        },
      ],
    );

    expect(result).toEqual([replacement]);
    expect(result[0]).not.toBe(original);
    expect(result[0]).not.toBe(replacement);
  });
});
