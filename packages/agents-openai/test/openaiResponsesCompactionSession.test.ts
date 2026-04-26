import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  Agent,
  MemorySession,
  type Model,
  type ModelRequest,
  type ModelResponse,
  protocol,
  Runner,
  type ResponseStreamEvent,
  tool,
  Usage,
} from '@openai/agents-core';
import { UserError } from '@openai/agents-core';
import type { AgentInputItem, Session } from '@openai/agents-core';

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

    await session.runCompaction({ responseId: 'resp_pending', force: true });

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

  it('forces input compaction after local history rewrites even when a stored response id exists', async () => {
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
      underlyingSession: new MemorySession(),
    });

    await session.addItems([
      {
        type: 'function_call',
        callId: 'call_override',
        name: 'lookup_customer_profile',
        status: 'completed',
        arguments: JSON.stringify({ id: '1' }),
      },
      {
        type: 'function_call_result',
        callId: 'call_override',
        output: {
          type: 'text',
          text: 'Customer 1 details.',
        },
      },
    ] as AgentInputItem[]);

    await session.applyHistoryMutations({
      mutations: [
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
      ],
    });

    await session.runCompaction({
      responseId: 'resp_store',
      store: true,
      force: true,
    });

    expect(compact).toHaveBeenCalledTimes(1);
    const [request] = compact.mock.calls[0] ?? [];
    expect(request.previous_response_id).toBeUndefined();
    expect(request.input).toHaveLength(2);
    expect(request.input[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_override',
      name: 'lookup_customer_profile',
      status: 'completed',
      arguments: JSON.stringify({ id: '2' }),
    });
    expect(request.input[1]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_override',
      output: 'Customer 1 details.',
    });
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

  it('replaces history after compaction and falls back to input when later turns only add local items', async () => {
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
    const [secondRequest] = compact.mock.calls[1] ?? [];
    expect(secondRequest.previous_response_id).toBeUndefined();
    expect(secondRequest.model).toBe('gpt-4.1');
    expect(secondRequest.input).toMatchObject([
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'compacted output' }],
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'follow up' }],
      },
    ]);
    expect(await session.getItems()).toEqual([
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'second pass' }],
      },
    ]);
  });

  it('normalizes compacted user image messages before reusing them as input', async () => {
    const dataUrl = 'data:image/jpeg;base64,abc123';
    const compact = vi
      .fn()
      .mockResolvedValueOnce({
        output: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'analyse these images' },
              {
                type: 'input_image',
                detail: 'auto',
                file_id: null,
                image_url: dataUrl,
              },
            ],
          },
        ],
        usage: {
          input_tokens: 2,
          output_tokens: 1,
          total_tokens: 3,
        },
      })
      .mockResolvedValueOnce({
        output: [],
        usage: {
          input_tokens: 1,
          output_tokens: 0,
          total_tokens: 1,
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
        content: [
          { type: 'input_text', text: 'analyse these images' },
          {
            type: 'input_image',
            image: dataUrl,
          },
        ],
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'how can I help?' }],
      },
    ] as any);

    await session.runCompaction({ force: true, compactionMode: 'input' });

    expect(await session.getItems()).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'analyse these images' },
          {
            type: 'input_image',
            image: dataUrl,
            detail: 'auto',
          },
        ],
      },
    ]);

    await session.runCompaction({ force: true, compactionMode: 'input' });

    const [secondRequest] = compact.mock.calls[1] ?? [];
    expect(secondRequest.input).toHaveLength(1);
    expect(secondRequest.input[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'input_text', text: 'analyse these images' },
        {
          type: 'input_image',
          image_url: dataUrl,
          detail: 'auto',
        },
      ],
    });
    expect(secondRequest.input[0].content[1].file_id).toBeUndefined();
  });

  it('normalizes compacted user file_data messages before reusing them as input', async () => {
    const base64 = Buffer.from('inline-file').toString('base64');
    const compact = vi
      .fn()
      .mockResolvedValueOnce({
        output: [
          {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_file',
                file_data: base64,
                filename: 'notes.txt',
              },
            ],
          },
        ],
        usage: {
          input_tokens: 2,
          output_tokens: 1,
          total_tokens: 3,
        },
      })
      .mockResolvedValueOnce({
        output: [],
        usage: {
          input_tokens: 1,
          output_tokens: 0,
          total_tokens: 1,
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
        content: [
          {
            type: 'input_file',
            file: base64,
            filename: 'notes.txt',
          },
        ],
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'ready' }],
      },
    ] as any);

    await session.runCompaction({ force: true, compactionMode: 'input' });

    expect(await session.getItems()).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_file',
            file: base64,
            filename: 'notes.txt',
          },
        ],
      },
    ]);

    await session.runCompaction({ force: true, compactionMode: 'input' });

    const [secondRequest] = compact.mock.calls[1] ?? [];
    expect(secondRequest.input).toHaveLength(1);
    expect(secondRequest.input[0]).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'input_file',
          file_data: base64,
          filename: 'notes.txt',
        },
      ],
    });
    expect(secondRequest.input[0].content[0].file_id).toBeUndefined();
    expect(secondRequest.input[0].content[0].file_url).toBeUndefined();
  });

  it('preserves existing history when compacted output normalization fails', async () => {
    const history = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'world' }],
      },
    ] as const;
    const compact = vi.fn().mockResolvedValue({
      output: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', detail: 'auto' }],
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
      compactionMode: 'input',
    });

    await session.addItems([...history] as any);

    await expect(
      session.runCompaction({ force: true, compactionMode: 'input' }),
    ).rejects.toThrow(
      'Compaction input_image item missing image_url or file_id.',
    );

    expect(await session.getItems()).toEqual(history);
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

  it('skips compaction when input mode sees an unresolved function_call', async () => {
    const compact = vi.fn();
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      compactionMode: 'input',
      shouldTriggerCompaction: () => true,
    });

    await session.addItems([
      {
        type: 'message',
        role: 'user',
        content: 'Needs approval.',
      },
      {
        type: 'function_call',
        callId: 'call_pending',
        name: 'approved_echo',
        status: 'completed',
        arguments: JSON.stringify({ query: 'Needs approval.' }),
      },
    ] as AgentInputItem[]);

    await expect(session.runCompaction({ force: true })).resolves.toBeNull();
    expect(compact).not.toHaveBeenCalled();
  });

  it('skips compaction when previous_response_id mode sees an unresolved function_call', async () => {
    const compact = vi.fn();
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      compactionMode: 'previous_response_id',
      shouldTriggerCompaction: () => true,
    });

    await session.addItems([
      {
        type: 'message',
        role: 'user',
        content: 'Needs approval.',
      },
      {
        type: 'function_call',
        callId: 'call_pending',
        name: 'approved_echo',
        status: 'completed',
        arguments: JSON.stringify({ query: 'Needs approval.' }),
      },
    ] as AgentInputItem[]);

    await expect(
      session.runCompaction({ responseId: 'resp_pending', force: true }),
    ).resolves.toBeNull();
    expect(compact).not.toHaveBeenCalled();
  });

  it('forces input compaction after local-only tool outputs without a newer response id', async () => {
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
      compactionMode: 'previous_response_id',
      shouldTriggerCompaction: () => true,
    });

    await session.addItems([
      {
        type: 'message',
        role: 'user',
        content: 'Needs approval.',
      },
      {
        type: 'function_call',
        callId: 'call_pending',
        name: 'approved_echo',
        status: 'completed',
        arguments: JSON.stringify({ query: 'Needs approval.' }),
      },
    ] as AgentInputItem[]);

    await expect(
      session.runCompaction({ responseId: 'resp_pending', force: true }),
    ).resolves.toBeNull();
    expect(compact).not.toHaveBeenCalled();

    await session.addItems([
      {
        type: 'function_call_result',
        callId: 'call_pending',
        output: {
          type: 'text',
          text: 'approved:Needs approval.',
        },
      },
    ] as AgentInputItem[]);

    await session.runCompaction({ force: true });

    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith({
      input: [
        {
          role: 'user',
          content: 'Needs approval.',
        },
        {
          type: 'function_call',
          call_id: 'call_pending',
          name: 'approved_echo',
          status: 'completed',
          arguments: JSON.stringify({ query: 'Needs approval.' }),
        },
        {
          type: 'function_call_output',
          call_id: 'call_pending',
          output: 'approved:Needs approval.',
        },
      ],
      model: 'gpt-4.1',
    });
  });

  it('skips compaction on interrupted HITL turns until the tool result exists', async () => {
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
      shouldTriggerCompaction: () => true,
    });
    const approvalEchoTool = tool({
      name: 'approved_echo',
      description: 'Echoes back the approved query.',
      parameters: z.object({ query: z.string() }),
      async execute({ query }: { query: string }) {
        return `approved:${query}`;
      },
    });
    approvalEchoTool.needsApproval = async () => true;
    const model = new ApprovalScenarioModel();
    const agent = new Agent({
      name: 'Compaction interruption repro',
      instructions: 'Always call approved_echo before responding.',
      model: 'test-model',
      tools: [approvalEchoTool],
      modelSettings: { toolChoice: 'approved_echo' },
      toolUseBehavior: 'stop_on_first_tool',
    });
    const runner = new Runner({
      modelProvider: {
        getModel: vi.fn(async () => model),
      },
    });

    const firstResult = await runner.run(agent, 'Needs approval.', {
      session,
    });

    expect(firstResult.interruptions).toHaveLength(1);
    expect(compact).not.toHaveBeenCalled();
    await expect(session.getItems()).resolves.toMatchObject([
      {
        type: 'message',
        role: 'user',
        content: 'Needs approval.',
      },
      {
        type: 'function_call',
        name: 'approved_echo',
      },
    ]);

    firstResult.state.approve(firstResult.interruptions[0]);

    const resumed = await runner.run(agent, firstResult.state, { session });
    expect(resumed.finalOutput).toBe('approved:Needs approval.');
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('rewrites history before compaction when the underlying session is not rewrite-aware', async () => {
    class PlainSession implements Session {
      items: AgentInputItem[] = [];

      async getSessionId(): Promise<string> {
        return 'session';
      }

      async getItems(): Promise<AgentInputItem[]> {
        return this.items.map((item) => structuredClone(item));
      }

      async addItems(items: AgentInputItem[]): Promise<void> {
        this.items.push(...items);
      }

      async popItem(): Promise<AgentInputItem | undefined> {
        return this.items.pop();
      }

      async clearSession(): Promise<void> {
        this.items = [];
      }
    }

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
      underlyingSession: new PlainSession(),
      compactionMode: 'input',
    });

    await session.addItems([
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
        arguments: JSON.stringify({ id: '2' }),
      },
      {
        type: 'function_call_result',
        callId: 'call_override',
        output: {
          type: 'text',
          text: 'Customer 2 details.',
        },
      },
    ] as AgentInputItem[]);

    await session.applyHistoryMutations({
      mutations: [
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
      ],
    });

    expect(await session.getItems()).toEqual([
      {
        type: 'function_call',
        callId: 'call_override',
        name: 'lookup_customer_profile',
        status: 'completed',
        arguments: JSON.stringify({ id: '2' }),
      },
      {
        type: 'function_call_result',
        callId: 'call_override',
        output: {
          type: 'text',
          text: 'Customer 2 details.',
        },
      },
    ]);

    await session.runCompaction({ force: true });

    expect(compact).toHaveBeenCalledWith({
      input: [
        {
          type: 'function_call',
          call_id: 'call_override',
          name: 'lookup_customer_profile',
          status: 'completed',
          arguments: JSON.stringify({ id: '2' }),
        },
        {
          type: 'function_call_output',
          call_id: 'call_override',
          output: 'Customer 2 details.',
        },
      ],
      model: 'gpt-4.1',
    });
  });

  it('does not append a replacement when the underlying session already trimmed the original call', async () => {
    class PlainSession implements Session {
      items: AgentInputItem[] = [];

      async getSessionId(): Promise<string> {
        return 'session';
      }

      async getItems(): Promise<AgentInputItem[]> {
        return this.items.map((item) => structuredClone(item));
      }

      async addItems(items: AgentInputItem[]): Promise<void> {
        this.items.push(...items);
      }

      async popItem(): Promise<AgentInputItem | undefined> {
        return this.items.pop();
      }

      async clearSession(): Promise<void> {
        this.items = [];
      }
    }

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
      underlyingSession: new PlainSession(),
      compactionMode: 'input',
    });

    await session.addItems([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'function_call_result',
        callId: 'call_override',
        output: {
          type: 'text',
          text: 'Customer 2 details.',
        },
      },
    ] as AgentInputItem[]);

    await session.applyHistoryMutations({
      mutations: [
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
      ],
    });

    expect(await session.getItems()).toEqual([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'function_call_result',
        callId: 'call_override',
        output: {
          type: 'text',
          text: 'Customer 2 details.',
        },
      },
    ]);

    await session.runCompaction({ force: true });

    expect(compact).toHaveBeenCalledTimes(1);
    const [request] = compact.mock.calls[0] ?? [];
    expect(request.model).toBe('gpt-4.1');
    expect(request.input).toMatchObject([
      {
        role: 'user',
        content: 'hello',
      },
      {
        type: 'function_call_output',
        call_id: 'call_override',
        output: 'Customer 2 details.',
      },
    ]);
  });
});

