import { describe, expect, it, vi } from 'vitest';
import {
  Agent,
  MemorySession,
  Runner,
  RunHandoffCallItem,
  RunMessageOutputItem,
  RunState,
  UserError,
  Usage,
  defaultHandoffHistoryMapper,
  handoff,
  nestHandoffHistory,
  tool,
  user,
} from '../src';
import type {
  AgentInputItem,
  Model,
  ModelRequest,
  ModelResponse,
  StreamEvent,
} from '../src';
import { fakeModelMessage } from './stubs';
import { z } from 'zod';

class RecordingModel implements Model {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error('No response configured.');
    }
    return response;
  }

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error('No response configured.');
    }
    yield {
      type: 'response_done',
      response: {
        id: response.responseId ?? `response-${this.requests.length}`,
        usage: {
          requests: 1,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        output: response.output,
      },
    } as StreamEvent;
  }
}

function response(
  output: ModelResponse['output'],
  responseId: string,
): ModelResponse {
  return { output, responseId, usage: new Usage() };
}

function createHandoffScenario(options?: {
  handoffOverrides?: Parameters<typeof handoff>[1];
}) {
  const targetModel = new RecordingModel([
    response([fakeModelMessage('Target answer')], 'target-response'),
  ]);
  const targetAgent = new Agent({ name: 'Target', model: targetModel });
  const targetHandoff = handoff(targetAgent, options?.handoffOverrides);
  const sourceModel = new RecordingModel([
    response(
      [
        fakeModelMessage('Source context'),
        {
          type: 'function_call',
          name: targetHandoff.toolName,
          callId: 'handoff-call',
          status: 'completed',
          arguments: '{}',
        },
      ],
      'source-response',
    ),
  ]);
  const sourceAgent = new Agent({
    name: 'Source',
    model: sourceModel,
    handoffs: [targetHandoff],
  });

  return { sourceAgent, sourceModel, targetAgent, targetModel, targetHandoff };
}

function requestInput(model: RecordingModel): AgentInputItem[] {
  return model.requests[0]?.input as AgentInputItem[];
}

function textOf(item: AgentInputItem): string {
  if (!('content' in item)) {
    return '';
  }
  if (typeof item.content === 'string') {
    return item.content;
  }
  return item.content.map((part) => ('text' in part ? part.text : '')).join('');
}

