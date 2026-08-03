import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  MemorySession,
  OutputGuardrailTripwireTriggered,
  RunState,
  Usage,
  run,
  setTracingDisabled,
  tool,
  type AgentInputItem,
  type CallModelInputFilterArgs,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type OpenAIResponsesCompactionArgs,
  type OpenAIResponsesCompactionResult,
  type StreamEvent,
} from '../src';
import * as protocol from '../src/types/protocol';
import { fakeModelMessage } from './stubs';

type RunMode = 'non_streamed' | 'streamed';

class CompactionTrackingSession extends MemorySession {
  readonly compactionSnapshots: AgentInputItem[][] = [];
  readonly compactionArgs: (OpenAIResponsesCompactionArgs | undefined)[] = [];

  async runCompaction(
    args?: OpenAIResponsesCompactionArgs,
  ): Promise<OpenAIResponsesCompactionResult | null> {
    const snapshot = await this.getItems();
    this.compactionSnapshots.push(snapshot);
    this.compactionArgs.push(args);
    if (
      this.compactionSnapshots.length > 1 &&
      snapshot.some((item) => item.type === 'function_call_result') &&
      args?.compactionMode !== 'input'
    ) {
      await this.clearSession();
      await this.addItems(
        snapshot.filter((item) => item.type !== 'function_call_result'),
      );
    }
    return null;
  }
}

class FailingCheckpointCompactionSession extends CompactionTrackingSession {
  private failedCheckpoint = false;

  async runCompaction(
    args?: OpenAIResponsesCompactionArgs,
  ): Promise<OpenAIResponsesCompactionResult | null> {
    const result = await super.runCompaction(args);
    const snapshot = this.compactionSnapshots.at(-1) ?? [];
    if (
      !this.failedCheckpoint &&
      snapshot.some((item) => item.type === 'function_call_result')
    ) {
      this.failedCheckpoint = true;
      throw new Error('checkpoint compaction failed');
    }
    if (
      this.failedCheckpoint &&
      snapshot.some((item) => item.type === 'function_call_result') &&
      args?.compactionMode !== 'input'
    ) {
      await this.clearSession();
      await this.addItems(
        snapshot.filter((item) => item.type !== 'function_call_result'),
      );
    }
    return result;
  }
}

class ApprovalSessionModel implements Model {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error('No response found.');
    }
    return response;
  }

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
    const response = await this.getResponse(request);
    yield {
      type: 'response_done',
      response: {
        id: response.responseId ?? 'stream-response',
        output: response.output,
        usage: response.usage,
      },
    } as StreamEvent;
  }
}

function functionToolCall(
  name: string,
  callId: string,
  argumentsValue = '{}',
): protocol.FunctionCallItem {
  return {
    type: 'function_call',
    id: `${callId}-item`,
    callId,
    name,
    status: 'completed',
    arguments: argumentsValue,
    providerData: {},
  };
}

function getPersistedToolItems(items: AgentInputItem[]) {
  return items.filter(
    (
      item,
    ): item is protocol.FunctionCallItem | protocol.FunctionCallResultItem =>
      item.type === 'function_call' || item.type === 'function_call_result',
  );
}

