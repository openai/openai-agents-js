import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InputGuardrailTripwireTriggered,
  ToolGuardrailFunctionOutputFactory,
  MemorySession,
  OutputGuardrailTripwireTriggered,
  RunContext,
  Runner,
  RunState,
  RunToolCallItem,
  RunToolCallOutputItem,
  Usage,
  run,
  setTracingDisabled,
  tool,
  defineToolInputGuardrail,
  type AgentInputItem,
  type CallModelInputFilterArgs,
  type ModelRequest,
  type ModelResponse,
  type OpenAIResponsesCompactionArgs,
  type OpenAIResponsesCompactionResult,
  type SessionHistoryTransactionArgs,
  type StreamEvent,
  type ToolUseBehavior,
} from '../src';
import * as protocol from '../src/types/protocol';
import { fakeModelMessage } from './stubs';
import logger from '../src/logger';
import {
  ScriptedModel,
  modelResponder,
  modelStreamResponder,
} from '../src/testing';

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

class ApprovalSessionModel extends ScriptedModel {
  constructor(responses: ModelResponse[]) {
    super(
      responses.map((response) =>
        modelResponder((call) =>
          call.streamed
            ? { ...response, responseId: 'stream-response' }
            : response,
        ),
      ),
    );
  }

  get requests(): readonly Readonly<ModelRequest>[] {
    return this.calls.map((call) => call.request);
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
  beforeAll(() => {
    setTracingDisabled(true);
  });

  it('binds transaction-aware streaming state before exposing the result', async () => {
    let markSessionIdRequested!: () => void;
    let releaseSessionId!: () => void;
    const sessionIdRequested = new Promise<void>((resolve) => {
      markSessionIdRequested = resolve;
    });
    const sessionIdAvailable = new Promise<void>((resolve) => {
      releaseSessionId = resolve;
    });
    class DeferredSessionIdSession extends MemorySession {
      override async getSessionId(): Promise<string> {
        markSessionIdRequested();
        await sessionIdAvailable;
        return await super.getSessionId();
      }
    }

    let markModelStarted!: () => void;
    let releaseModel!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve;
    });
    const modelCanFinish = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const model = new ScriptedModel([
      modelStreamResponder(() =>
        (async function* () {
          markModelStarted();
          await modelCanFinish;
          yield {
            type: 'response_done',
            response: {
              id: 'bound-stream-response',
              output: [fakeModelMessage('done')],
              usage: new Usage(),
            },
          } as StreamEvent;
        })(),
      ),
    ]);
    const agent = new Agent({ name: 'Bound streaming state agent', model });
    const session = new DeferredSessionIdSession({
      sessionId: 'bound-stream-session',
    });

    let resultExposed = false;
    const resultPromise = run(agent, 'hello', { session, stream: true });
    void resultPromise.then(() => {
      resultExposed = true;
    });
    await sessionIdRequested;
    await Promise.resolve();
    expect(resultExposed).toBe(false);

    releaseSessionId();
    const result = await resultPromise;
    await modelStarted;
    expect(result.state._currentTurnSessionHistoryTransactionSessionId).toBe(
      'bound-stream-session',
    );
    expect(result.state._currentTurnSessionReasoningItemIdPolicy).toBe(
      'preserve',
    );

    releaseModel();
    await result.completed;
    expect(
      result.state._currentTurnSessionHistoryTransactionSessionId,
    ).toBeUndefined();
    expect(
      result.state._currentTurnSessionReasoningItemIdPolicy,
    ).toBeUndefined();
  });

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'rejects a $mode blocked transaction when the logical session changes before persistence',
    async (mode) => {
      class ChangingSessionIdSession extends MemorySession {
        sessionIdCalls = 0;
        transactionCalls = 0;

        override async getSessionId(): Promise<string> {
          this.sessionIdCalls += 1;
          return this.sessionIdCalls === 1
            ? 'session-before-execution'
            : 'session-before-persistence';
        }

        override async applyHistoryTransaction(
          _args: SessionHistoryTransactionArgs,
        ): Promise<void> {
          this.transactionCalls += 1;
        }
      }

      const execute = vi.fn(async () => 'committed-result');
      const commitTool = tool({
        name: 'session_identity_tool',
        description: 'Commits before the logical session identity changes.',
        parameters: z.object({}),
        execute,
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            functionToolCall('session_identity_tool', 'call-session-identity'),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Changing logical session agent',
        model,
        tools: [commitTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'block after logical session change',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: true,
            }),
          },
        ],
      });
      const session = new ChangingSessionIdSession();

      let blockedError: OutputGuardrailTripwireTriggered<any> | undefined;
      if (mode === 'streamed') {
        const result = await run(agent, 'Use session_identity_tool', {
          session,
          stream: true,
        });
        try {
          await result.completed;
        } catch (error) {
          expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
          blockedError = error as OutputGuardrailTripwireTriggered<any>;
        }
      } else {
        try {
          await run(agent, 'Use session_identity_tool', { session });
        } catch (error) {
          expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
          blockedError = error as OutputGuardrailTripwireTriggered<any>;
        }
      }

      expect((blockedError as Error & { cause?: unknown }).cause).toEqual(
        expect.objectContaining({
          message: expect.stringContaining('different session'),
        }),
      );
      expect(session.sessionIdCalls).toBeGreaterThanOrEqual(2);
      expect(session.transactionCalls).toBe(0);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await session.getItems()).toEqual([]);
    },
  );

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
      const execute = vi.fn(async () => 'committed-result');
      let guardrailShouldTrip = true;
      const commitTool = tool({
        name: 'commit_tool',
        description: 'Commits a side effect.',
        parameters: z.object({}),
        execute,
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
      expect(execute).toHaveBeenCalledTimes(1);
      expect(
        (await session.getItems()).map((item) =>
          item.type === 'message' ? `${item.type}:${item.role}` : item.type,
        ),
      ).toEqual(['message:user', 'function_call', 'function_call_result']);

      guardrailShouldTrip = false;
      const followup = await runOnce('Continue');
      expect(followup.finalOutput).toBe('done');
      expect(execute).toHaveBeenCalledTimes(1);
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
    'keeps a full-subset blocked $mode transaction bound to its session',
    async (mode) => {
      let guardrailShouldTrip = true;
      const execute = vi.fn(async () => 'committed-result');
      const commitTool = tool({
        name: 'bound_commit_tool',
        description: 'Commits before a session ownership check.',
        parameters: z.object({}),
        execute,
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            functionToolCall('bound_commit_tool', 'call-bound-committed'),
          ],
          usage: new Usage(),
        },
      ]);
      const outputGuardrail = vi.fn(async () => ({
        outputInfo: null,
        tripwireTriggered: guardrailShouldTrip,
      }));
      const agent = new Agent({
        name: 'Bound committed tool agent',
        model,
        tools: [commitTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          { name: 'toggle bound committed result', execute: outputGuardrail },
        ],
      });
      const originalSession = new MemorySession({
        sessionId: 'full-subset-original-session',
      });

      let blockedState: RunState<undefined, typeof agent> | undefined;
      if (mode === 'streamed') {
        const result = await run(agent, 'Use bound_commit_tool', {
          session: originalSession,
          stream: true,
        });
        await expect(result.completed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
        blockedState = result.state;
      } else {
        try {
          await run(agent, 'Use bound_commit_tool', {
            session: originalSession,
          });
        } catch (error) {
          expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
          blockedState = (
            error as { state?: RunState<undefined, typeof agent> }
          ).state;
        }
      }

      expect(blockedState).toBeDefined();
      expect(blockedState!._currentTurnDeferredSessionItemIndexes.size).toBe(0);
      expect(blockedState!._currentTurnSessionHistoryTransactionSessionId).toBe(
        'full-subset-original-session',
      );
      await expect(
        RunState.fromString(agent, blockedState!.toString()),
      ).rejects.toThrow(
        'Serialized output guardrail session transaction authority cannot be resumed safely.',
      );

      guardrailShouldTrip = false;
      const differentSession = new MemorySession({
        sessionId: 'full-subset-different-session',
      });
      const differentSessionResume =
        mode === 'streamed'
          ? run(agent, blockedState!, {
              session: differentSession,
              stream: true,
            })
          : run(agent, blockedState!, { session: differentSession });
      await expect(differentSessionResume).rejects.toThrow(
        'Output guardrail session persistence belongs to a different session',
      );
      expect(outputGuardrail).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await differentSession.getItems()).toEqual([]);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'releases an unused provisional session binding after a message-only $mode tripwire',
    async (mode) => {
      let guardrailShouldTrip = true;
      const model = new ApprovalSessionModel([
        {
          output: [fakeModelMessage('accepted after session switch')],
          usage: new Usage(),
        },
      ]);
      const outputGuardrail = vi.fn(async () => ({
        outputInfo: null,
        tripwireTriggered: guardrailShouldTrip,
      }));
      const agent = new Agent({
        name: 'Message-only session switch agent',
        model,
        outputGuardrails: [
          { name: 'toggle message-only output', execute: outputGuardrail },
        ],
      });
      const originalSession = new MemorySession({
        sessionId: 'message-only-original-session',
      });

      let blockedState: RunState<undefined, typeof agent> | undefined;
      if (mode === 'streamed') {
        const result = await run(agent, 'hello', {
          session: originalSession,
          stream: true,
        });
        await expect(result.completed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
        blockedState = result.state;
      } else {
        try {
          await run(agent, 'hello', { session: originalSession });
        } catch (error) {
          expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
          blockedState = (
            error as { state?: RunState<undefined, typeof agent> }
          ).state;
        }
      }

      expect(
        blockedState!._currentTurnSessionHistoryTransactionSessionId,
      ).toBeUndefined();
      expect(
        (await originalSession.getItems()).map((item) =>
          item.type === 'message' ? `${item.type}:${item.role}` : item.type,
        ),
      ).toEqual(['message:user']);
      guardrailShouldTrip = false;
      const replacementSession = new MemorySession({
        sessionId: 'message-only-replacement-session',
      });
      if (mode === 'streamed') {
        const resumed = await run(agent, blockedState!, {
          session: replacementSession,
          stream: true,
        });
        await resumed.completed;
        expect(resumed.finalOutput).toBe('accepted after session switch');
      } else {
        const resumed = await run(agent, blockedState!, {
          session: replacementSession,
        });
        expect(resumed.finalOutput).toBe('accepted after session switch');
      }

      expect(outputGuardrail).toHaveBeenCalledTimes(2);
      expect(model.requests).toHaveLength(1);
      expect(
        (await replacementSession.getItems()).map((item) => item.type),
      ).toEqual(['message']);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'releases an unused provisional session binding after a $mode input tripwire',
    async (mode) => {
      let shouldTrip = true;
      const model = new ApprovalSessionModel([
        {
          output: [fakeModelMessage('accepted after input tripwire')],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Input tripwire session switch agent',
        model,
        inputGuardrails: [
          {
            name: 'toggle input tripwire',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: shouldTrip,
            }),
          },
        ],
      });
      const originalSession = new MemorySession({
        sessionId: 'input-tripwire-original-session',
      });

      let blockedState: RunState<undefined, typeof agent> | undefined;
      if (mode === 'streamed') {
        const result = await run(agent, 'hello', {
          session: originalSession,
          stream: true,
        });
        await expect(result.completed).rejects.toBeInstanceOf(
          InputGuardrailTripwireTriggered,
        );
        blockedState = result.state;
      } else {
        try {
          await run(agent, 'hello', { session: originalSession });
        } catch (error) {
          expect(error).toBeInstanceOf(InputGuardrailTripwireTriggered);
          blockedState = (
            error as { state?: RunState<undefined, typeof agent> }
          ).state;
        }
      }

      expect(
        blockedState!._currentTurnSessionHistoryTransactionSessionId,
      ).toBeUndefined();
      shouldTrip = false;
      const replacementSession = new MemorySession({
        sessionId: 'input-tripwire-replacement-session',
      });
      if (mode === 'streamed') {
        const resumed = await run(agent, blockedState!, {
          session: replacementSession,
          stream: true,
        });
        await resumed.completed;
        expect(resumed.finalOutput).toBe('accepted after input tripwire');
      } else {
        const resumed = await run(agent, blockedState!, {
          session: replacementSession,
        });
        expect(resumed.finalOutput).toBe('accepted after input tripwire');
      }

      expect(model.requests).toHaveLength(1);
    },
  );

  it.each(
    (['non_streamed', 'streamed'] as const).flatMap((mode) => [
      {
        mode,
        name: 'error',
        createError: () => new Error('guardrail failed'),
      },
      {
        mode,
        name: 'cancellation',
        createError: () => {
          const error = new Error('guardrail cancelled');
          error.name = 'AbortError';
          return error;
        },
      },
    ]),
  )(
    'preserves the full $mode final turn after output guardrail $name',
    async ({ mode, createError }) => {
      const commitTool = tool({
        name: 'guardrail_error_commit_tool',
        description: 'Commits before the output guardrail fails.',
        parameters: z.object({}),
        execute: async () => 'committed-before-guardrail-error',
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            fakeModelMessage('replayable final output'),
            functionToolCall(
              'guardrail_error_commit_tool',
              'call-before-guardrail-error',
            ),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Replayable guardrail failure agent',
        model,
        tools: [commitTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'fail final output check',
            execute: async () => {
              throw createError();
            },
          },
        ],
      });
      const session = new MemorySession();

      if (mode === 'streamed') {
        const result = await run(agent, 'hello', { session, stream: true });
        await expect(result.completed).rejects.toThrow(
          'Output guardrail failed to complete',
        );
      } else {
        await expect(run(agent, 'hello', { session })).rejects.toThrow(
          'Output guardrail failed to complete',
        );
      }
      expect(
        (await session.getItems()).map((item) =>
          item.type === 'message' ? `${item.type}:${item.role}` : item.type,
        ),
      ).toEqual([
        'message:user',
        'message:assistant',
        'function_call',
        'function_call_result',
      ]);
    },
  );

  it.each(
    (['non_streamed', 'streamed'] as const).flatMap((mode) => [
      {
        mode,
        name: 'error',
        errorName: 'Error',
        createError: () => new Error('guardrail failed'),
      },
      {
        mode,
        name: 'cancellation',
        errorName: 'AbortError',
        createError: () => {
          const error = new Error('guardrail cancelled');
          error.name = 'AbortError';
          return error;
        },
      },
    ]),
  )(
    'keeps the $mode guardrail $name primary when full-turn persistence fails',
    async ({ mode, errorName, createError }) => {
      class RejectingGuardrailErrorSession extends MemorySession {
        override async addItems(_items: AgentInputItem[]): Promise<void> {
          throw new Error('guardrail error persistence failed');
        }
      }

      const model = new ApprovalSessionModel([
        {
          output: [fakeModelMessage('replayable final output')],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Guardrail primary error agent',
        model,
        outputGuardrails: [
          {
            name: 'fail final output before persistence failure',
            execute: async () => {
              throw createError();
            },
          },
        ],
      });
      const session = new RejectingGuardrailErrorSession();

      let guardrailError: Error | undefined;
      try {
        if (mode === 'streamed') {
          const result = await run(agent, 'hello', { session, stream: true });
          await result.completed;
        } else {
          await run(agent, 'hello', { session });
        }
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        guardrailError = error as Error;
      }

      expect(guardrailError?.message).toContain(
        'Output guardrail failed to complete',
      );
      expect((guardrailError as Error & { error?: Error }).error?.name).toBe(
        errorName,
      );
      expect((guardrailError as Error & { cause?: unknown }).cause).toEqual(
        new Error('guardrail error persistence failed'),
      );
      expect(await session.getItems()).toEqual([]);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'persists a committed tool when a $mode error-handler final output is blocked',
    async (mode) => {
      const execute = vi.fn(async () => 'committed-before-max-turns');
      const commitTool = tool({
        name: 'error_handler_commit_tool',
        description: 'Commits before max-turn handling.',
        parameters: z.object({}),
        execute,
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            functionToolCall(
              'error_handler_commit_tool',
              'call-before-error-handler',
            ),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Blocked error-handler output agent',
        model,
        tools: [commitTool],
        toolUseBehavior: 'run_llm_again',
        outputGuardrails: [
          {
            name: 'block error-handler output',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: true,
            }),
          },
        ],
      });
      const session = new MemorySession();
      const options = {
        session,
        maxTurns: 1,
        errorHandlers: {
          maxTurns: () => ({ finalOutput: 'blocked fallback' }),
        },
      } as const;

      if (mode === 'streamed') {
        const result = await run(agent, 'Use error_handler_commit_tool', {
          ...options,
          stream: true,
        });
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        await expect(result.completed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
        expect(result.finalOutput).toBeUndefined();
        warnSpy.mockRestore();
      } else {
        await expect(
          run(agent, 'Use error_handler_commit_tool', options),
        ).rejects.toBeInstanceOf(OutputGuardrailTripwireTriggered);
      }

      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.requests).toHaveLength(1);
      expect(
        (await session.getItems()).map((item) =>
          item.type === 'message' ? `${item.type}:${item.role}` : item.type,
        ),
      ).toEqual(['message:user', 'function_call', 'function_call_result']);
    },
  );

  it('hides streamed error-handler output before the finalizer microtask', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let resolveHandler: ((value: { finalOutput: string }) => void) | undefined;
    let resolveGuardrail:
      | ((value: { outputInfo: null; tripwireTriggered: boolean }) => void)
      | undefined;
    const commitTool = tool({
      name: 'error_handler_visibility_tool',
      description: 'Commits before a suspended error handler.',
      parameters: z.object({}),
      execute: async () => 'committed-before-error-handler',
    });
    const model = new ApprovalSessionModel([
      {
        output: [
          functionToolCall(
            'error_handler_visibility_tool',
            'call-error-handler-visibility',
          ),
        ],
        usage: new Usage(),
      },
    ]);
    const agent = new Agent({
      name: 'Error-handler visibility agent',
      model,
      tools: [commitTool],
      toolUseBehavior: 'run_llm_again',
      outputGuardrails: [
        {
          name: 'suspend error-handler output',
          execute: async () =>
            await new Promise((resolve) => {
              resolveGuardrail = resolve;
            }),
        },
      ],
    });
    const result = await run(agent, 'Use error_handler_visibility_tool', {
      stream: true,
      maxTurns: 1,
      errorHandlers: {
        maxTurns: async () =>
          await new Promise((resolve) => {
            resolveHandler = resolve;
          }),
      },
    });
    await vi.waitFor(() => expect(resolveHandler).toBeDefined());

    resolveHandler!({ finalOutput: 'guarded fallback' });
    const observedBeforeFinalizer = await new Promise<string | undefined>(
      (resolve) => queueMicrotask(() => resolve(result.finalOutput)),
    );
    expect(observedBeforeFinalizer).toBeUndefined();
    await vi.waitFor(() => expect(resolveGuardrail).toBeDefined());
    expect(result.finalOutput).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      'Accessed finalOutput before agent run is completed.',
    );

    resolveGuardrail!({ outputInfo: null, tripwireTriggered: false });
    await result.completed;
    expect(result.finalOutput).toBe('guarded fallback');
    warnSpy.mockRestore();
  });

  it.each([
    {
      ownership: 'conversationId',
      options: { conversationId: 'conversation-blocked-output' },
    },
    {
      ownership: 'previousResponseId',
      options: { previousResponseId: 'response-before-blocked-output' },
    },
  ])(
    'does not persist blocked streaming tool history when $ownership owns conversation state',
    async ({ options }) => {
      class TransactionTrackingSession extends MemorySession {
        transactionCount = 0;

        override async applyHistoryTransaction(
          args: SessionHistoryTransactionArgs,
        ): Promise<void> {
          this.transactionCount += 1;
          await super.applyHistoryTransaction(args);
        }
      }

      const execute = vi.fn(async () => 'committed-result');
      const commitTool = tool({
        name: 'server_owned_commit_tool',
        description: 'Commits while the server owns conversation state.',
        parameters: z.object({}),
        execute,
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            functionToolCall(
              'server_owned_commit_tool',
              'call-server-owned-commit',
            ),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Server-owned blocked output agent',
        model,
        tools: [commitTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'block server-owned tool output',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: true,
            }),
          },
        ],
      });
      const session = new TransactionTrackingSession();

      const result = await run(agent, 'Use server_owned_commit_tool', {
        ...options,
        session,
        stream: true,
      });
      await expect(result.completed).rejects.toBeInstanceOf(
        OutputGuardrailTripwireTriggered,
      );

      expect(execute).toHaveBeenCalledTimes(1);
      expect(session.transactionCount).toBe(0);
      expect(await session.getItems()).toEqual([]);
    },
  );

  it('keeps blocked streaming final output hidden when session persistence fails', async () => {
    class RejectingTransactionSession extends MemorySession {
      override async applyHistoryTransaction(
        _args: SessionHistoryTransactionArgs,
      ): Promise<void> {
        throw new Error('blocked transaction failed');
      }
    }

    const commitTool = tool({
      name: 'failing_persistence_tool',
      description: 'Commits before blocked persistence fails.',
      parameters: z.object({}),
      execute: async () => 'committed-result',
    });
    const model = new ApprovalSessionModel([
      {
        output: [
          functionToolCall(
            'failing_persistence_tool',
            'call-failing-persistence',
          ),
        ],
        usage: new Usage(),
      },
    ]);
    const agent = new Agent({
      name: 'Failing persistence agent',
      model,
      tools: [commitTool],
      toolUseBehavior: 'stop_on_first_tool',
      outputGuardrails: [
        {
          name: 'block before persistence failure',
          execute: async () => ({
            outputInfo: null,
            tripwireTriggered: true,
          }),
        },
      ],
    });
    const result = await run(agent, 'Use failing_persistence_tool', {
      session: new RejectingTransactionSession(),
      stream: true,
    });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    let blockedError: OutputGuardrailTripwireTriggered<any> | undefined;
    try {
      await result.completed;
    } catch (error) {
      expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
      blockedError = error as OutputGuardrailTripwireTriggered<any>;
    }
    expect((blockedError as Error & { cause?: unknown }).cause).toEqual(
      new Error('blocked transaction failed'),
    );
    expect(result.finalOutput).toBeUndefined();

    warnSpy.mockRestore();
  });

  it('keeps a streaming message-only tripwire primary when input persistence fails', async () => {
    class RejectingInputSession extends MemorySession {
      addItemsCalls = 0;

      override async addItems(_items: AgentInputItem[]): Promise<void> {
        this.addItemsCalls += 1;
        throw new Error('blocked input persistence failed');
      }
    }

    const model = new ApprovalSessionModel([
      {
        output: [fakeModelMessage('blocked message')],
        usage: new Usage(),
      },
    ]);
    const agent = new Agent({
      name: 'Message-only persistence failure agent',
      model,
      outputGuardrails: [
        {
          name: 'block before input persistence failure',
          execute: async () => ({
            outputInfo: null,
            tripwireTriggered: true,
          }),
        },
      ],
    });
    const session = new RejectingInputSession();
    const result = await run(agent, 'Reject this message', {
      session,
      stream: true,
    });

    let blockedError: OutputGuardrailTripwireTriggered<any> | undefined;
    try {
      await result.completed;
    } catch (error) {
      expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
      blockedError = error as OutputGuardrailTripwireTriggered<any>;
    }

    expect((blockedError as Error & { cause?: unknown }).cause).toEqual(
      new Error('blocked input persistence failed'),
    );
    expect(session.addItemsCalls).toBe(1);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(result.finalOutput).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Accessed finalOutput before agent run is completed.',
    );
    warnSpy.mockRestore();
    expect(await session.getItems()).toEqual([]);
  });

  it('keeps an error-handler output hidden when blocked persistence fails', async () => {
    class RejectingTransactionSession extends MemorySession {
      override async applyHistoryTransaction(
        _args: SessionHistoryTransactionArgs,
      ): Promise<void> {
        throw new Error('error-handler transaction failed');
      }
    }

    const execute = vi.fn(async () => 'committed-before-error-handler');
    const commitTool = tool({
      name: 'error_handler_persistence_tool',
      description: 'Commits before error-handler persistence fails.',
      parameters: z.object({}),
      execute,
    });
    const model = new ApprovalSessionModel([
      {
        output: [
          functionToolCall(
            'error_handler_persistence_tool',
            'call-error-handler-persistence',
          ),
        ],
        usage: new Usage(),
      },
    ]);
    const agent = new Agent({
      name: 'Error-handler persistence failure agent',
      model,
      tools: [commitTool],
      toolUseBehavior: 'run_llm_again',
      outputGuardrails: [
        {
          name: 'block error-handler persistence output',
          execute: async () => ({
            outputInfo: null,
            tripwireTriggered: true,
          }),
        },
      ],
    });
    const session = new RejectingTransactionSession();
    const result = await run(agent, 'Use error_handler_persistence_tool', {
      session,
      stream: true,
      maxTurns: 1,
      errorHandlers: {
        maxTurns: () => ({ finalOutput: 'blocked fallback' }),
      },
    });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    let blockedError: OutputGuardrailTripwireTriggered<any> | undefined;
    try {
      await result.completed;
    } catch (error) {
      expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
      blockedError = error as OutputGuardrailTripwireTriggered<any>;
    }

    expect((blockedError as Error & { cause?: unknown }).cause).toEqual(
      new Error('error-handler transaction failed'),
    );
    expect(result.finalOutput).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await session.getItems()).toEqual([]);

    warnSpy.mockRestore();
  });

  it.each(['ordinary final output', 'error-handler final output'] as const)(
    'does not emit agent_end before non-streamed %s persistence succeeds',
    async (finalOutputSource) => {
      class RejectingAcceptedSession extends MemorySession {
        override async addItems(_items: AgentInputItem[]): Promise<void> {
          throw new Error('accepted persistence failed');
        }
      }

      const commitTool = tool({
        name: 'accepted_persistence_tool',
        description: 'Produces an error-handler final output.',
        parameters: z.object({}),
        execute: async () => 'committed-before-handler',
      });
      const model = new ApprovalSessionModel([
        {
          output:
            finalOutputSource === 'ordinary final output'
              ? [fakeModelMessage('accepted output')]
              : [
                  functionToolCall(
                    'accepted_persistence_tool',
                    'call-accepted-persistence',
                  ),
                ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Accepted persistence lifecycle agent',
        model,
        tools: [commitTool],
        toolUseBehavior: 'run_llm_again',
      });
      const runner = new Runner();
      const runnerEnd = vi.fn();
      const agentEnd = vi.fn();
      runner.on('agent_end', runnerEnd);
      agent.on('agent_end', agentEnd);

      await expect(
        runner.run(agent, 'Produce final output', {
          session: new RejectingAcceptedSession(),
          ...(finalOutputSource === 'error-handler final output'
            ? {
                maxTurns: 1,
                errorHandlers: {
                  maxTurns: () => ({ finalOutput: 'handled output' }),
                },
              }
            : {}),
        }),
      ).rejects.toThrow('accepted persistence failed');
      expect(runnerEnd).not.toHaveBeenCalled();
      expect(agentEnd).not.toHaveBeenCalled();
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'retries an uncertain $mode blocked transaction with its frozen reasoning policy',
    async (mode) => {
      class CommitThenThrowSession extends MemorySession {
        operationIds: string[] = [];
        private throwAfterFirstCommit = true;

        override async applyHistoryTransaction(
          args: SessionHistoryTransactionArgs,
        ): Promise<void> {
          this.operationIds.push(args.operationId);
          await super.applyHistoryTransaction(args);
          if (this.throwAfterFirstCommit) {
            this.throwAfterFirstCommit = false;
            throw new Error('blocked transaction outcome unknown');
          }
        }
      }

      const execute = vi.fn(async () => 'committed-result');
      const commitTool = tool({
        name: 'uncertain_persistence_tool',
        description: 'Commits before the session transaction outcome is known.',
        parameters: z.object({}),
        execute,
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            reasoningItem(
              'reasoning-uncertain-persistence',
              'run the committed tool',
            ),
            functionToolCall(
              'uncertain_persistence_tool',
              'call-uncertain-persistence',
            ),
          ],
          usage: new Usage(),
        },
      ]);
      const outputGuardrail = vi.fn(async () => ({
        outputInfo: null,
        tripwireTriggered: true,
      }));
      const agent = new Agent({
        name: 'Uncertain persistence agent',
        model,
        tools: [commitTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'block uncertain persistence output',
            execute: outputGuardrail,
          },
        ],
      });
      const session = new CommitThenThrowSession({
        sessionId: 'uncertain-persistence-session',
      });

      let blockedError: OutputGuardrailTripwireTriggered<any> | undefined;
      if (mode === 'streamed') {
        const result = await run(agent, 'Use uncertain_persistence_tool', {
          session,
          stream: true,
          reasoningItemIdPolicy: 'omit',
        });
        try {
          await result.completed;
        } catch (error) {
          expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
          blockedError = error as OutputGuardrailTripwireTriggered<any>;
        }
      } else {
        try {
          await run(agent, 'Use uncertain_persistence_tool', {
            session,
            reasoningItemIdPolicy: 'omit',
          });
        } catch (error) {
          expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
          blockedError = error as OutputGuardrailTripwireTriggered<any>;
        }
      }
      expect(blockedError?.state).toBeDefined();
      expect((blockedError as Error & { cause?: unknown }).cause).toEqual(
        new Error('blocked transaction outcome unknown'),
      );

      await expect(
        RunState.fromString(agent, blockedError!.state!.toString()),
      ).rejects.toThrow(
        'Serialized output guardrail session transaction authority cannot be resumed safely',
      );
      expect(outputGuardrail).toHaveBeenCalledTimes(1);

      const pendingState = blockedError!.state!;
      const differentSession = new MemorySession({
        sessionId: 'different-uncertain-persistence-session',
      });
      const wrongSessionResume =
        mode === 'streamed'
          ? run(agent, pendingState, {
              session: differentSession,
              stream: true,
            })
          : run(agent, pendingState, { session: differentSession });
      await expect(wrongSessionResume).rejects.toThrow(
        'Output guardrail session persistence belongs to a different session',
      );
      const serverManagedResume =
        mode === 'streamed'
          ? run(agent, pendingState, {
              session,
              conversationId: 'server-owned-uncertain-resume',
              stream: true,
            })
          : run(agent, pendingState, {
              session,
              conversationId: 'server-owned-uncertain-resume',
            });
      await expect(serverManagedResume).rejects.toThrow(
        'Output guardrail session persistence must resume with the same transaction-aware local session',
      );
      expect(outputGuardrail).toHaveBeenCalledTimes(1);
      if (mode === 'streamed') {
        const resumed = await run(agent, pendingState, {
          session,
          stream: true,
          reasoningItemIdPolicy: 'preserve',
        });
        await expect(resumed.completed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
      } else {
        await expect(
          run(agent, pendingState, {
            session,
            reasoningItemIdPolicy: 'preserve',
          }),
        ).rejects.toBeInstanceOf(OutputGuardrailTripwireTriggered);
      }

      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.requests).toHaveLength(1);
      expect(outputGuardrail).toHaveBeenCalledTimes(2);
      expect(session.operationIds).toHaveLength(2);
      expect(session.operationIds[1]).toBe(session.operationIds[0]);
      const persistedItems = await session.getItems();
      expect(
        persistedItems.map((item) =>
          item.type === 'message' ? `${item.type}:${item.role}` : item.type,
        ),
      ).toEqual([
        'message:user',
        'reasoning',
        'function_call',
        'function_call_result',
      ]);
      expect(
        persistedItems.find((item) => item.type === 'reasoning'),
      ).not.toHaveProperty('id');
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'keeps only causal reasoning and committed tool history for blocked $mode mixed output',
    async (mode) => {
      const commitTool = tool({
        name: 'commit_tool',
        description: 'Commits a side effect.',
        parameters: z.object({}),
        execute: async () => 'committed-result',
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            reasoningItem('reasoning-message', 'draft the rejected message'),
            fakeModelMessage('rejected assistant message'),
            reasoningItem('reasoning-tool', 'run the committed tool'),
            functionToolCall('commit_tool', 'call-mixed'),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Mixed blocked output agent',
        model,
        tools: [commitTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'block mixed output',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: true,
            }),
          },
        ],
      });
      const session = new MemorySession();

      if (mode === 'streamed') {
        const result = await run(agent, 'Use commit_tool', {
          session,
          stream: true,
        });
        await expect(result.completed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
      } else {
        await expect(
          run(agent, 'Use commit_tool', { session }),
        ).rejects.toBeInstanceOf(OutputGuardrailTripwireTriggered);
      }

      const items = await session.getItems();
      expect(
        items.map((item) =>
          item.type === 'message' ? `${item.type}:${item.role}` : item.type,
        ),
      ).toEqual([
        'message:user',
        'reasoning',
        'function_call',
        'function_call_result',
      ]);
      expect(
        items.some(
          (item) =>
            item.type === 'message' &&
            item.role === 'assistant' &&
            JSON.stringify(item.content).includes('rejected assistant'),
        ),
      ).toBe(false);
      expect(items.find((item) => item.type === 'reasoning')).toMatchObject({
        id: 'reasoning-tool',
      });
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'preserves the full ordered batch when $mode output guardrails pass',
    async (mode) => {
      const commitTool = tool({
        name: 'commit_tool',
        description: 'Commits a side effect.',
        parameters: z.object({}),
        execute: async () => 'committed-result',
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            reasoningItem('reasoning-message-pass', 'draft the message'),
            fakeModelMessage('accepted assistant message'),
            reasoningItem('reasoning-tool-pass', 'run the tool'),
            functionToolCall('commit_tool', 'call-pass-order'),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Ordered pass output agent',
        model,
        tools: [commitTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'allow ordered output',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: false,
            }),
          },
        ],
      });
      const session = new MemorySession();

      if (mode === 'streamed') {
        const result = await run(agent, 'Use commit_tool', {
          session,
          stream: true,
        });
        await result.completed;
      } else {
        await run(agent, 'Use commit_tool', { session });
      }

      expect(
        (await session.getItems()).map((item) =>
          item.type === 'message' ? `${item.type}:${item.role}` : item.type,
        ),
      ).toEqual([
        'message:user',
        'reasoning',
        'message:assistant',
        'reasoning',
        'function_call',
        'function_call_result',
      ]);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'persists serialized $mode execution provenance when a session is attached later',
    async (mode) => {
      const execute = vi.fn(async () => 'committed-result');
      const commitTool = tool({
        name: 'serialized_commit_tool',
        description: 'Commits before state serialization.',
        parameters: z.object({}),
        execute,
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            fakeModelMessage('rejected serialized assistant output'),
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
            name: 'keep blocking serialized result',
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
      expect(
        blockedState!._currentTurnSessionHistoryTransactionInputItems,
      ).toMatchObject([{ type: 'message', role: 'user' }]);
      expect(blockedState!.toJSON().currentTurnSessionInputItems).toMatchObject(
        [{ type: 'message', role: 'user' }],
      );

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
      const persistedItems = await session.getItems();
      expect(
        persistedItems.map((item) =>
          item.type === 'message' ? `${item.type}:${item.role}` : item.type,
        ),
      ).toEqual(['message:user', 'function_call', 'function_call_result']);
      expect(getPersistedToolItems(persistedItems)).toMatchObject([
        { type: 'function_call', callId: 'call-serialized' },
        { type: 'function_call_result', callId: 'call-serialized' },
      ]);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'persists each serialized multi-turn $mode tool pair exactly once when a session is attached later',
    async (mode) => {
      const firstExecute = vi.fn(async () => 'first-result');
      const finalExecute = vi.fn(async () => 'final-result');
      const firstTool = tool({
        name: 'serialized_first_tool',
        description: 'Runs before the final tool turn.',
        parameters: z.object({}),
        execute: firstExecute,
      });
      const finalTool = tool({
        name: 'serialized_final_tool',
        description: 'Produces the blocked final tool result.',
        parameters: z.object({}),
        execute: finalExecute,
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            functionToolCall('serialized_first_tool', 'call-serialized-first'),
          ],
          usage: new Usage(),
        },
        {
          output: [
            fakeModelMessage('rejected multi-turn assistant output'),
            functionToolCall('serialized_final_tool', 'call-serialized-final'),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Serialized multi-turn committed tool agent',
        model,
        tools: [firstTool, finalTool],
        toolUseBehavior: { stopAtToolNames: ['serialized_final_tool'] },
        outputGuardrails: [
          {
            name: 'keep blocking serialized multi-turn result',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: true,
            }),
          },
        ],
      });

      let blockedState: RunState<undefined, typeof agent> | undefined;
      if (mode === 'streamed') {
        const result = await run(agent, 'Use both serialized tools', {
          stream: true,
        });
        await expect(result.completed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
        blockedState = result.state;
      } else {
        try {
          await run(agent, 'Use both serialized tools');
        } catch (error) {
          expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
          blockedState = (
            error as { state?: RunState<undefined, typeof agent> }
          ).state;
        }
      }

      expect(blockedState).toBeDefined();
      expect(
        blockedState!._currentTurnSessionHistoryTransactionInputItems,
      ).toMatchObject([{ type: 'message', role: 'user' }]);

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

      expect(firstExecute).toHaveBeenCalledTimes(1);
      expect(finalExecute).toHaveBeenCalledTimes(1);
      expect(model.requests).toHaveLength(2);
      const persistedItems = await session.getItems();
      expect(
        persistedItems.map((item) =>
          item.type === 'message' ? `${item.type}:${item.role}` : item.type,
        ),
      ).toEqual([
        'message:user',
        'function_call',
        'function_call_result',
        'function_call',
        'function_call_result',
      ]);
      expect(getPersistedToolItems(persistedItems)).toMatchObject([
        { type: 'function_call', callId: 'call-serialized-first' },
        { type: 'function_call_result', callId: 'call-serialized-first' },
        { type: 'function_call', callId: 'call-serialized-final' },
        { type: 'function_call_result', callId: 'call-serialized-final' },
      ]);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'rejects accepted $mode final output restored from serialized terminal state',
    async (mode) => {
      let guardrailShouldTrip = true;
      const execute = vi.fn(async () => 'committed-result');
      const commitTool = tool({
        name: 'serialized_accept_tool',
        description: 'Commits before terminal state serialization.',
        parameters: z.object({}),
        execute,
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            fakeModelMessage('serialized assistant output'),
            functionToolCall(
              'serialized_accept_tool',
              'call-serialized-accept',
            ),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Serialized accepted output agent',
        model,
        tools: [commitTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'toggle serialized final output',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: guardrailShouldTrip,
            }),
          },
        ],
      });

      let blockedState: RunState<undefined, typeof agent> | undefined;
      if (mode === 'streamed') {
        const result = await run(agent, 'Use serialized_accept_tool', {
          stream: true,
        });
        await expect(result.completed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
        blockedState = result.state;
      } else {
        try {
          await run(agent, 'Use serialized_accept_tool');
        } catch (error) {
          expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
          blockedState = (
            error as { state?: RunState<undefined, typeof agent> }
          ).state;
        }
      }

      const restored = await RunState.fromString(
        agent,
        blockedState!.toString(),
      );
      const session = new MemorySession();
      guardrailShouldTrip = false;
      if (mode === 'streamed') {
        const resumed = await run(agent, restored, { session, stream: true });
        await expect(resumed.completed).rejects.toThrow(
          'Accepted final output cannot be resumed directly from serialized terminal state.',
        );
      } else {
        await expect(run(agent, restored, { session })).rejects.toThrow(
          'Accepted final output cannot be resumed directly from serialized terminal state.',
        );
      }

      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.requests).toHaveLength(1);
      expect(await session.getItems()).toEqual([]);
      expect(
        restored._currentTurnSessionHistoryTransactionSessionId,
      ).toBeUndefined();
      expect(
        restored.toJSON().currentTurnExecutedWithSessionBinding,
      ).toBeUndefined();

      const replacementSession = new MemorySession();
      if (mode === 'streamed') {
        const resumed = await run(agent, restored, {
          session: replacementSession,
          stream: true,
        });
        await expect(resumed.completed).rejects.toThrow(
          'Accepted final output cannot be resumed directly from serialized terminal state.',
        );
      } else {
        await expect(
          run(agent, restored, { session: replacementSession }),
        ).rejects.toThrow(
          'Accepted final output cannot be resumed directly from serialized terminal state.',
        );
      }
      expect(await replacementSession.getItems()).toEqual([]);
      expect(
        restored._currentTurnSessionHistoryTransactionSessionId,
      ).toBeUndefined();
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'rejects accepted $mode terminal output after an excluded executed result',
    async (mode) => {
      const agent = new Agent({ name: 'Excluded executed result agent' });
      const state = new RunState(new RunContext(), 'input', agent, 1);
      state._generatedItems = [
        new RunToolCallItem(
          {
            type: 'shell_call',
            callId: 'excluded-executed-shell',
            status: 'completed',
            action: { commands: ['echo committed'] },
          },
          agent,
        ),
        new RunToolCallOutputItem(
          {
            type: 'shell_call_output',
            callId: 'excluded-executed-shell',
            output: [],
            providerData: { status: 'incomplete' },
          },
          agent,
          [],
          undefined,
          'executed',
        ),
      ];
      state._currentStep = {
        type: 'next_step_final_output',
        output: 'accepted excluded execution',
      };
      const restored = await RunState.fromString(agent, state.toString());
      const session = new MemorySession();

      if (mode === 'streamed') {
        const result = await run(agent, restored, { session, stream: true });
        await expect(result.completed).rejects.toThrow(
          'Accepted final output cannot be resumed directly from serialized terminal state.',
        );
      } else {
        await expect(run(agent, restored, { session })).rejects.toThrow(
          'Accepted final output cannot be resumed directly from serialized terminal state.',
        );
      }

      expect(await session.getItems()).toEqual([]);
      expect(
        restored._currentTurnSessionHistoryTransactionSessionId,
      ).toBeUndefined();
    },
  );

  it('does not finalize a pre-aborted turn-zero serialized streaming terminal state', async () => {
    let guardrailShouldTrip = true;
    const outputGuardrail = vi.fn(async () => ({
      outputInfo: null,
      tripwireTriggered: guardrailShouldTrip,
    }));
    const model = new ApprovalSessionModel([
      {
        output: [fakeModelMessage('blocked turn-zero terminal output')],
        usage: new Usage(),
      },
    ]);
    const agent = new Agent({
      name: 'Pre-aborted turn-zero terminal agent',
      model,
      outputGuardrails: [
        {
          name: 'toggle turn-zero terminal output',
          execute: outputGuardrail,
        },
      ],
    });
    const runner = new Runner();
    const runnerEnd = vi.fn();
    const agentEnd = vi.fn();
    runner.on('agent_end', runnerEnd);
    agent.on('agent_end', agentEnd);

    const first = await runner.run(agent, 'hello', { stream: true });
    await expect(first.completed).rejects.toBeInstanceOf(
      OutputGuardrailTripwireTriggered,
    );
    const serialized = first.state.toJSON();
    serialized.currentTurn = 0;
    const restored = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );
    guardrailShouldTrip = false;
    outputGuardrail.mockClear();
    const session = new MemorySession();
    const controller = new AbortController();
    controller.abort(new Error('cancel turn-zero terminal resume'));

    const resumed = await runner.run(agent, restored, {
      session,
      signal: controller.signal,
      stream: true,
    });
    await resumed.completed;

    expect(resumed.cancelled).toBe(true);
    expect(outputGuardrail).not.toHaveBeenCalled();
    expect(model.requests).toHaveLength(1);
    expect(runnerEnd).not.toHaveBeenCalled();
    expect(agentEnd).not.toHaveBeenCalled();
    expect(await session.getItems()).toEqual([]);
  });

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'does not finalize a pre-aborted serialized $mode terminal state',
    async (mode) => {
      let guardrailShouldTrip = true;
      const execute = vi.fn(async () => 'pre-aborted-result');
      const commitTool = tool({
        name: 'pre_aborted_serialized_tool',
        description: 'Commits before the serialized terminal resume.',
        parameters: z.object({}),
        execute,
      });
      const outputGuardrail = vi.fn(async () => ({
        outputInfo: null,
        tripwireTriggered: guardrailShouldTrip,
      }));
      const model = new ApprovalSessionModel([
        {
          output: [
            fakeModelMessage('blocked terminal output'),
            functionToolCall(
              'pre_aborted_serialized_tool',
              'call-pre-aborted-serialized',
            ),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Pre-aborted serialized terminal agent',
        model,
        tools: [commitTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'toggle terminal output',
            execute: outputGuardrail,
          },
        ],
      });
      const runner = new Runner();
      const runnerEnd = vi.fn();
      const agentEnd = vi.fn();
      runner.on('agent_end', runnerEnd);
      agent.on('agent_end', agentEnd);

      let blockedState: RunState<undefined, typeof agent> | undefined;
      if (mode === 'streamed') {
        const first = await runner.run(agent, 'hello', { stream: true });
        await expect(first.completed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
        blockedState = first.state;
      } else {
        try {
          await runner.run(agent, 'hello');
        } catch (error) {
          expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
          blockedState = (
            error as { state?: RunState<undefined, typeof agent> }
          ).state;
        }
      }

      const restored = await RunState.fromString(
        agent,
        blockedState!.toString(),
      );
      guardrailShouldTrip = false;
      outputGuardrail.mockClear();
      const session = new MemorySession();
      const controller = new AbortController();
      const abortReason = new Error('cancel terminal resume');
      controller.abort(abortReason);

      if (mode === 'streamed') {
        const resumed = await runner.run(agent, restored, {
          session,
          signal: controller.signal,
          stream: true,
        });
        await resumed.completed;
        expect(resumed.cancelled).toBe(true);
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        expect(resumed.finalOutput).toBeUndefined();
        warnSpy.mockRestore();
      } else {
        await expect(
          runner.run(agent, restored, {
            session,
            signal: controller.signal,
          }),
        ).rejects.toBe(abortReason);
      }

      expect(outputGuardrail).not.toHaveBeenCalled();
      expect(model.requests).toHaveLength(1);
      expect(runnerEnd).not.toHaveBeenCalled();
      expect(agentEnd).not.toHaveBeenCalled();
      expect(await session.getItems()).toEqual([]);
      expect(
        restored._currentTurnSessionHistoryTransactionSessionId,
      ).toBeUndefined();
      expect(
        restored.toJSON().currentTurnExecutedWithSessionBinding,
      ).toBeUndefined();

      guardrailShouldTrip = true;
      if (mode === 'streamed') {
        const retried = await runner.run(agent, restored, {
          session,
          stream: true,
        });
        await expect(retried.completed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
      } else {
        await expect(
          runner.run(agent, restored, { session }),
        ).rejects.toBeInstanceOf(OutputGuardrailTripwireTriggered);
      }

      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.requests).toHaveLength(1);
      const persistedItems = await session.getItems();
      expect(
        persistedItems.map((item) =>
          item.type === 'message' ? `${item.type}:${item.role}` : item.type,
        ),
      ).toEqual(['message:user', 'function_call', 'function_call_result']);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'rejects accepted $mode hosted work restored from serialized terminal state',
    async (mode) => {
      const model = new ApprovalSessionModel([]);
      const agent = new Agent({
        name: 'Serialized hosted work agent',
        model,
      });
      const state = new RunState(new RunContext(), 'input', agent, 1);
      state._generatedItems = [
        new RunToolCallItem(
          {
            type: 'hosted_tool_call',
            id: 'serialized-hosted-call',
            name: 'web_search_call',
            status: 'completed',
            providerData: { type: 'web_search_call', status: 'completed' },
          },
          agent,
        ),
      ];
      state._currentStep = {
        type: 'next_step_final_output',
        output: 'accepted hosted output',
      };
      const restored = await RunState.fromString(agent, state.toString());
      const session = new MemorySession();

      if (mode === 'streamed') {
        const result = await run(agent, restored, { session, stream: true });
        await expect(result.completed).rejects.toThrow(
          'Accepted final output cannot be resumed directly from serialized terminal state.',
        );
      } else {
        await expect(run(agent, restored, { session })).rejects.toThrow(
          'Accepted final output cannot be resumed directly from serialized terminal state.',
        );
      }

      expect(model.requests).toHaveLength(0);
      expect(await session.getItems()).toEqual([]);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'replaces a blocked $mode sparse suffix with the full accepted order on RunState resume',
    async (mode) => {
      let guardrailShouldTrip = true;
      const execute = vi.fn(async () => 'committed-result');
      const commitTool = tool({
        name: 'resume_commit_tool',
        description: 'Commits before an accepted state resume.',
        parameters: z.object({}),
        execute,
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            reasoningItem('reasoning-message-resume', 'draft the message'),
            fakeModelMessage('accepted after resume'),
            reasoningItem('reasoning-tool-resume', 'run the tool'),
            functionToolCall('resume_commit_tool', 'call-resume-ordered'),
          ],
          usage: new Usage(),
        },
      ]);
      const outputGuardrail = vi.fn(async () => ({
        outputInfo: null,
        tripwireTriggered: guardrailShouldTrip,
      }));
      const agent = new Agent({
        name: 'Accepted resume agent',
        model,
        tools: [commitTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'toggle blocked output',
            execute: outputGuardrail,
          },
        ],
      });
      const session = new CompactionTrackingSession();

      let blockedState: RunState<undefined, typeof agent> | undefined;
      if (mode === 'streamed') {
        const result = await run(agent, 'Use resume_commit_tool', {
          session,
          stream: true,
          reasoningItemIdPolicy: 'omit',
        });
        await expect(result.completed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
        blockedState = result.state;
      } else {
        try {
          await run(agent, 'Use resume_commit_tool', {
            session,
            reasoningItemIdPolicy: 'omit',
          });
        } catch (error) {
          expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
          blockedState = (
            error as { state?: RunState<undefined, typeof agent> }
          ).state;
        }
      }
      expect(blockedState).toBeDefined();
      await expect(
        RunState.fromString(agent, blockedState!.toString()),
      ).rejects.toThrow(
        'Serialized output guardrail session transaction authority cannot be resumed safely.',
      );
      expect(outputGuardrail).toHaveBeenCalledTimes(1);
      expect(
        (await session.getItems()).map((item) =>
          item.type === 'message' ? `${item.type}:${item.role}` : item.type,
        ),
      ).toEqual([
        'message:user',
        'reasoning',
        'function_call',
        'function_call_result',
      ]);
      expect(session.compactionSnapshots).toHaveLength(0);

      guardrailShouldTrip = false;
      let resumedFinalOutput: string | undefined;
      if (mode === 'streamed') {
        const resumed = await run(agent, blockedState!, {
          session,
          stream: true,
          reasoningItemIdPolicy: 'preserve',
        });
        await resumed.completed;
        resumedFinalOutput = resumed.finalOutput;
      } else {
        const resumed = await run(agent, blockedState!, {
          session,
          reasoningItemIdPolicy: 'preserve',
        });
        resumedFinalOutput = resumed.finalOutput;
      }
      expect(resumedFinalOutput).toBe('committed-result');
      expect(outputGuardrail).toHaveBeenCalledTimes(2);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.requests).toHaveLength(1);
      expect(
        (await session.getItems()).map((item) =>
          item.type === 'message' ? `${item.type}:${item.role}` : item.type,
        ),
      ).toEqual([
        'message:user',
        'reasoning',
        'message:assistant',
        'reasoning',
        'function_call',
        'function_call_result',
      ]);
      expect(blockedState!._currentTurnDeferredSessionItemIndexes.size).toBe(0);
      expect(
        (await session.getItems())
          .filter((item) => item.type === 'reasoning')
          .every((item) => !('id' in item)),
      ).toBe(true);
      expect(session.compactionSnapshots).toHaveLength(1);
      expect(session.compactionArgs[0]?.responseId).toBe(
        mode === 'streamed' ? 'stream-response' : undefined,
      );
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'uses the session comparison hook before a $mode sparse resume guardrail',
    async (mode) => {
      class BackendMetadataSession extends MemorySession {
        override async getItems(limit?: number): Promise<AgentInputItem[]> {
          return (await super.getItems(limit)).map((item) => ({
            ...item,
            providerData: { backend_revision: 'stored' },
          })) as AgentInputItem[];
        }

        prepareHistoryItemsForPersistenceComparison(
          items: AgentInputItem[],
        ): AgentInputItem[] {
          return items.map((item) => {
            const comparable = { ...item } as AgentInputItem & {
              providerData?: unknown;
            };
            delete comparable.providerData;
            return comparable;
          });
        }
      }

      let guardrailShouldTrip = true;
      const execute = vi.fn(async () => 'committed-result');
      const commitTool = tool({
        name: 'metadata_resume_tool',
        description: 'Commits before a metadata-normalized resume.',
        parameters: z.object({}),
        execute,
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            fakeModelMessage('accepted after metadata normalization'),
            functionToolCall('metadata_resume_tool', 'call-metadata-resume'),
          ],
          usage: new Usage(),
        },
      ]);
      const outputGuardrail = vi.fn(async () => ({
        outputInfo: null,
        tripwireTriggered: guardrailShouldTrip,
      }));
      const agent = new Agent({
        name: 'Metadata-normalized resume agent',
        model,
        tools: [commitTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          { name: 'toggle metadata resume', execute: outputGuardrail },
        ],
      });
      const session = new BackendMetadataSession();

      let blockedState: RunState<undefined, typeof agent> | undefined;
      if (mode === 'streamed') {
        const result = await run(agent, 'Use metadata_resume_tool', {
          session,
          stream: true,
        });
        await expect(result.completed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
        blockedState = result.state;
      } else {
        try {
          await run(agent, 'Use metadata_resume_tool', { session });
        } catch (error) {
          expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
          blockedState = (
            error as { state?: RunState<undefined, typeof agent> }
          ).state;
        }
      }

      guardrailShouldTrip = false;
      if (mode === 'streamed') {
        const resumed = await run(agent, blockedState!, {
          session,
          stream: true,
        });
        await resumed.completed;
        expect(resumed.finalOutput).toBe('committed-result');
      } else {
        const resumed = await run(agent, blockedState!, { session });
        expect(resumed.finalOutput).toBe('committed-result');
      }
      expect(outputGuardrail).toHaveBeenCalledTimes(2);
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'rejects a $mode resume before its output guardrail when the blocked suffix advances',
    async (mode) => {
      let guardrailShouldTrip = true;
      const commitTool = tool({
        name: 'stale_resume_tool',
        description: 'Commits before a stale accepted resume.',
        parameters: z.object({}),
        execute: async () => 'committed-result',
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            functionToolCall('stale_resume_tool', 'call-stale-resume'),
            fakeModelMessage('accepted after resume'),
          ],
          usage: new Usage(),
        },
      ]);
      const outputGuardrail = vi.fn(async () => ({
        outputInfo: null,
        tripwireTriggered: guardrailShouldTrip,
      }));
      const agent = new Agent({
        name: 'Stale accepted resume agent',
        model,
        tools: [commitTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'toggle stale resume output',
            execute: outputGuardrail,
          },
        ],
      });
      const session = new CompactionTrackingSession();

      let blockedState: RunState<undefined, typeof agent> | undefined;
      if (mode === 'streamed') {
        const result = await run(agent, 'Use stale_resume_tool', {
          session,
          stream: true,
        });
        await expect(result.completed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
        blockedState = result.state;
      } else {
        try {
          await run(agent, 'Use stale_resume_tool', { session });
        } catch (error) {
          expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
          blockedState = (
            error as { state?: RunState<undefined, typeof agent> }
          ).state;
        }
      }
      expect(blockedState).toBeDefined();
      await session.addItems([fakeModelMessage('independent session advance')]);

      guardrailShouldTrip = false;
      const resumed =
        mode === 'streamed'
          ? run(agent, blockedState!, { session, stream: true })
          : run(agent, blockedState!, { session });
      await expect(resumed).rejects.toThrow(
        'Session history suffix no longer matches the transaction precondition.',
      );
      expect(outputGuardrail).toHaveBeenCalledTimes(1);
      expect(
        (await session.getItems()).map((item) =>
          item.type === 'message' ? `${item.type}:${item.role}` : item.type,
        ),
      ).toEqual([
        'message:user',
        'function_call',
        'function_call_result',
        'message:assistant',
      ]);
    },
  );
});