class ApprovalScenarioModel implements Model {
  #counter = 0;

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const toolName =
      typeof request.modelSettings.toolChoice === 'string'
        ? request.modelSettings.toolChoice
        : 'approved_echo';
    const callId = `call_${(this.#counter += 1)}`;
    const toolCall: protocol.FunctionCallItem = {
      id: `fc_${callId}`,
      type: 'function_call',
      name: toolName,
      callId,
      status: 'completed',
      arguments: JSON.stringify({
        query: extractLastUserMessage(request.input),
      }),
      providerData: {},
    };

    return {
      usage: new Usage(),
      output: [toolCall],
    };
  }

  // eslint-disable-next-line require-yield -- this scenario does not stream.
  async *getStreamedResponse(
    _request: ModelRequest,
  ): AsyncIterable<ResponseStreamEvent> {
    throw new Error('Streaming is not supported in this scenario.');
  }
}

function extractLastUserMessage(input: ModelRequest['input']): string {
  if (typeof input === 'string') {
    return input;
  }

  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item.type !== 'message' || item.role !== 'user') {
      continue;
    }

    if (typeof item.content === 'string') {
      return item.content;
    }

    for (const contentItem of item.content) {
      if (
        contentItem.type === 'input_text' &&
        typeof contentItem.text === 'string'
      ) {
        return contentItem.text;
      }
    }
  }

  return '';
}