describe('nested handoff history helpers', () => {
  it('creates a numbered assistant summary without provider metadata', () => {
    const transcript: AgentInputItem[] = [
      user('What happened?'),
      {
        type: 'function_call',
        name: 'lookup',
        callId: 'lookup-call',
        arguments: '{}',
        providerData: { secret: 'not-in-summary' },
      },
    ];

    const [summary] = defaultHandoffHistoryMapper(transcript);
    const text = textOf(summary);

    expect(summary).toMatchObject({ role: 'assistant' });
    expect(text).toContain('<CONVERSATION HISTORY>');
    expect(text).toContain('1. user: What happened?');
    expect(text).toContain('2. {"type":"function_call"');
    expect(text).not.toContain('not-in-summary');
    expect(text).toContain('</CONVERSATION HISTORY>');
  });

  it('preserves complete new items while compacting model input', () => {
    const agent = new Agent({ name: 'Source' });
    const call = new RunHandoffCallItem(
      {
        type: 'function_call',
        name: 'transfer_to_target',
        callId: 'handoff-call',
        arguments: '{}',
      },
      agent,
    );
    const message = new RunMessageOutputItem(
      fakeModelMessage('Visible handoff message'),
      agent,
    );
    const data = {
      inputHistory: 'Original user request',
      preHandoffItems: [],
      newItems: [message, call],
    };

    const nested = nestHandoffHistory(data);

    expect(nested.newItems).toEqual([message, call]);
    expect(nested.inputItems).toEqual([]);
    expect(nested.preHandoffItems).toEqual([]);
    expect(Array.isArray(nested.inputHistory)).toBe(true);
    const nestedInput = nested.inputHistory as AgentInputItem[];
    expect(textOf(nestedInput[0])).toContain('Original user request');
    expect(textOf(nestedInput[1])).toContain('Visible handoff message');
    expect(textOf(nestedInput[2])).toContain('handoff-call');
  });

  it('passes complete program-owned transcripts to a custom mapper', () => {
    const agent = new Agent({ name: 'Source' });
    const programItem = {
      type: 'program',
      callId: 'program-call',
      code: 'lookup();',
    } as AgentInputItem;
    const programOwnedCall = {
      type: 'function_call',
      name: 'lookup',
      callId: 'lookup-call',
      arguments: '{}',
      caller: { type: 'program', callerId: 'program-call' },
    } as AgentInputItem;
    const runItems = [programItem, programOwnedCall].map(
      (rawItem) => ({ type: 'tool_call_item', rawItem, agent }) as any,
    );
    const mapper = vi.fn(() => [user('Mapped transcript')]);

    const nested = nestHandoffHistory(
      {
        inputHistory: 'Original request',
        preHandoffItems: runItems,
        newItems: [],
      },
      { historyMapper: mapper },
    );

    expect(mapper).toHaveBeenCalledWith([
      { type: 'message', role: 'user', content: 'Original request' },
      programItem,
      programOwnedCall,
    ]);
    expect(nested.inputHistory).toEqual([user('Mapped transcript')]);
    expect(nested.inputItems).toEqual([]);
  });

  it('keeps hosted program transcripts together inside the summary', () => {
    const agent = new Agent({ name: 'Source' });
    const programTranscript: AgentInputItem[] = [
      {
        type: 'program',
        callId: 'program-call',
        code: 'lookup();',
      } as AgentInputItem,
      {
        type: 'function_call',
        name: 'lookup',
        callId: 'lookup-call',
        arguments: '{}',
        caller: { type: 'program', callerId: 'program-call' },
      } as AgentInputItem,
      {
        type: 'program_output',
        callId: 'program-call',
        output: 'complete',
      } as AgentInputItem,
    ];
    const runItems = programTranscript.map(
      (rawItem) => ({ type: 'tool_call_item', rawItem, agent }) as any,
    );

    const nested = nestHandoffHistory({
      inputHistory: 'Original request',
      preHandoffItems: [],
      newItems: runItems,
    });
    const history = nested.inputHistory as AgentInputItem[];

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ role: 'assistant' });
    expect(textOf(history[0])).toContain('"type":"program"');
    expect(textOf(history[0])).toContain('"caller":{"type":"program"');
    expect(textOf(history[0])).toContain('"type":"program_output"');
  });

  it('flattens an existing summary before creating a later handoff summary', () => {
    const [existingSummary] = defaultHandoffHistoryMapper([
      user('First request'),
    ]);

    const nested = nestHandoffHistory({
      inputHistory: [existingSummary],
      preHandoffItems: [],
      newItems: [],
    });
    const history = nested.inputHistory as AgentInputItem[];

    expect(history).toHaveLength(1);
    expect(textOf(history[0]).match(/<CONVERSATION HISTORY>/g)).toHaveLength(1);
    expect(textOf(history[0])).toContain('First request');
  });
});

