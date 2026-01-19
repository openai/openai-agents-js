import { describe, expect, it, vi } from 'vitest';

import { MemorySession } from '@openai/agents-core';
import { UserError } from '@openai/agents-core';

import { OpenAIResponsesCompactionSession } from '../src';
import { OPENAI_SESSION_API } from '../src/memory/openaiSessionApi';

describe('OpenAIResponsesCompactionSession', () => {
  it('rejects non-OpenAI model names', () => {
    expect(() => {
      new OpenAIResponsesCompactionSession({
        client: {} as any,
        model: 'yet-another-model',
      });
    }).toThrow(/Unsupported model/);
  });

  it('rejects whitespace-only model names', () => {
    expect(() => {
      new OpenAIResponsesCompactionSession({
        client: {} as any,
        model: '   ',
      });
    }).toThrow(/Unsupported model/);
  });

  it('rejects conversations-backed sessions', () => {
    const underlyingSession = new MemorySession();
    Object.defineProperty(underlyingSession, OPENAI_SESSION_API, {
      value: 'conversations',
    });

    expect(() => {
      new OpenAIResponsesCompactionSession({
        client: {} as any,
        underlyingSession,
      });
    }).toThrow(UserError);
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

  it('compacts using input mode without a response id', async () => {
    const compact = vi.fn().mockResolvedValue({
      output: [],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
    });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      compactionMode: 'input',
    });

    await session.addItems([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'world' }],
      },
    ] as any);

    await session.runCompaction({ force: true });

    expect(compact).toHaveBeenCalledTimes(1);
    const [request] = compact.mock.calls[0] ?? [];
    expect(request).toMatchObject({ model: 'gpt-4.1' });
    expect(request.previous_response_id).toBeUndefined();
    expect(request.input).toHaveLength(2);
    expect(request.input[0]).toMatchObject({
      role: 'user',
      content: 'hello',
    });
    expect(request.input[1]).toMatchObject({
      type: 'message',
      role: 'assistant',
    });
  });

  it('defaults to auto compaction and uses input without a response id', async () => {
    const compact = vi.fn().mockResolvedValue({
      output: [],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
    });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
    });

    await session.addItems([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
    ] as any);

    await session.runCompaction({ force: true });

    expect(compact).toHaveBeenCalledTimes(1);
    const [request] = compact.mock.calls[0] ?? [];
    expect(request.previous_response_id).toBeUndefined();
    expect(request.input).toHaveLength(1);
  });

  it('auto mode uses input when store is false', async () => {
    const compact = vi.fn().mockResolvedValue({
      output: [],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
    });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      compactionMode: 'auto',
    });

    await session.addItems([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'world' }],
      },
    ] as any);

    await session.runCompaction({
      responseId: 'resp_auto',
      store: false,
      force: true,
    });

    expect(compact).toHaveBeenCalledTimes(1);
    const [request] = compact.mock.calls[0] ?? [];
    expect(request).toMatchObject({ model: 'gpt-4.1' });
    expect(request.previous_response_id).toBeUndefined();
    expect(request.input).toHaveLength(2);
  });

  it('auto mode remembers store settings when store is omitted', async () => {
    const compact = vi.fn().mockResolvedValue({
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'compacted output' }],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      },
    });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      compactionMode: 'auto',
    });

    await session.addItems([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'world' }],
      },
    ] as any);

    await session.runCompaction({
      responseId: 'resp_auto',
      store: false,
      force: true,
    });
    await session.runCompaction({ force: true });

    expect(compact).toHaveBeenCalledTimes(2);
    const [firstRequest] = compact.mock.calls[0] ?? [];
    const [secondRequest] = compact.mock.calls[1] ?? [];
    expect(firstRequest.previous_response_id).toBeUndefined();
    expect(secondRequest.previous_response_id).toBeUndefined();
    expect(secondRequest.input).toHaveLength(1);
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
      usage: {
        input_tokens: 7,
        output_tokens: 11,
        total_tokens: 18,
      },
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

    const compactionResult = await session.runCompaction({
      responseId: 'resp_2',
      force: true,
    });
    expect(compactionResult?.usage).toMatchObject({
      inputTokens: 7,
      outputTokens: 11,
      totalTokens: 18,
      endpoint: 'responses.compact',
    });
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

  it('replaces history after compaction and reuses the stored response id', async () => {
    const compact = vi
      .fn()
      .mockResolvedValueOnce({
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'compacted output' }],
          },
        ],
        usage: {
          input_tokens: 2,
          output_tokens: 3,
          total_tokens: 5,
        },
      })
      .mockResolvedValueOnce({
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'second pass' }],
          },
        ],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
        },
      });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
    });

    await session.addItems([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }],
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'first output' }],
      },
    ] as any);

    await session.runCompaction({ responseId: 'resp_store', force: true });

    expect(compact).toHaveBeenCalledWith({
      previous_response_id: 'resp_store',
      model: 'gpt-4.1',
    });
    expect(await session.getItems()).toEqual([
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'compacted output' }],
      },
    ]);

    await session.addItems([
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'follow up' }],
      },
    ] as any);

    await session.runCompaction({ force: true });

    expect(compact).toHaveBeenCalledTimes(2);
    expect(compact).toHaveBeenLastCalledWith({
      previous_response_id: 'resp_store',
      model: 'gpt-4.1',
    });
    expect(await session.getItems()).toEqual([
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'second pass' }],
      },
    ]);
  });

  it('throws when runCompaction is called without a responseId in previous_response_id mode', async () => {
    const compact = vi.fn();
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      compactionMode: 'previous_response_id',
    });

    await expect(session.runCompaction({} as any)).rejects.toBeInstanceOf(
      UserError,
    );
  });
});
