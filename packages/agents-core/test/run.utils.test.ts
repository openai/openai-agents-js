import { describe, it, expect } from 'vitest';
import { getTurnInput } from '../src/run';
import {
  RunMessageOutputItem as MessageOutputItem,
  RunCompactionItem as CompactionItem,
  RunReasoningItem as ReasoningItem,
  RunToolCallItem,
  RunToolCallOutputItem,
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

  it('keeps only items from the latest compaction marker', () => {
    const agent = new Agent({ name: 'A' });
    const earlierMessage = new MessageOutputItem(TEST_MODEL_MESSAGE, agent);
    const compaction = {
      type: 'compaction',
      id: 'cmp_latest',
      encrypted_content: 'ciphertext',
    } satisfies protocol.CompactionItem;
    const latestMessage = {
      ...TEST_MODEL_MESSAGE,
      id: 'msg_latest',
    };

    const result = getTurnInput('old input', [
      earlierMessage,
      new CompactionItem(compaction, agent),
      new MessageOutputItem(latestMessage, agent),
    ]);

    expect(result).toEqual([compaction, latestMessage]);
  });

  it('drops orphan calls before considering pre-compaction results', () => {
    const agent = new Agent({ name: 'A' });
    const callId = 'call_reused_after_compaction';
    const oldResult = new RunToolCallOutputItem(
      {
        type: 'function_call_result',
        name: 'reused_tool',
        callId,
        output: 'old result',
        status: 'completed',
      },
      agent,
      'old result',
    );
    const compaction = {
      type: 'compaction',
      id: 'cmp_reused_call',
      encrypted_content: 'ciphertext',
    } satisfies protocol.CompactionItem;
    const newCall = new RunToolCallItem(
      {
        type: 'function_call',
        name: 'reused_tool',
        callId,
        arguments: '{}',
        status: 'completed',
      },
      agent,
    );

    const result = getTurnInput('old input', [
      oldResult,
      new CompactionItem(compaction, agent),
      newCall,
    ]);

    expect(result).toEqual([compaction]);
  });
});
