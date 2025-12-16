import { describe, expect, it, vi } from 'vitest';

import { MemorySession } from '@openai/agents-core';
import { UserError } from '@openai/agents-core';

import { OpenAIResponsesCompactionSession } from '../src';

describe('OpenAIResponsesCompactionSession', () => {
  it('rejects non-OpenAI model names', () => {
    expect(() => {
      new OpenAIResponsesCompactionSession({
        client: {} as any,
        model: 'yet-another-model',
      });
    }).toThrow(/Unsupported model/);
  });

  it('allows unknown gpt-* model names', () => {
    expect(() => {
      new OpenAIResponsesCompactionSession({
        client: {} as any,
        model: 'gpt-9999-super-new-model',
      });
    }).not.toThrow();
  });

  it('allows fine-tuned gpt-* model ids', () => {
    expect(() => {
      new OpenAIResponsesCompactionSession({
        client: {} as any,
        model: 'ft:gpt-4.1-nano-2025-04-14:org:proj:suffix',
      });
    }).not.toThrow();
  });

  it('allows o* model names', () => {
    expect(() => {
      new OpenAIResponsesCompactionSession({
        client: {} as any,
        model: 'o1-pro',
      });
    }).not.toThrow();
  });

  it('skips compaction when the decision hook declines', async () => {
    const compact = vi.fn();
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      shouldTriggerCompaction: () => false,
    });

    await session.addItems([
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'hello' }],
      },
    ]);

    await session.runCompaction({ responseId: 'resp_1' });
    expect(compact).not.toHaveBeenCalled();
  });

  it('allows custom compaction decisions using the stored history', async () => {
    const compact = vi.fn().mockResolvedValue({
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'compacted output' }],
        },
      ],
    });
    const underlyingSession = new MemorySession();
    const decisionHistoryLengths: number[] = [];
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      underlyingSession,
      shouldTriggerCompaction: async ({ compactionCandidateItems }) => {
        decisionHistoryLengths.push(compactionCandidateItems.length);
        const estimatedTokens = compactionCandidateItems.reduce(
          (total, item) => total + JSON.stringify(item).length,
          0,
        );
        return estimatedTokens > 40;
      },
    });

    await session.addItems([
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'This reply is intentionally long to trigger compaction.',
          },
        ],
      },
    ]);

    await session.runCompaction({ responseId: 'resp_2' });

    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith({
      previous_response_id: 'resp_2',
      model: 'gpt-4.1',
    });
    expect(decisionHistoryLengths).toEqual([1]);

    const storedItems = await session.getItems();
    expect(storedItems).toEqual([
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'compacted output' }],
      },
    ]);
  });

  it('provides compaction candidates to the decision hook', async () => {
    const compact = vi.fn();
    const receivedCandidates: unknown[][] = [];
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      shouldTriggerCompaction: async ({ compactionCandidateItems }) => {
        receivedCandidates.push(compactionCandidateItems);
        return false;
      },
    });

    const userItem = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    };
    const assistantItem = {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'world' }],
    };

    await session.addItems([userItem, assistantItem] as any);
    await session.runCompaction({ responseId: 'resp_3' });

    expect(receivedCandidates).toEqual([[assistantItem]]);
    expect(compact).not.toHaveBeenCalled();
  });

  it('throws when runCompaction is called without a responseId', async () => {
    const compact = vi.fn();
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
    });

    await expect(session.runCompaction({} as any)).rejects.toBeInstanceOf(
      UserError,
    );
  });
});