describe('approved tool output guardrail session persistence', () => {
  beforeAll(() => {
    setTracingDisabled(true);
  });

  it.each<{
    mode: RunMode;
    tripwire: boolean;
  }>([
    { mode: 'non_streamed', tripwire: false },
    { mode: 'non_streamed', tripwire: true },
    { mode: 'streamed', tripwire: false },
    { mode: 'streamed', tripwire: true },
  ])(
    'persists an approved tool result once when $mode guardrails trip=$tripwire',
    async ({ mode, tripwire }) => {
      let guardrailShouldTrip = tripwire;
      const approvalTool = tool({
        name: 'approval_tool',
        description: 'Returns a result after approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'approved-result',
      });
      const model = new ApprovalSessionModel([
        {
          output: [functionToolCall('approval_tool', 'call-approved')],
          usage: new Usage(),
        },
        {
          output: [fakeModelMessage('done')],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Approval session agent',
        model,
        tools: [approvalTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'approval output guardrail',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: guardrailShouldTrip,
            }),
          },
        ],
      });
      const session = new CompactionTrackingSession();

      const runOnce = async (
        input: string | RunState<unknown, typeof agent>,
      ) => {
        if (mode === 'streamed') {
          const result = await run(agent, input, { session, stream: true });
          await result.completed;
          return result;
        }
        return await run(agent, input, { session });
      };

      const first = await runOnce('Use approval_tool');
      expect(first.interruptions).toHaveLength(1);
      first.state.approve(first.interruptions[0]);

      if (tripwire) {
        await expect(runOnce(first.state)).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
      } else {
        const resumed = await runOnce(first.state);
        expect(resumed.finalOutput).toBe('approved-result');
      }

      const persistedItems = await session.getItems();
      expect(
        persistedItems.map((item) =>
          item.type === 'message' ? `${item.type}:${item.role}` : item.type,
        ),
      ).toEqual(['message:user', 'function_call', 'function_call_result']);
      const persistedToolItems = getPersistedToolItems(persistedItems);
      expect(
        persistedToolItems.map((item) => [item.type, item.callId]),
      ).toEqual([
        ['function_call', 'call-approved'],
        ['function_call_result', 'call-approved'],
      ]);
      expect(persistedToolItems[1]).toMatchObject({
        type: 'function_call_result',
        output: { type: 'text', text: 'approved-result' },
      });
      expect(session.compactionSnapshots).toHaveLength(2);
      expect(session.compactionArgs[1]).toMatchObject({
        compactionMode: 'input',
      });
      expect(
        getPersistedToolItems(session.compactionSnapshots[1]).map((item) => [
          item.type,
          item.callId,
        ]),
      ).toEqual([
        ['function_call', 'call-approved'],
        ['function_call_result', 'call-approved'],
      ]);

      if (tripwire) {
        guardrailShouldTrip = false;
        const next = await runOnce('Continue');
        expect(next.finalOutput).toBe('done');

        const replayedInput = model.requests.at(-1)?.input;
        expect(Array.isArray(replayedInput)).toBe(true);
        const replayedToolItems = getPersistedToolItems(
          replayedInput as AgentInputItem[],
        );
        expect(
          replayedToolItems.map((item) => [item.type, item.callId]),
        ).toEqual([
          ['function_call', 'call-approved'],
          ['function_call_result', 'call-approved'],
        ]);
        expect(replayedToolItems[1]).toMatchObject({
          type: 'function_call_result',
          output: { type: 'text', text: 'approved-result' },
        });
      }
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'persists a nested approved tool result once when $mode guardrails trip',
    async (mode) => {
      let guardrailShouldTrip = true;
      const nestedApprovalTool = tool({
        name: 'nested_approval_tool',
        description: 'Returns a nested result after approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'nested-approved-result',
      });
      const nestedModel = new ApprovalSessionModel([
        {
          output: [
            functionToolCall('nested_approval_tool', 'nested-approved-call'),
          ],
          usage: new Usage(),
        },
        {
          output: [fakeModelMessage('nested-done')],
          usage: new Usage(),
        },
      ]);
      const nestedAgent = new Agent({
        name: 'Nested approval agent',
        model: nestedModel,
        tools: [nestedApprovalTool],
      });
      const nestedTool = nestedAgent.asTool({
        toolName: 'nested_agent_tool',
        toolDescription: 'Runs the nested approval agent.',
      });
      const outerModel = new ApprovalSessionModel([
        {
          output: [
            functionToolCall(
              nestedTool.name,
              'outer-agent-tool-call',
              JSON.stringify({ input: 'Use the nested approval tool' }),
            ),
          ],
          usage: new Usage(),
        },
        {
          output: [fakeModelMessage('outer-done')],
          usage: new Usage(),
        },
      ]);
      const outerAgent = new Agent({
        name: 'Outer approval agent',
        model: outerModel,
        tools: [nestedTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'outer output guardrail',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: guardrailShouldTrip,
            }),
          },
        ],
      });
      const session = new CompactionTrackingSession();

      const runOnce = async (
        input: string | RunState<unknown, typeof outerAgent>,
      ) => {
        if (mode === 'streamed') {
          const result = await run(outerAgent, input, {
            session,
            stream: true,
          });
          await result.completed;
          return result;
        }
        return await run(outerAgent, input, { session });
      };

      const first = await runOnce('Use nested_agent_tool');
      expect(first.interruptions).toHaveLength(1);
      expect(first.interruptions[0].agent).toBe(nestedAgent);
      expect(first.interruptions[0].rawItem).toMatchObject({
        callId: 'nested-approved-call',
      });
      first.state.approve(first.interruptions[0]);

      await expect(runOnce(first.state)).rejects.toBeInstanceOf(
        OutputGuardrailTripwireTriggered,
      );

      const persistedToolItems = getPersistedToolItems(
        await session.getItems(),
      );
      expect(
        persistedToolItems.map((item) => [item.type, item.callId]),
      ).toEqual([
        ['function_call', 'outer-agent-tool-call'],
        ['function_call_result', 'outer-agent-tool-call'],
      ]);
      expect(persistedToolItems[1]).toMatchObject({
        type: 'function_call_result',
        output: { type: 'text', text: 'nested-done' },
      });
      expect(session.compactionSnapshots).toHaveLength(2);
      expect(session.compactionArgs[1]).toMatchObject({
        compactionMode: 'input',
      });
      expect(
        getPersistedToolItems(session.compactionSnapshots[1]).map((item) => [
          item.type,
          item.callId,
        ]),
      ).toEqual([
        ['function_call', 'outer-agent-tool-call'],
        ['function_call_result', 'outer-agent-tool-call'],
      ]);

      guardrailShouldTrip = false;
      const next = await runOnce('Continue');
      expect(next.finalOutput).toBe('outer-done');
      const replayedInput = outerModel.requests.at(-1)?.input;
      expect(Array.isArray(replayedInput)).toBe(true);
      const replayedToolItems = getPersistedToolItems(
        replayedInput as AgentInputItem[],
      );
      expect(replayedToolItems.map((item) => [item.type, item.callId])).toEqual(
        [
          ['function_call', 'outer-agent-tool-call'],
          ['function_call_result', 'outer-agent-tool-call'],
        ],
      );
    },
  );

  it('runs streaming compaction after a partially approved resume', async () => {
    const approvalTool = tool({
      name: 'partial_approval_tool',
      description: 'Returns a result after approval.',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => 'partially-approved-result',
    });
    const model = new ApprovalSessionModel([
      {
        output: [
          functionToolCall('partial_approval_tool', 'call-approved-first'),
          functionToolCall('partial_approval_tool', 'call-still-pending'),
        ],
        usage: new Usage(),
      },
    ]);
    const agent = new Agent({
      name: 'Partial approval session agent',
      model,
      tools: [approvalTool],
    });
    const session = new CompactionTrackingSession();

    const first = await run(agent, 'Use both tools', {
      session,
      stream: true,
    });
    await first.completed;
    expect(first.interruptions).toHaveLength(2);
    expect(session.compactionSnapshots).toHaveLength(1);

    first.state.approve(first.interruptions[0]);
    const resumed = await run(agent, first.state, {
      session,
      stream: true,
    });
    await resumed.completed;

    expect(resumed.interruptions).toHaveLength(1);
    expect(resumed.interruptions[0].rawItem).toMatchObject({
      callId: 'call-still-pending',
    });
    expect(session.compactionSnapshots).toHaveLength(2);
    const persistedToolItems = getPersistedToolItems(
      session.compactionSnapshots[1],
    );
    expect(persistedToolItems.map((item) => [item.type, item.callId])).toEqual([
      ['function_call', 'call-approved-first'],
      ['function_call', 'call-still-pending'],
      ['function_call_result', 'call-approved-first'],
    ]);
  });

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'compacts an approved result once when a $mode resume is cancelled',
    async (mode) => {
      let markToolStarted: (() => void) | undefined;
      const toolStarted = new Promise<void>((resolve) => {
        markToolStarted = resolve;
      });
      const approvalTool = tool({
        name: 'cancelled_approval_tool',
        description: 'Returns after the resumed run is cancelled.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async (_input, _context, details) => {
          markToolStarted?.();
          const signal = details?.signal;
          if (!signal?.aborted) {
            await new Promise<void>((resolve) => {
              signal?.addEventListener('abort', () => resolve(), {
                once: true,
              });
            });
          }
          return 'cancelled-approved-result';
        },
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            functionToolCall(
              'cancelled_approval_tool',
              'call-cancelled-approved',
            ),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Cancelled approval session agent',
        model,
        tools: [approvalTool],
        toolUseBehavior: 'stop_on_first_tool',
      });
      const session = new CompactionTrackingSession();

      const first = await (async () => {
        if (mode === 'streamed') {
          const result = await run(agent, 'Use cancelled_approval_tool', {
            session,
            stream: true,
          });
          await result.completed;
          return result;
        }
        return await run(agent, 'Use cancelled_approval_tool', { session });
      })();
      expect(first.interruptions).toHaveLength(1);
      first.state.approve(first.interruptions[0]);

      if (mode === 'streamed') {
        const resumed = await run(agent, first.state, {
          session,
          stream: true,
        });
        const reader = (resumed.toStream() as any).getReader();
        await toolStarted;
        await reader.cancel('stop');
        await resumed.completed;
      } else {
        const controller = new AbortController();
        const abortReason = new Error('stop approved resume');
        const resumed = run(agent, first.state, {
          session,
          signal: controller.signal,
        });
        const rejection = expect(resumed).rejects.toBe(abortReason);
        await toolStarted;
        controller.abort(abortReason);
        await rejection;
      }

      expect(session.compactionSnapshots).toHaveLength(2);
      expect(
        getPersistedToolItems(await session.getItems()).map((item) => [
          item.type,
          item.callId,
        ]),
      ).toEqual([
        ['function_call', 'call-cancelled-approved'],
        ['function_call_result', 'call-cancelled-approved'],
      ]);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'compacts an empty post-resume response when $mode handling omits history',
    async (mode) => {
      const approvalTool = tool({
        name: 'empty_response_approval_tool',
        description: 'Returns a result after approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'approved-before-empty-response',
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            functionToolCall(
              'empty_response_approval_tool',
              'call-before-empty-response',
            ),
          ],
          usage: new Usage(),
          responseId: 'response-before-tool',
        },
        {
          output: [],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Empty post-resume response agent',
        model,
        modelSettings: { store: false },
        tools: [approvalTool],
        toolUseBehavior: 'run_llm_again',
      });
      const session = new CompactionTrackingSession();
      const runOnce = async (
        input: string | RunState<unknown, typeof agent>,
      ) => {
        const options = {
          session,
          maxTurns: 1,
          callModelInputFilter: ({ modelData }: CallModelInputFilterArgs) => ({
            ...modelData,
            input: modelData.input.filter(
              (item: AgentInputItem) => item.type !== 'function_call_result',
            ),
          }),
          errorHandlers: {
            maxTurns: () => ({
              finalOutput: 'handled-empty-response',
              includeInHistory: false,
            }),
          },
        } as const;
        if (mode === 'streamed') {
          const result = await run(agent, input, {
            ...options,
            stream: true,
          });
          await result.completed;
          return result;
        }
        return await run(agent, input, options);
      };

      const first = await runOnce('Use empty_response_approval_tool');
      expect(first.interruptions).toHaveLength(1);
      first.state.approve(first.interruptions[0]);

      const resumed = await runOnce(first.state);
      expect(resumed.finalOutput).toBe('handled-empty-response');
      expect(resumed.lastResponseId).toBe(
        mode === 'streamed' ? 'stream-response' : undefined,
      );
      expect(session.compactionSnapshots).toHaveLength(3);
      expect(session.compactionArgs[2]).toMatchObject({
        compactionMode: 'input',
        store: false,
      });
      expect(
        getPersistedToolItems(await session.getItems()).map((item) => [
          item.type,
          item.callId,
        ]),
      ).toEqual([
        ['function_call', 'call-before-empty-response'],
        ['function_call_result', 'call-before-empty-response'],
      ]);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'does not duplicate an approved result when $mode checkpoint compaction is retried',
    async (mode) => {
      const approvalTool = tool({
        name: 'retry_compaction_tool',
        description: 'Returns a result after approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'retry-compaction-result',
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            functionToolCall('retry_compaction_tool', 'call-retry-compaction'),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Retry checkpoint compaction agent',
        model,
        tools: [approvalTool],
        toolUseBehavior: 'stop_on_first_tool',
      });
      const session = new FailingCheckpointCompactionSession();
      const runOnce = async (
        input: string | RunState<unknown, typeof agent>,
      ) => {
        if (mode === 'streamed') {
          const result = await run(agent, input, { session, stream: true });
          await result.completed;
          return result;
        }
        return await run(agent, input, { session });
      };

      const first = await runOnce('Use retry_compaction_tool');
      expect(first.interruptions).toHaveLength(1);
      first.state.approve(first.interruptions[0]);

      await expect(runOnce(first.state)).rejects.toThrow(
        'checkpoint compaction failed',
      );
      const retried = await runOnce(first.state);

      expect(retried.finalOutput).toBe('retry-compaction-result');
      expect(
        getPersistedToolItems(await session.getItems()).map((item) => [
          item.type,
          item.callId,
        ]),
      ).toEqual([
        ['function_call', 'call-retry-compaction'],
        ['function_call_result', 'call-retry-compaction'],
      ]);
      expect(session.compactionArgs[1]).toMatchObject({
        compactionMode: 'input',
      });
      expect(session.compactionArgs[2]).toMatchObject({
        compactionMode: 'input',
      });
    },
  );
});