describe('nested handoff run ownership', () => {
  it('keeps existing handoff history unchanged by default', async () => {
    const { sourceAgent, targetModel } = createHandoffScenario();

    await new Runner({ tracingDisabled: true }).run(
      sourceAgent,
      'User request',
    );

    expect(requestInput(targetModel).map((item) => item.type)).toEqual([
      'message',
      'message',
      'function_call',
      'function_call_result',
    ]);
  });

  it('compacts next-agent input while preserving full session history', async () => {
    const { sourceAgent, targetModel } = createHandoffScenario();
    const session = new MemorySession();

    const result = await new Runner({
      tracingDisabled: true,
      nestHandoffHistory: true,
    }).run(sourceAgent, 'User request', { session });

    const downstreamInput = requestInput(targetModel);
    expect(downstreamInput.some((item) => item.type === 'function_call')).toBe(
      false,
    );
    expect(
      downstreamInput.some((item) => item.type === 'function_call_result'),
    ).toBe(false);
    expect(downstreamInput.map(textOf).join('\n')).toContain('User request');
    expect(downstreamInput.map(textOf).join('\n')).toContain('Source context');

    const sessionHistory = await session.getItems();
    expect(
      sessionHistory.filter((item) => item.type === 'function_call'),
    ).toHaveLength(1);
    expect(
      sessionHistory.filter((item) => item.type === 'function_call_result'),
    ).toHaveLength(1);
    expect(
      result.newItems.some((item) => item.type === 'handoff_call_item'),
    ).toBe(true);
    expect(result.history.some((item) => item.type === 'function_call')).toBe(
      false,
    );
  });

  it('honors per-handoff overrides in both directions', async () => {
    const disabled = createHandoffScenario({
      handoffOverrides: { nestHandoffHistory: false },
    });
    await new Runner({
      tracingDisabled: true,
      nestHandoffHistory: true,
    }).run(disabled.sourceAgent, 'User request');
    expect(requestInput(disabled.targetModel)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call' }),
      ]),
    );

    const enabled = createHandoffScenario({
      handoffOverrides: { nestHandoffHistory: true },
    });
    await new Runner({ tracingDisabled: true }).run(
      enabled.sourceAgent,
      'User request',
    );
    expect(
      requestInput(enabled.targetModel).some(
        (item) => item.type === 'function_call',
      ),
    ).toBe(false);
  });

  it('uses a custom mapper as the exact downstream model history', async () => {
    const { sourceAgent, targetModel } = createHandoffScenario();
    const mapper = vi.fn(() => [user('Only mapped context')]);

    await new Runner({
      tracingDisabled: true,
      nestHandoffHistory: true,
      handoffHistoryMapper: mapper,
    }).run(sourceAgent, 'User request');

    expect(mapper).toHaveBeenCalledOnce();
    expect(requestInput(targetModel)).toEqual([user('Only mapped context')]);
  });

  it('gives explicit input filters precedence over automatic history mapping', async () => {
    const { sourceAgent, targetModel } = createHandoffScenario({
      handoffOverrides: {
        inputFilter: (data) => ({
          ...data,
          inputHistory: [user('Explicit filter')],
          preHandoffItems: [],
          newItems: [],
        }),
      },
    });
    const mapper = vi.fn(() => [user('Unexpected mapper')]);

    await new Runner({
      tracingDisabled: true,
      nestHandoffHistory: true,
      handoffHistoryMapper: mapper,
    }).run(sourceAgent, 'User request');

    expect(mapper).not.toHaveBeenCalled();
    expect(requestInput(targetModel)).toEqual([user('Explicit filter')]);
  });

  it('keeps history compact across consecutive agent handoffs', async () => {
    const finalModel = new RecordingModel([
      response([fakeModelMessage('Final answer')], 'final-response'),
    ]);
    const finalAgent = new Agent({ name: 'Final', model: finalModel });
    const finalHandoff = handoff(finalAgent);
    const middleModel = new RecordingModel([
      response(
        [
          fakeModelMessage('Middle context'),
          {
            type: 'function_call',
            name: finalHandoff.toolName,
            callId: 'final-handoff',
            status: 'completed',
            arguments: '{}',
          },
        ],
        'middle-response',
      ),
    ]);
    const middleAgent = new Agent({
      name: 'Middle',
      model: middleModel,
      handoffs: [finalHandoff],
    });
    const middleHandoff = handoff(middleAgent);
    const sourceModel = new RecordingModel([
      response(
        [
          fakeModelMessage('Source context'),
          {
            type: 'function_call',
            name: middleHandoff.toolName,
            callId: 'middle-handoff',
            status: 'completed',
            arguments: '{}',
          },
        ],
        'source-response',
      ),
    ]);
    const sourceAgent = new Agent({
      name: 'Source',
      model: sourceModel,
      handoffs: [middleHandoff],
    });
    const session = new MemorySession();

    await new Runner({
      tracingDisabled: true,
      nestHandoffHistory: true,
    }).run(sourceAgent, 'User request', { session });

    const input = requestInput(finalModel);
    expect(input.some((item) => item.type === 'function_call')).toBe(false);
    expect(input.map(textOf).join('\n')).toContain('User request');
    expect(input.map(textOf).join('\n')).toContain('Source context');
    expect(input.map(textOf).join('\n')).toContain('Middle context');
    expect(
      (await session.getItems()).filter(
        (item) => item.type === 'function_call',
      ),
    ).toHaveLength(2);
  });

  it('lets explicit filters separate model input from session history', async () => {
    const { sourceAgent, targetModel } = createHandoffScenario({
      handoffOverrides: {
        inputFilter: (data) => ({
          ...data,
          inputHistory: [user('Filtered input')],
          preHandoffItems: [],
          inputItems: [],
        }),
      },
    });
    const session = new MemorySession();

    await new Runner({
      tracingDisabled: true,
      nestHandoffHistory: true,
    }).run(sourceAgent, 'User request', { session });

    expect(requestInput(targetModel)).toEqual([user('Filtered input')]);
    expect(
      (await session.getItems()).filter(
        (item) => item.type === 'function_call',
      ),
    ).toHaveLength(1);
  });

  it.each(['conversationId', 'previousResponseId'] as const)(
    'rejects rewriting server-managed %s history',
    async (option) => {
      const { sourceAgent, targetModel } = createHandoffScenario();

      await expect(
        new Runner({ tracingDisabled: true, nestHandoffHistory: true }).run(
          sourceAgent,
          'User request',
          { [option]: 'server-history' },
        ),
      ).rejects.toThrow(UserError);
      expect(targetModel.requests).toHaveLength(0);
    },
  );

  it('preserves compact history across serialized RunState snapshots', async () => {
    const { sourceAgent } = createHandoffScenario();
    const result = await new Runner({
      tracingDisabled: true,
      nestHandoffHistory: true,
    }).run(sourceAgent, 'User request');

    const restored = await RunState.fromString(
      sourceAgent,
      result.state.toString(),
    );

    expect(restored.history).toEqual(result.history);
    expect(restored._generatedItems).toHaveLength(result.newItems.length);
    expect(restored.getModelInputGeneratedItems()).toHaveLength(1);
  });

  it('preserves compact model history after approval interruption and resume', async () => {
    const approvalTool = tool({
      name: 'needs_approval',
      description: 'Requires approval.',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => 'approved',
    });
    const targetModel = new RecordingModel([
      response(
        [
          {
            type: 'function_call',
            name: approvalTool.name,
            callId: 'approval-call',
            status: 'completed',
            arguments: '{}',
          },
        ],
        'approval-response',
      ),
      response([fakeModelMessage('Approved answer')], 'approved-response'),
    ]);
    const targetAgent = new Agent({
      name: 'Target',
      model: targetModel,
      tools: [approvalTool],
    });
    const targetHandoff = handoff(targetAgent);
    const sourceModel = new RecordingModel([
      response(
        [
          {
            type: 'function_call',
            name: targetHandoff.toolName,
            callId: 'handoff-call',
            status: 'completed',
            arguments: '{}',
          },
        ],
        'source-response',
      ),
    ]);
    const sourceAgent = new Agent({
      name: 'Source',
      model: sourceModel,
      handoffs: [targetHandoff],
    });
    const runner = new Runner({
      tracingDisabled: true,
      nestHandoffHistory: true,
    });
    const interrupted = await runner.run(sourceAgent, 'User request');

    expect(interrupted.interruptions).toHaveLength(1);
    interrupted.state.approve(interrupted.interruptions[0]);
    const restored = await RunState.fromString(
      sourceAgent,
      interrupted.state.toString(),
    );
    const result = await runner.run(sourceAgent, restored);

    expect(result.finalOutput).toBe('Approved answer');
    const resumedInput = targetModel.requests[1].input as AgentInputItem[];
    expect(resumedInput.some((item) => item.type === 'function_call')).toBe(
      true,
    );
    expect(
      resumedInput.some(
        (item) =>
          item.type === 'function_call' && item.callId === 'handoff-call',
      ),
    ).toBe(false);
  });

  it('uses the same compact handoff history for streamed runs', async () => {
    const { sourceAgent, targetModel } = createHandoffScenario();
    const session = new MemorySession();
    const result = await new Runner({
      tracingDisabled: true,
      nestHandoffHistory: true,
    }).run(sourceAgent, 'User request', { session, stream: true });

    for await (const _event of result.toStream()) {
      // Drain the stream so all handoff steps finish.
    }
    await result.completed;

    expect(
      requestInput(targetModel).some((item) => item.type === 'function_call'),
    ).toBe(false);
    expect(
      (await session.getItems()).filter(
        (item) => item.type === 'function_call',
      ),
    ).toHaveLength(1);
  });
});
