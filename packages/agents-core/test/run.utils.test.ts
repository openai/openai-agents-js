import { describe, it, expect } from 'vitest';
import { getTurnInput } from '../src/run';
import {
  RunMessageOutputItem as MessageOutputItem,
  RunReasoningItem as ReasoningItem,
  RunToolCallItem,
} from '../src/items';
import { Agent } from '../src/agent';
import { TEST_MODEL_MESSAGE } from './stubs';
import * as protocol from '../src/types/protocol';

describe('getTurnInput', () => {
  it('combines original string input with generated items', () => {
    const agent = new Agent({ name: 'A' });
    const item = new MessageOutputItem(TEST_MODEL_MESSAGE, agent);
    const result = getTurnInput('hello', [item]);
    expect(result[0]).toMatchObject({ role: 'user', type: 'message' });
    expect(result[1]).toEqual(TEST_MODEL_MESSAGE);
  });

  it('preserves reasoning item IDs by default', () => {
    const agent = new Agent({ name: 'A' });
    const reasoning = new ReasoningItem(
      {
        type: 'reasoning',
        id: 'rs_123',
        content: [{ type: 'input_text', text: 'thinking' }],
      },
      agent,
    );

    const result = getTurnInput('hello', [reasoning]);
    expect(result[1]).toEqual({
      type: 'reasoning',
      id: 'rs_123',
      content: [{ type: 'input_text', text: 'thinking' }],
    });
  });

  it('omits reasoning item IDs when configured', () => {
    const agent = new Agent({ name: 'A' });
    const reasoning = new ReasoningItem(
      {
        type: 'reasoning',
        id: 'rs_456',
        content: [{ type: 'input_text', text: 'thinking' }],
      },
      agent,
    );

    const result = getTurnInput('hello', [reasoning], 'omit');
    expect(result[1]).toEqual({
      type: 'reasoning',
      content: [{ type: 'input_text', text: 'thinking' }],
    });
    expect(result[1]).not.toHaveProperty('id');
  });

  it('drops orphan hosted shell calls from generated history', () => {
    const agent = new Agent({ name: 'A' });
    const orphanShellCall = new RunToolCallItem(
      {
        type: 'shell_call',
        callId: 'shell_123',
        status: 'completed',
        action: { commands: ['echo hi'] },
      } satisfies protocol.ShellCallItem,
      agent,
    );

    const result = getTurnInput('hello', [orphanShellCall]);

    expect(result).toEqual([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
    ]);
  });
});