describe('approved tool output guardrail session persistence', () => {
  beforeAll(() => {
    setTracingDisabled(true);
  });

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'persists a terminal $mode rejection for a previously checkpointed approval call',
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
        name: 'Approved input rejection agent',
        model,
        tools: [approvalTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'block approved rejection',
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
        getPersistedToolItems(await session.getItems()).map((item) => [
          item.type,
          item.callId,
        ]),
      ).toEqual([
        ['function_call', 'call-approved-input-rejected'],
        ['function_call_result', 'call-approved-input-rejected'],
      ]);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'closes a previously persisted $mode approval call after user rejection',
    async (mode) => {
      const execute = vi.fn(async () => 'should-not-run');
      const approvalTool = tool({
        name: 'user_rejected_tool',
        description: 'Requires approval and is rejected by the user.',
        parameters: z.object({}),
        needsApproval: true,
        execute,
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            functionToolCall('user_rejected_tool', 'call-user-rejected'),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'User rejection agent',
        model,
        tools: [approvalTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'block user rejection output',
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

      const first = await runOnce('Use user_rejected_tool');
      expect(first.interruptions).toHaveLength(1);
      first.state.reject(first.interruptions[0], {
        message: 'Rejected by user.',
      });
      await expect(runOnce(first.state)).rejects.toBeInstanceOf(
        OutputGuardrailTripwireTriggered,
      );

      expect(execute).not.toHaveBeenCalled();
      expect(
        getPersistedToolItems(await session.getItems()).map((item) => [
          item.type,
          item.callId,
        ]),
      ).toEqual([
        ['function_call', 'call-user-rejected'],
        ['function_call_result', 'call-user-rejected'],
      ]);
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
    'rebinds $mode transaction authority before a post-approval final tool executes',
    async (mode) => {
      class MutableReasoningPolicySession extends MemorySession {
        preserveReasoningIds = false;

        preserveReasoningItemIdsForPersistence(): boolean {
          return this.preserveReasoningIds;
        }
      }

      const session = new MutableReasoningPolicySession();
      const approvalTool = tool({
        name: 'checkpoint_approval_tool',
        description: 'Requires approval before the next model turn.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'approved-result',
      });
      const executeFinalTool = vi.fn(async () => {
        session.preserveReasoningIds = true;
        return 'committed-after-checkpoint';
      });
      const finalTool = tool({
        name: 'post_checkpoint_final_tool',
        description: 'Commits after the approval checkpoint.',
        parameters: z.object({}),
        execute: executeFinalTool,
      });
      const model = new ApprovalSessionModel([
        {
          output: [
            functionToolCall(
              'checkpoint_approval_tool',
              'call-checkpoint-approval',
            ),
          ],
          usage: new Usage(),
        },
        {
          output: [
            reasoningItem('post-checkpoint-reasoning-id', 'run the final tool'),
            functionToolCall(
              'post_checkpoint_final_tool',
              'call-post-checkpoint-final',
            ),
          ],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'Post-approval authority agent',
        model,
        tools: [approvalTool, finalTool],
        toolUseBehavior: {
          stopAtToolNames: ['post_checkpoint_final_tool'],
        },
        outputGuardrails: [
          {
            name: 'block post-checkpoint final output',
            execute: async () => ({
              outputInfo: null,
              tripwireTriggered: true,
            }),
          },
        ],
      });

      const first =
        mode === 'streamed'
          ? await (async () => {
              const result = await run(agent, 'Use the approval tool', {
                session,
                stream: true,
                reasoningItemIdPolicy: 'preserve',
              });
              await result.completed;
              return result;
            })()
          : await run(agent, 'Use the approval tool', {
              session,
              reasoningItemIdPolicy: 'preserve',
            });
      expect(first.interruptions).toHaveLength(1);
      first.state.approve(first.interruptions[0]);

      if (mode === 'streamed') {
        const resumed = await run(agent, first.state, {
          session,
          stream: true,
          reasoningItemIdPolicy: 'omit',
        });
        await expect(resumed.completed).rejects.toBeInstanceOf(
          OutputGuardrailTripwireTriggered,
        );
      } else {
        await expect(
          run(agent, first.state, {
            session,
            reasoningItemIdPolicy: 'omit',
          }),
        ).rejects.toBeInstanceOf(OutputGuardrailTripwireTriggered);
      }

      expect(executeFinalTool).toHaveBeenCalledTimes(1);
      const persistedReasoning = (await session.getItems()).find(
        (item) => item.type === 'reasoning',
      );
      expect(persistedReasoning).toBeDefined();
      expect(persistedReasoning).not.toHaveProperty('id');
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
