import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  GuardrailExecutionError,
  MemorySession,
  OutputGuardrailTripwireTriggered,
  RunState,
  ToolGuardrailFunctionOutputFactory,
  Usage,
  defineToolInputGuardrail,
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
  type ToolUseBehavior,
} from '../src';
import * as protocol from '../src/types/protocol';
import { SandboxRuntimeManager } from '../src/sandbox/runtime';
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

class ReasoningPreservingSession extends CompactionTrackingSession {
  preserveReasoningItemIdsForPersistence(): boolean {
    return true;
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

const finalToolBehaviors: Array<{
  name: string;
  value: ToolUseBehavior;
}> = [
  { name: 'stop_on_first_tool', value: 'stop_on_first_tool' },
  {
    name: 'stopAtToolNames',
    value: { stopAtToolNames: ['commit_tool'] },
  },
  {
    name: 'custom finalizer',
    value: async (_context, results) => {
      const result = results.find((item) => item.type === 'function_output');
      return {
        isFinalOutput: true,
        isInterrupted: undefined,
        finalOutput: String(result?.output),
      };
    },
  },
];

function reasoningItem(id: string, text: string): protocol.ReasoningItem {
  return {
    type: 'reasoning',
    id,
    content: [{ type: 'input_text', text }],
  };
}

describe('committed tool output guardrail session persistence', () => {
  it.each(
    finalToolBehaviors.flatMap(({ name, value }) =>
      (['non_streamed', 'streamed'] as const).map((mode) => ({
        behaviorName: name,
        toolUseBehavior: value,
        mode,
      })),
    ),
  )(
    'persists a direct final tool once for $behaviorName in $mode mode when guardrails trip',
    async ({ toolUseBehavior, mode }) => {
      const executions: string[] = [];
      let guardrailShouldTrip = true;
      const commitTool = tool({
        name: 'commit_tool',
        description: 'Commits a side effect.',
        parameters: z.object({}),
        execute: async () => {
          executions.push('ran');
          return 'committed-result';
        },
      });
      const model = new ApprovalSessionModel([
        {
          output: [functionToolCall('commit_tool', 'call-committed')],
          usage: new Usage(),
        },
        {
          output: [fakeModelMessage('done')],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Committed tool agent',
        model,
        tools: [commitTool],
        toolUseBehavior,
        outputGuardrails: [
          {
            name: 'block committed result',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: guardrailShouldTrip,
            }),
          },
        ],
      });
      const session = new MemorySession();

      const runOnce = async (input: string) => {
        if (mode === 'streamed') {
          const result = await run(agent, input, { session, stream: true });
          await result.completed;
          return result;
        }
        return await run(agent, input, { session });
      };

      await expect(runOnce('Use commit_tool')).rejects.toBeInstanceOf(
        OutputGuardrailTripwireTriggered,
      );
      expect(executions).toEqual(['ran']);
      expect(
        (await session.getItems()).map((item) =>
          item.type === 'message' ? `${item.type}:${item.role}` : item.type,
        ),
      ).toEqual(['message:user', 'function_call', 'function_call_result']);

      guardrailShouldTrip = false;
      const followup = await runOnce('Continue');
      expect(followup.finalOutput).toBe('done');
      expect(executions).toEqual(['ran']);
      expect(
        getPersistedToolItems(model.requests.at(-1)?.input as AgentInputItem[]),
      ).toMatchObject([
        { type: 'function_call', callId: 'call-committed' },
        { type: 'function_call_result', callId: 'call-committed' },
      ]);
      expect(getPersistedToolItems(await session.getItems())).toHaveLength(2);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'persists a $mode committed tool after a blocked RunState is serialized before attaching a session',
    async (mode) => {
      const execute = vi.fn(async () => 'committed-result');
      const commitTool = tool({
        name: 'serialized_commit_tool',
        description: 'Commits a side effect before RunState serialization.',
        parameters: z.object({}),
        execute,
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            functionToolCall('serialized_commit_tool', 'call-serialized'),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Serialized committed tool agent',
        model,
        tools: [commitTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'keep blocking serialized committed result',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: true,
            }),
          },
        ],
      });

      let blockedState: RunState<undefined, typeof agent> | undefined;
      if (mode === 'streamed') {
        const result = await run(agent, 'Use serialized_commit_tool', {
          stream: true,
        });
        await expect(result.completed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
        blockedState = result.state;
      } else {
        try {
          await run(agent, 'Use serialized_commit_tool');
        } catch (error) {
          expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
          blockedState = (
            error as { state?: RunState<undefined, typeof agent> }
          ).state;
        }
      }
      expect(blockedState).toBeDefined();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.requests).toHaveLength(1);

      const restored = await RunState.fromString(
        agent,
        blockedState!.toString(),
      );
      const session = new MemorySession();
      if (mode === 'streamed') {
        const resumed = await run(agent, restored, { session, stream: true });
        await expect(resumed.completed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
      } else {
        await expect(run(agent, restored, { session })).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
      }

      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.requests).toHaveLength(1);
      expect(getPersistedToolItems(await session.getItems())).toMatchObject([
        { type: 'function_call', callId: 'call-serialized' },
        { type: 'function_call_result', callId: 'call-serialized' },
      ]);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'persists a $mode input rejection that closes an approved call checkpoint',
    async (mode) => {
      const execute = vi.fn(async () => 'should-not-run');
      const approvalTool = tool({
        name: 'approved_input_guarded_tool',
        description: 'Rejects approved input before execution.',
        parameters: z.object({}),
        needsApproval: true,
        execute,
        inputGuardrails: [
          defineToolInputGuardrail({
            name: 'reject approved input',
            run: async () =>
              ToolGuardrailFunctionOutputFactory.rejectContent(
                'approved-input-rejected',
              ),
          }),
        ],
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            functionToolCall(
              'approved_input_guarded_tool',
              'call-approved-input-rejected',
            ),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Approved input guardrail rejection agent',
        model,
        tools: [approvalTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'block approved input rejection',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: true,
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

      const first = await runOnce('Use approved_input_guarded_tool');
      expect(first.interruptions).toHaveLength(1);
      first.state.approve(first.interruptions[0]);

      await expect(runOnce(first.state)).rejects.toBeInstanceOf(
        OutputGuardrailTripwireTriggered,
      );
      expect(execute).not.toHaveBeenCalled();
      expect(
        getPersistedToolItems(await session.getItems()).filter(
          (item) => item.type === 'function_call_result',
        ),
      ).toMatchObject([
        {
          type: 'function_call_result',
          callId: 'call-approved-input-rejected',
        },
      ]);
      expect(session.compactionSnapshots).toHaveLength(2);
      expect(session.compactionArgs[1]).toMatchObject({
        compactionMode: 'input',
      });
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'does not persist a $mode tool result rejected before execution by an input guardrail',
    async (mode) => {
      const execute = vi.fn(async () => 'should-not-run');
      const guardedTool = tool({
        name: 'input_guarded_tool',
        description: 'Rejects before the tool executes.',
        parameters: z.object({}),
        execute,
        inputGuardrails: [
          defineToolInputGuardrail({
            name: 'reject tool input',
            run: async () =>
              ToolGuardrailFunctionOutputFactory.rejectContent(
                'input-rejected',
              ),
          }),
        ],
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            functionToolCall('input_guarded_tool', 'call-input-rejected'),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Input guardrail rejection agent',
        model,
        tools: [guardedTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'block rejection output',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: true,
            }),
          },
        ],
      });
      const session = new MemorySession();

      if (mode === 'streamed') {
        const result = await run(agent, 'Use input_guarded_tool', {
          session,
          stream: true,
        });
        await expect(result.completed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
      } else {
        await expect(
          run(agent, 'Use input_guarded_tool', { session }),
        ).rejects.toBeInstanceOf(OutputGuardrailTripwireTriggered);
      }

      expect(execute).not.toHaveBeenCalled();
      expect(getPersistedToolItems(await session.getItems())).toEqual([]);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'persists a $mode user rejection that closes an approval call checkpoint',
    async (mode) => {
      const execute = vi.fn(async () => 'should-not-run');
      const approvalTool = tool({
        name: 'rejected_approval_tool',
        description: 'Requires approval before execution.',
        parameters: z.object({}),
        needsApproval: true,
        execute,
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            functionToolCall(
              'rejected_approval_tool',
              'call-approval-rejected',
            ),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Approval rejection agent',
        model,
        tools: [approvalTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'block approval rejection output',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: true,
            }),
          },
        ],
      });
      const session = new MemorySession();
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

      const first = await runOnce('Use rejected_approval_tool');
      expect(first.interruptions).toHaveLength(1);
      first.state.reject(first.interruptions[0]);

      await expect(runOnce(first.state)).rejects.toBeInstanceOf(
        OutputGuardrailTripwireTriggered,
      );
      expect(execute).not.toHaveBeenCalled();
      expect(
        getPersistedToolItems(await session.getItems()).filter(
          (item) => item.type === 'function_call_result',
        ),
      ).toMatchObject([
        {
          type: 'function_call_result',
          callId: 'call-approval-rejected',
        },
      ]);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'persists a $mode provider result that completes a call saved before approval',
    async (mode) => {
      const executions: string[] = [];
      const approvedProgramTool = tool({
        name: 'approved_program_tool',
        description: 'Returns a value to a provider-managed program.',
        parameters: z.object({}),
        allowedCallers: ['programmatic'],
        needsApproval: true,
        execute: async () => {
          executions.push('ran');
          return 'approved-program-result';
        },
      });
      const programCallId = 'call-program-checkpoint';
      const model = new ApprovalSessionModel([
        {
          output: [
            {
              type: 'program',
              id: 'program-checkpoint',
              callId: programCallId,
              code: 'text(await tools.approved_program_tool({}))',
              fingerprint: 'program-checkpoint-fingerprint',
            },
            {
              ...functionToolCall(
                'approved_program_tool',
                'call-approved-program-tool',
              ),
              caller: { type: 'program' as const, callerId: programCallId },
            },
          ],
          usage: new Usage(),
        },
        {
          output: [
            {
              type: 'program_output',
              id: 'program-checkpoint-output',
              callId: programCallId,
              output: 'approved-program-result',
              status: 'completed',
            },
            fakeModelMessage('rejected program completion'),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Program checkpoint agent',
        model,
        tools: [
          approvedProgramTool,
          {
            type: 'hosted_tool',
            name: 'programmatic_tool_calling',
            providerData: { type: 'programmatic_tool_calling' },
          },
        ],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'block program completion',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: true,
            }),
          },
        ],
      });
      const session = new MemorySession();
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

      const first = await runOnce('Run the approved program');
      expect(first.interruptions).toHaveLength(1);
      first.state.approve(first.interruptions[0]);

      await expect(runOnce(first.state)).rejects.toBeInstanceOf(
        OutputGuardrailTripwireTriggered,
      );
      expect(executions).toEqual(['ran']);
      const persistedItems = await session.getItems();
      expect(
        persistedItems.filter(
          (item) => item.type === 'program' || item.type === 'program_output',
        ),
      ).toMatchObject([
        { type: 'program', callId: programCallId },
        { type: 'program_output', callId: programCallId },
      ]);
      expect(
        persistedItems.filter((item) => item.type === 'program_output'),
      ).toHaveLength(1);
      expect(
        persistedItems.some(
          (item) =>
            item.type === 'message' &&
            item.role === 'assistant' &&
            item.content.some(
              (content) =>
                content.type === 'output_text' &&
                content.text === 'rejected program completion',
            ),
        ),
      ).toBe(false);
    },
  );

  it.each(
    (['non_streamed', 'streamed'] as const).flatMap((mode) =>
      [false, true].map((tripwire) => ({ mode, tripwire })),
    ),
  )(
    'persists terminal results for a mixed $mode approval resume when guardrails trip=$tripwire',
    async ({ mode, tripwire }) => {
      const executions: string[] = [];
      const approvalTool = tool({
        name: 'mixed_approval_tool',
        description: 'Records approved executions.',
        parameters: z.object({ value: z.string() }),
        needsApproval: true,
        execute: async ({ value }) => {
          executions.push(value);
          return `executed-${value}`;
        },
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            functionToolCall(
              'mixed_approval_tool',
              'call-mixed-approved',
              JSON.stringify({ value: 'approved' }),
            ),
            functionToolCall(
              'mixed_approval_tool',
              'call-mixed-rejected',
              JSON.stringify({ value: 'rejected' }),
            ),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Mixed approval agent',
        model,
        tools: [approvalTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'mixed approval output guardrail',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: tripwire,
            }),
          },
        ],
      });
      const session = new MemorySession();
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

      const first = await runOnce('Run both approval tools');
      expect(first.interruptions).toHaveLength(2);
      first.state.approve(first.interruptions[0]);
      first.state.reject(first.interruptions[1]);

      if (tripwire) {
        await expect(runOnce(first.state)).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
      } else {
        const resumed = await runOnce(first.state);
        expect(resumed.finalOutput).toBe('executed-approved');
      }

      expect(executions).toEqual(['approved']);
      const persistedResultIds = getPersistedToolItems(await session.getItems())
        .filter((item) => item.type === 'function_call_result')
        .map((item) => item.callId);
      expect(persistedResultIds).toEqual([
        'call-mixed-approved',
        'call-mixed-rejected',
      ]);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'persists a committed $mode tool before sandbox cleanup fails',
    async (mode) => {
      const cleanupError = new Error('sandbox cleanup failed');
      const cleanupSpy = vi
        .spyOn(SandboxRuntimeManager.prototype, 'cleanup')
        .mockRejectedValue(cleanupError);
      const executions: string[] = [];
      const commitTool = tool({
        name: 'commit_before_cleanup',
        description: 'Commits before sandbox cleanup.',
        parameters: z.object({}),
        execute: async () => {
          executions.push('ran');
          return 'committed-before-cleanup';
        },
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            functionToolCall('commit_before_cleanup', 'call-before-cleanup'),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Cleanup failure agent',
        model,
        tools: [commitTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'block before cleanup',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: true,
            }),
          },
        ],
      });
      const session = new MemorySession();

      try {
        const runOnce = async () => {
          if (mode === 'streamed') {
            const result = await run(agent, 'Use commit_before_cleanup', {
              session,
              stream: true,
            });
            await result.completed;
            return;
          }
          await run(agent, 'Use commit_before_cleanup', { session });
        };
        await expect(runOnce()).rejects.toBe(cleanupError);
      } finally {
        cleanupSpy.mockRestore();
      }

      expect(executions).toEqual(['ran']);
      expect(
        getPersistedToolItems(await session.getItems()).map((item) => [
          item.type,
          item.callId,
        ]),
      ).toEqual([
        ['function_call', 'call-before-cleanup'],
        ['function_call_result', 'call-before-cleanup'],
      ]);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'does not persist a final $mode tool when guardrail execution fails',
    async (mode) => {
      const commitTool = tool({
        name: 'commit_before_guardrail_error',
        description: 'Commits before the guardrail throws.',
        parameters: z.object({}),
        execute: async () => 'committed-before-guardrail-error',
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            functionToolCall(
              'commit_before_guardrail_error',
              'call-before-guardrail-error',
            ),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Guardrail execution failure agent',
        model,
        tools: [commitTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'throw guardrail error',
            execute: async () => {
              throw new Error('guardrail failed');
            },
          },
        ],
      });
      const session = new MemorySession();

      const runOnce = async () => {
        if (mode === 'streamed') {
          const result = await run(agent, 'Use commit_before_guardrail_error', {
            session,
            stream: true,
          });
          await result.completed;
          return;
        }
        await run(agent, 'Use commit_before_guardrail_error', { session });
      };

      await expect(runOnce()).rejects.toBeInstanceOf(GuardrailExecutionError);
      const persistedItems = await session.getItems();
      expect(getPersistedToolItems(persistedItems)).toEqual([]);
      expect(
        persistedItems.some(
          (item) => item.type === 'message' && item.role === 'assistant',
        ),
      ).toBe(false);
    },
  );

  it.each<{
    mode: RunMode;
    tripwire: boolean;
  }>([
    { mode: 'non_streamed', tripwire: false },
    { mode: 'non_streamed', tripwire: true },
    { mode: 'streamed', tripwire: false },
    { mode: 'streamed', tripwire: true },
  ])(
    'keeps the ordered final batch subset in $mode mode when guardrails trip=$tripwire',
    async ({ mode, tripwire }) => {
      const commitTool = tool({
        name: 'commit_tool',
        description: 'Commits a side effect.',
        parameters: z.object({}),
        execute: async () => 'committed-result',
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            reasoningItem('reasoning-message', 'draft the message'),
            fakeModelMessage('rejected preamble'),
            reasoningItem('reasoning-tool', 'call the tool'),
            functionToolCall('commit_tool', 'call-mixed'),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Mixed final batch agent',
        model,
        tools: [commitTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'conditional output guardrail',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: tripwire,
            }),
          },
        ],
      });
      const session = new ReasoningPreservingSession();

      const runOnce = async () => {
        if (mode === 'streamed') {
          const result = await run(agent, 'Use commit_tool', {
            session,
            stream: true,
          });
          await result.completed;
          return result;
        }
        return await run(agent, 'Use commit_tool', { session });
      };

      if (tripwire) {
        await expect(runOnce()).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
      } else {
        expect((await runOnce()).finalOutput).toBe('committed-result');
      }

      const persistedItems = await session.getItems();
      expect(
        persistedItems.map((item) =>
          item.type === 'message' ? `${item.type}:${item.role}` : item.type,
        ),
      ).toEqual(
        tripwire
          ? [
              'message:user',
              'reasoning',
              'function_call',
              'function_call_result',
            ]
          : [
              'message:user',
              'reasoning',
              'message:assistant',
              'reasoning',
              'function_call',
              'function_call_result',
            ],
      );
      expect(
        persistedItems
          .filter((item) => item.type === 'reasoning')
          .map((item) => item.id),
      ).toEqual(
        tripwire ? ['reasoning-tool'] : ['reasoning-message', 'reasoning-tool'],
      );
      expect(session.compactionArgs).toHaveLength(1);
      if (tripwire) {
        expect(session.compactionArgs[0]).toMatchObject({
          compactionMode: 'input',
        });
      } else {
        expect(session.compactionArgs[0]?.compactionMode).toBeUndefined();
      }
    },
  );
});

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

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'scopes duplicate nested approval call IDs to the owning agent in $mode runs',
    async (mode) => {
      let firstExecutions = 0;
      let secondExecutions = 0;
      const createNestedAgent = (
        name: string,
        execute: () => Promise<string>,
      ) => {
        const approvalTool = tool({
          name: 'shared_approval_tool',
          description: 'Requires approval.',
          parameters: z.object({}),
          needsApproval: true,
          execute,
        });
        return new Agent({
          name,
          model: new ApprovalSessionModel([
            {
              output: [
                functionToolCall(
                  'shared_approval_tool',
                  'shared-provider-call-id',
                ),
              ],
              usage: new Usage(),
            },
          ]),
          tools: [approvalTool],
          toolUseBehavior: 'stop_on_first_tool',
        });
      };
      const firstNestedAgent = createNestedAgent(
        'Duplicate approval agent',
        async () => {
          firstExecutions += 1;
          return 'first-approved';
        },
      );
      const secondNestedAgent = createNestedAgent(
        'Duplicate approval agent',
        async () => {
          secondExecutions += 1;
          return 'second-approved';
        },
      );
      const firstNestedTool = firstNestedAgent.asTool({
        toolName: 'first_nested_agent',
        toolDescription: 'Runs the first nested agent.',
      });
      const secondNestedTool = secondNestedAgent.asTool({
        toolName: 'second_nested_agent',
        toolDescription: 'Runs the second nested agent.',
      });
      const outerAgent = new Agent({
        name: 'Duplicate approval outer agent',
        model: new ApprovalSessionModel([
          {
            output: [
              functionToolCall(
                firstNestedTool.name,
                'first-outer-call',
                JSON.stringify({ input: 'Run the first nested agent.' }),
              ),
              functionToolCall(
                secondNestedTool.name,
                'second-outer-call',
                JSON.stringify({ input: 'Run the second nested agent.' }),
              ),
            ],
            usage: new Usage(),
          },
        ]),
        tools: [firstNestedTool, secondNestedTool],
        toolUseBehavior: 'stop_on_first_tool',
      });

      const runOnce = async (
        input: string | RunState<unknown, typeof outerAgent>,
      ) => {
        if (mode === 'streamed') {
          const result = await run(outerAgent, input, { stream: true });
          await result.completed;
          return result;
        }
        return run(outerAgent, input);
      };

      const first = await runOnce('Run both nested agents.');
      expect(first.interruptions).toHaveLength(2);

      const restored = await RunState.fromString(
        outerAgent,
        first.state.toString(),
      );
      const firstApproval = restored
        .getInterruptions()
        .find((item) => item.agent === firstNestedAgent)!;
      const secondApproval = restored
        .getInterruptions()
        .find((item) => item.agent === secondNestedAgent)!;
      restored.approve(firstApproval);
      restored.reject(secondApproval, { message: 'Second call rejected.' });

      const decidedState = await RunState.fromString(
        outerAgent,
        restored.toString(),
      );
      const resumed = await runOnce(decidedState);

      expect(resumed.interruptions).toHaveLength(0);
      expect(firstExecutions).toBe(1);
      expect(secondExecutions).toBe(0);
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
    'persists accepted output after resuming a blocked $mode tool checkpoint',
    async (mode) => {
      const executions: string[] = [];
      let guardrailShouldTrip = true;
      const approvalTool = tool({
        name: 'approved_then_blocked_tool',
        description: 'Returns a result after approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => {
          executions.push('ran');
          return 'approved-result';
        },
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            functionToolCall(
              'approved_then_blocked_tool',
              'call-approved-then-blocked',
            ),
          ],
          usage: new Usage(),
        },
        {
          output: [fakeModelMessage('rejected after approved tool')],
          usage: new Usage(),
        },
        {
          output: [fakeModelMessage('accepted after resume')],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Approved tool blocked output agent',
        model,
        tools: [approvalTool],
        toolUseBehavior: 'run_llm_again',
        outputGuardrails: [
          {
            name: 'block output after approved tool',
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

      const first = await runOnce('Use approved_then_blocked_tool');
      expect(first.interruptions).toHaveLength(1);
      first.state.approve(first.interruptions[0]);

      let blockedState: RunState<unknown, typeof agent> | undefined;
      try {
        await runOnce(first.state);
      } catch (error) {
        expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
        if (!(error instanceof OutputGuardrailTripwireTriggered)) {
          throw error;
        }
        blockedState = error.state as
          RunState<unknown, typeof agent> | undefined;
      }

      expect(blockedState).toBeDefined();
      expect(blockedState?._currentTurnPersistedItemCount).toBe(
        blockedState?._generatedItems.length,
      );
      expect(executions).toEqual(['ran']);
      expect(
        (await session.getItems()).filter((item) => item.type === 'message'),
      ).toMatchObject([{ role: 'user' }]);
      expect(session.compactionArgs.at(-1)).toMatchObject({
        compactionMode: 'input',
      });
      expect(getPersistedToolItems(await session.getItems())).toHaveLength(2);
      expect(blockedState?._currentTurnDeferredSessionItemIndexes.size).toBe(1);

      guardrailShouldTrip = false;
      if (!blockedState) {
        throw new Error('Expected blocked run state.');
      }
      const accepted = await runOnce(blockedState);
      expect(accepted.finalOutput).toBe('rejected after approved tool');
      expect(accepted.state._currentTurnDeferredSessionItemIndexes.size).toBe(
        0,
      );
      expect(executions).toEqual(['ran']);
      expect(
        (await session.getItems()).some(
          (item) =>
            item.type === 'message' &&
            item.role === 'assistant' &&
            item.content.some(
              (content) =>
                content.type === 'output_text' &&
                content.text === 'rejected after approved tool',
            ),
        ),
      ).toBe(true);

      const followup = await runOnce('Continue after the blocked output');
      expect(followup.finalOutput).toBe('accepted after resume');
      expect(executions).toEqual(['ran']);
      const followupInput = model.requests.at(-1)?.input;
      expect(Array.isArray(followupInput)).toBe(true);
      if (!Array.isArray(followupInput)) {
        throw new Error('Expected array model input.');
      }
      expect(
        followupInput.some(
          (item) =>
            item.type === 'message' &&
            item.role === 'assistant' &&
            item.content.some(
              (content) =>
                content.type === 'output_text' &&
                content.text === 'rejected after approved tool',
            ),
        ),
      ).toBe(true);
      expect(
        (await session.getItems()).some(
          (item) =>
            item.type === 'message' &&
            item.role === 'assistant' &&
            item.content.some(
              (content) =>
                content.type === 'output_text' &&
                content.text === 'rejected after approved tool',
            ),
        ),
      ).toBe(true);
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
