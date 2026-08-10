import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InputGuardrailTripwireTriggered,
  ModelRefusalError,
  RunInputItem,
  RunState,
  Runner,
  UserError,
  run,
  tool,
  type AgentInputItem,
} from '../src';
import type { Model, ModelRequest, ModelResponse } from '../src/model';
import { RunContext } from '../src/runContext';
import { RunToolApprovalItem } from '../src/items';
import { MemorySession } from '../src/memory/memorySession';
import type { Session } from '../src/memory/session';
import type * as protocol from '../src/types/protocol';
import { Usage } from '../src/usage';
import { fakeModelMessage, fakeModelRefusal } from './stubs';

class RecordingModel implements Model {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const response = this.responses.shift();
    if (!response) {
      throw new Error('No response found');
    }
    return response;
  }

  async *getStreamedResponse(): AsyncIterable<protocol.StreamEvent> {
    yield* [];
    throw new Error('Not implemented');
  }
}

class FailOnceModel implements Model {
  readonly requests: ModelRequest[] = [];
  private failed = false;

  constructor(private readonly response: ModelResponse) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    if (!this.failed) {
      this.failed = true;
      throw new Error('model request failed');
    }
    return this.response;
  }

  async *getStreamedResponse(): AsyncIterable<protocol.StreamEvent> {
    yield* [];
    throw new Error('Not implemented');
  }
}

class FailingAcceptedStreamModel implements Model {
  streamCalls = 0;

  async getResponse(): Promise<ModelResponse> {
    throw new Error('Not implemented');
  }

  async *getStreamedResponse(): AsyncIterable<protocol.StreamEvent> {
    this.streamCalls += 1;
    yield {
      type: 'output_text_delta',
      delta: 'accepted',
      providerData: {},
    } as protocol.StreamEvent;
    throw new Error('stream failed after acceptance');
  }
}

class RecordingStreamModel implements Model {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async getResponse(): Promise<ModelResponse> {
    throw new Error('Not implemented');
  }

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<protocol.StreamEvent> {
    this.requests.push(structuredClone(request));
    const response = this.responses.shift();
    if (!response) {
      throw new Error('No response found');
    }
    yield {
      type: 'response_done',
      response: {
        id: response.responseId,
        requestId: response.requestId,
        usage: {
          requests: response.usage.requests,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
        },
        output: response.output,
      },
    } as protocol.StreamEvent;
  }
}

class AbortBeforeEventStreamModel implements Model {
  streamCalls = 0;
  started!: Promise<void>;
  private markStarted!: () => void;

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.markStarted = resolve;
    });
  }

  async getResponse(): Promise<ModelResponse> {
    throw new Error('Not implemented');
  }

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<protocol.StreamEvent> {
    this.streamCalls += 1;
    this.markStarted();
    await new Promise<void>((_resolve, reject) => {
      const abort = () => {
        const error = new Error('aborted before first event');
        error.name = 'AbortError';
        reject(error);
      };
      if (request.signal?.aborted) {
        abort();
        return;
      }
      request.signal?.addEventListener('abort', abort, { once: true });
    });
    yield* [];
  }
}

class NeverCalledStreamModel implements Model {
  streamCalls = 0;

  async getResponse(): Promise<ModelResponse> {
    throw new Error('Not implemented');
  }

  async *getStreamedResponse(): AsyncIterable<protocol.StreamEvent> {
    this.streamCalls += 1;
    yield* [];
    throw new Error('Model should not be called');
  }
}

class FailOnceSession implements Session {
  readonly inner = new MemorySession();
  addAttempts = 0;

  getSessionId(): Promise<string> {
    return this.inner.getSessionId();
  }

  getItems(limit?: number): Promise<AgentInputItem[]> {
    return this.inner.getItems(limit);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    this.addAttempts += 1;
    if (this.addAttempts === 1) {
      throw new Error('session write failed');
    }
    await this.inner.addItems(items);
  }

  popItem(): Promise<AgentInputItem | undefined> {
    return this.inner.popItem();
  }

  clearSession(): Promise<void> {
    return this.inner.clearSession();
  }
}

class BlockingSession implements Session {
  readonly inner = new MemorySession();
  readonly addStarted: Promise<void>;
  private markAddStarted!: () => void;
  private releaseAdd!: () => void;
  private readonly addCanFinish: Promise<void>;

  constructor() {
    this.addStarted = new Promise<void>((resolve) => {
      this.markAddStarted = resolve;
    });
    this.addCanFinish = new Promise<void>((resolve) => {
      this.releaseAdd = resolve;
    });
  }

  getSessionId(): Promise<string> {
    return this.inner.getSessionId();
  }

  getItems(limit?: number): Promise<AgentInputItem[]> {
    return this.inner.getItems(limit);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    this.markAddStarted();
    await this.addCanFinish;
    await this.inner.addItems(items);
  }

  release(): void {
    this.releaseAdd();
  }

  popItem(): Promise<AgentInputItem | undefined> {
    return this.inner.popItem();
  }

  clearSession(): Promise<void> {
    return this.inner.clearSession();
  }
}

function message(text: string): AgentInputItem {
  return { type: 'message', role: 'user', content: text };
}

function createResumableState<TAgent extends Agent<any, any>>(
  agent: TAgent,
  maxTurns = 3,
) {
  const state = new RunState(new RunContext(), 'initial', agent, maxTurns);
  state._currentTurn = 1;
  state._currentStep = { type: 'next_step_run_again' };
  return state;
}

describe('RunState pending input', () => {
  it('stages immutable input in order and round-trips it', async () => {
    const agent = new Agent({ name: 'pending-input' });
    const state = createResumableState(agent);

    state.addInput('first');
    state.addInput([message('second')]);
    const observed = state.pendingInput;
    observed.push(message('mutated copy'));
    (observed[0] as { content: string }).content = 'changed copy';

    expect(state.pendingInput).toEqual([message('first'), message('second')]);
    const restored = await RunState.fromString(agent, state.toString());
    expect(restored.pendingInput).toEqual([
      message('first'),
      message('second'),
    ]);

    restored.clearPendingInput();
    expect(restored.pendingInput).toEqual([]);
    expect(
      (await RunState.fromString(agent, restored.toString())).pendingInput,
    ).toEqual([]);
  });

  it('defaults older snapshots and rejects pending input under an older schema', async () => {
    const agent = new Agent({ name: 'legacy-pending-input' });
    const state = createResumableState(agent);
    const legacy = state.toJSON() as Record<string, unknown>;
    legacy.$schemaVersion = '1.17';
    delete legacy.pendingInput;

    const restored = await RunState.fromString(agent, JSON.stringify(legacy));
    expect(restored.pendingInput).toEqual([]);

    legacy.pendingInput = [];
    await expect(
      RunState.fromString(agent, JSON.stringify(legacy)),
    ).rejects.toThrow(/does not support pending input/);

    legacy.pendingInput = [message('unsupported')];
    await expect(
      RunState.fromString(agent, JSON.stringify(legacy)),
    ).rejects.toThrow(/does not support pending input/);

    const malformed = state.toJSON() as Record<string, unknown>;
    malformed.pendingInput = ['not an input item'];
    await expect(
      RunState.fromString(agent, JSON.stringify(malformed)),
    ).rejects.toThrow();

    const itemState = createResumableState(agent);
    itemState._generatedItems.push(
      new RunInputItem(message('accepted'), agent, 'input-occurrence'),
    );
    const oldItemSnapshot = itemState.toJSON() as Record<string, unknown>;
    oldItemSnapshot.$schemaVersion = '1.17';
    await expect(
      RunState.fromString(agent, JSON.stringify(oldItemSnapshot)),
    ).rejects.toThrow(/does not support pending input/);

    const acceptedState = createResumableState(agent);
    acceptedState._currentStep = {
      type: 'next_step_interruption',
      data: { interruptions: [], responseAccepted: true },
    };
    const oldAcceptedSnapshot = acceptedState.toJSON() as Record<
      string,
      unknown
    >;
    oldAcceptedSnapshot.$schemaVersion = '1.17';
    await expect(
      RunState.fromString(agent, JSON.stringify(oldAcceptedSnapshot)),
    ).rejects.toThrow(/does not support pending input/);

    for (const data of [
      { responseAccepted: false },
      { localProcessingStarted: false },
      { localProcessingStarted: true },
    ]) {
      const oldCheckpointSnapshot = createResumableState(
        agent,
      ).toJSON() as Record<string, unknown>;
      oldCheckpointSnapshot.$schemaVersion = '1.17';
      oldCheckpointSnapshot.currentStep = {
        type: 'next_step_interruption',
        data: { interruptions: [], ...data },
      };
      await expect(
        RunState.fromString(agent, JSON.stringify(oldCheckpointSnapshot)),
      ).rejects.toThrow(/does not support pending input/);
    }
  });

  it('rejects terminal and unsupported interrupted states before mutation', () => {
    const approvalCall: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'approval_tool',
      callId: 'approval-call',
      status: 'completed',
      arguments: '{}',
    };
    const terminalAgent = new Agent({ name: 'terminal' });
    const terminal = new RunState(
      new RunContext(),
      'initial',
      terminalAgent,
      3,
    );
    const terminalBefore = terminal.toString();
    expect(() => terminal.addInput('later')).toThrow(UserError);
    expect(terminal.toString()).toBe(terminalBefore);

    const stoppingAgent = new Agent({
      name: 'stopping',
      toolUseBehavior: 'stop_on_first_tool',
    });
    const interrupted = createResumableState(stoppingAgent);
    const approvalItem = new RunToolApprovalItem(approvalCall, stoppingAgent);
    interrupted._currentStep = {
      type: 'next_step_interruption',
      data: { interruptions: [approvalItem] },
    };
    const interruptedBefore = interrupted.toString();
    expect(() => interrupted.addInput('later')).toThrow(
      /tool result may end the run/,
    );
    expect(interrupted.toString()).toBe(interruptedBefore);

    const accepted = createResumableState(terminalAgent);
    accepted._currentStep = {
      type: 'next_step_interruption',
      data: { interruptions: [], responseAccepted: true },
    };
    const acceptedBefore = accepted.toString();
    expect(() => accepted.addInput('later')).toThrow(
      /accepted model response is awaiting local processing/,
    );
    expect(accepted.toString()).toBe(acceptedBefore);

    const exhausted = createResumableState(terminalAgent, 1);
    const exhaustedBefore = exhausted.toString();
    expect(() => exhausted.addInput('later')).toThrow(
      /no remaining model turns/,
    );
    expect(exhausted.toString()).toBe(exhaustedBefore);

    const namespacedAgent = new Agent({
      name: 'namespaced-stopping',
      toolUseBehavior: { stopAtToolNames: ['lookup_account'] },
    });
    const namespacedInterrupted = createResumableState(namespacedAgent);
    const namespacedCall: protocol.FunctionCallItem = {
      ...approvalCall,
      name: 'lookup_account',
      namespace: 'crm',
    };
    namespacedInterrupted._currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [
          new RunToolApprovalItem(namespacedCall, namespacedAgent),
        ],
      },
    };
    const namespacedBefore = namespacedInterrupted.toString();
    expect(namespacedInterrupted.getInterruptions()[0]?.name).toBe(
      'crm.lookup_account',
    );
    expect(() => namespacedInterrupted.addInput('later')).toThrow(
      /tool result may end the run/,
    );
    expect(namespacedInterrupted.toString()).toBe(namespacedBefore);
  });

  it('admits staged input after an approved tool output', async () => {
    const execute = vi.fn(async () => 'approved result');
    const approvalTool = tool({
      name: 'approval_tool',
      description: 'Requires approval.',
      parameters: z.object({}).strict(),
      needsApproval: true,
      execute,
    });
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'approval_tool',
      callId: 'approval-call',
      status: 'completed',
      arguments: '{}',
    };
    const model = new RecordingModel([
      { output: [functionCall], usage: new Usage() },
      { output: [fakeModelMessage('done')], usage: new Usage() },
    ]);
    const agent = new Agent({
      name: 'approval-pending-input',
      model,
      tools: [approvalTool],
    });
    const session = new MemorySession();

    const first = await run(agent, 'initial', { session, maxTurns: 1 });
    const approval = first.interruptions[0];
    expect(approval).toBeDefined();
    expect(first.state._currentTurn).toBe(1);
    expect(first.state._currentTurnInProgress).toBe(true);
    first.state.addInput('follow-up');
    first.state.approve(approval!);

    const completed = await new Runner().run(agent, first.state, { session });
    const secondInput = model.requests[1]?.input as AgentInputItem[];
    const resultIndex = secondInput.findIndex(
      (item) => item.type === 'function_call_result',
    );
    const pendingIndex = secondInput.findIndex(
      (item) =>
        item.type === 'message' &&
        item.role === 'user' &&
        item.content === 'follow-up',
    );

    expect(resultIndex).toBeGreaterThanOrEqual(0);
    expect(pendingIndex).toBeGreaterThan(resultIndex);
    expect(completed.state.pendingInput).toEqual([]);
    const admitted = completed.newItems.filter(
      (item): item is RunInputItem => item instanceof RunInputItem,
    );
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.rawItem).toEqual(message('follow-up'));
    expect(admitted[0]?.inputId).toBeTruthy();
    const restored = await RunState.fromString(
      agent,
      completed.state.toString(),
    );
    const restoredAdmission = restored._generatedItems.find(
      (item): item is RunInputItem => item instanceof RunInputItem,
    );
    expect(restoredAdmission?.inputId).toBe(admitted[0]?.inputId);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      (await session.getItems()).filter(
        (item) => item.type === 'message' && item.content === 'follow-up',
      ),
    ).toHaveLength(1);
  });

  it('keeps admitted input out of output-only views', async () => {
    const model = new RecordingModel([
      { output: [fakeModelRefusal('refused')], usage: new Usage() },
    ]);
    const agent = new Agent({ name: 'pending-output-view', model });
    const state = createResumableState(agent);
    state.addInput('follow-up');
    let errorHandlerOutput: AgentInputItem[] | undefined;
    let guardrailOutput: AgentInputItem[] | undefined;
    const runner = new Runner({
      outputGuardrails: [
        {
          name: 'capture-output',
          execute: async ({ details }) => {
            guardrailOutput = details?.output;
            return { tripwireTriggered: false, outputInfo: {} };
          },
        },
      ],
    });

    const result = await runner.run(agent, state, {
      errorHandlers: {
        modelRefusal: ({ runData }) => {
          errorHandlerOutput = runData.output;
          return { finalOutput: 'handled refusal' };
        },
      },
    });

    expect(result.history).toContainEqual(message('follow-up'));
    expect(
      result.newItems.some(
        (item) =>
          item instanceof RunInputItem &&
          item.rawItem.type === 'message' &&
          item.rawItem.role === 'user' &&
          item.rawItem.content === 'follow-up',
      ),
    ).toBe(true);
    for (const output of [result.output, errorHandlerOutput, guardrailOutput]) {
      expect(output).toBeDefined();
      expect(output).not.toContainEqual(message('follow-up'));
    }
    expect(result.output).toContainEqual(fakeModelRefusal('refused'));
  });

  it('keeps staged input pending until an approval is resolved', async () => {
    const execute = vi.fn(async () => 'approved result');
    const approvalTool = tool({
      name: 'approval_tool',
      description: 'Requires approval.',
      parameters: z.object({}).strict(),
      needsApproval: true,
      execute,
    });
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'approval_tool',
      callId: 'approval-call',
      status: 'completed',
      arguments: '{}',
    };
    const model = new RecordingModel([
      { output: [functionCall], usage: new Usage() },
      { output: [fakeModelMessage('done')], usage: new Usage() },
    ]);
    const agent = new Agent({
      name: 'unresolved-approval-pending-input',
      model,
      tools: [approvalTool],
    });
    const runner = new Runner();

    const first = await runner.run(agent, 'initial');
    first.state.addInput('wait for approval');
    const stillInterrupted = await runner.run(agent, first.state);

    expect(stillInterrupted.interruptions).toHaveLength(1);
    expect(first.state.pendingInput).toEqual([message('wait for approval')]);
    expect(model.requests).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();

    first.state.approve(first.state.getInterruptions()[0]!);
    const completed = await runner.run(agent, first.state);
    expect(completed.finalOutput).toBe('done');
    expect(first.state.pendingInput).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('runs guardrails before admission and retries staged input', async () => {
    const model = new RecordingModel([
      { output: [fakeModelMessage('done')], usage: new Usage() },
    ]);
    const agent = new Agent({ name: 'guarded-pending-input', model });
    const state = createResumableState(agent);
    state.addInput('guard me');
    const guardrail = vi
      .fn()
      .mockResolvedValueOnce({
        tripwireTriggered: true,
        outputInfo: { reason: 'blocked' },
      })
      .mockResolvedValueOnce({ tripwireTriggered: false, outputInfo: {} });
    const runner = new Runner({
      inputGuardrails: [
        {
          name: 'pending-guardrail',
          runInParallel: false,
          execute: guardrail,
        },
      ],
    });

    await expect(runner.run(agent, state)).rejects.toBeInstanceOf(
      InputGuardrailTripwireTriggered,
    );
    expect(model.requests).toHaveLength(0);
    expect(state.pendingInput).toEqual([message('guard me')]);
    expect(state._generatedItems).toHaveLength(0);
    expect(state._currentTurn).toBe(1);

    const completed = await runner.run(agent, state);
    expect(completed.finalOutput).toBe('done');
    expect(model.requests).toHaveLength(1);
    expect(state.pendingInput).toEqual([]);
    expect(guardrail).toHaveBeenCalledTimes(2);
    expect(guardrail.mock.calls[0]?.[0].input).toEqual([message('guard me')]);
  });

  it('runs default staged-input guardrails in parallel with the model', async () => {
    let releaseGuardrail!: () => void;
    let markGuardrailStarted!: () => void;
    let markModelStarted!: () => void;
    const guardrailCanFinish = new Promise<void>((resolve) => {
      releaseGuardrail = resolve;
    });
    const guardrailStarted = new Promise<void>((resolve) => {
      markGuardrailStarted = resolve;
    });
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve;
    });
    let guardrailCompleted = false;
    const guardrail = vi.fn(async () => {
      markGuardrailStarted();
      await guardrailCanFinish;
      guardrailCompleted = true;
      return { tripwireTriggered: false, outputInfo: {} };
    });

    class ParallelGuardrailModel implements Model {
      async getResponse(): Promise<ModelResponse> {
        expect(guardrailCompleted).toBe(false);
        markModelStarted();
        return {
          output: [fakeModelMessage('done')],
          usage: new Usage(),
        };
      }

      async *getStreamedResponse(): AsyncIterable<protocol.StreamEvent> {
        yield* [];
        throw new Error('Not implemented');
      }
    }

    const agent = new Agent({
      name: 'parallel-pending-guardrail',
      model: new ParallelGuardrailModel(),
    });
    const state = createResumableState(agent);
    state.addInput('guard in parallel');
    const runner = new Runner({
      inputGuardrails: [{ name: 'pending-guardrail', execute: guardrail }],
    });

    const runPromise = runner.run(agent, state);
    await guardrailStarted;
    await modelStarted;
    expect(guardrailCompleted).toBe(false);
    expect(guardrail).toHaveBeenCalledWith(
      expect.objectContaining({ input: [message('guard in parallel')] }),
    );

    releaseGuardrail();
    const completed = await runPromise;
    expect(completed.finalOutput).toBe('done');
    expect(state.pendingInput).toEqual([]);
  });

  it.each([
    { label: 'non-streaming', stream: false },
    { label: 'streaming', stream: true },
  ])(
    'keeps local staged input pending after a late parallel guardrail failure in a $label run',
    async ({ stream }) => {
      let markFirstModelStarted!: () => void;
      const firstModelStarted = new Promise<void>((resolve) => {
        markFirstModelStarted = resolve;
      });
      let modelCalls = 0;
      const nextResponse = (): ModelResponse => {
        modelCalls += 1;
        if (modelCalls === 1) {
          markFirstModelStarted();
        }
        return {
          output: [fakeModelMessage(modelCalls === 1 ? 'blocked' : 'done')],
          usage: new Usage(),
          responseId: `local-guardrail-${modelCalls}`,
        };
      };
      const model: Model = {
        async getResponse() {
          return nextResponse();
        },
        async *getStreamedResponse() {
          const response = nextResponse();
          yield {
            type: 'response_done',
            response: {
              id: response.responseId,
              usage: {
                requests: response.usage.requests,
                inputTokens: response.usage.inputTokens,
                outputTokens: response.usage.outputTokens,
                totalTokens: response.usage.totalTokens,
              },
              output: response.output,
            },
          } as protocol.StreamEvent;
        },
      };
      const guardrail = vi
        .fn(async () => ({ tripwireTriggered: false, outputInfo: {} }))
        .mockImplementationOnce(async () => {
          await firstModelStarted;
          return {
            tripwireTriggered: true,
            outputInfo: { reason: 'blocked after model start' },
          };
        });
      const agent = new Agent({ name: 'local-late-guardrail', model });
      const state = createResumableState(agent);
      state.addInput('guard local staged input');
      const session = new MemorySession();
      const runner = new Runner({
        inputGuardrails: [{ name: 'pending-guardrail', execute: guardrail }],
      });

      if (stream) {
        const failed = await runner.run(agent, state, {
          session,
          stream: true,
        });
        await expect(failed.completed).rejects.toBeInstanceOf(
          InputGuardrailTripwireTriggered,
        );
      } else {
        await expect(
          runner.run(agent, state, { session }),
        ).rejects.toBeInstanceOf(InputGuardrailTripwireTriggered);
      }

      expect(modelCalls).toBe(1);
      expect(guardrail).toHaveBeenCalledTimes(1);
      expect(state.pendingInput).toEqual([message('guard local staged input')]);
      expect(
        state._generatedItems.filter((item) => item instanceof RunInputItem),
      ).toHaveLength(0);
      expect(await session.getItems()).toEqual([]);

      if (stream) {
        const completed = await runner.run(agent, state, {
          session,
          stream: true,
        });
        await completed.completed;
      } else {
        await runner.run(agent, state, { session });
      }

      expect(modelCalls).toBe(2);
      expect(guardrail).toHaveBeenCalledTimes(2);
      expect(state.pendingInput).toEqual([]);
      expect(
        state._generatedItems.filter((item) => item instanceof RunInputItem),
      ).toHaveLength(1);
      expect(await session.getItems()).toEqual([
        message('guard local staged input'),
        fakeModelMessage('done'),
      ]);
    },
  );

  it('commits local staged input after a parallel guardrail succeeds following model failure', async () => {
    let releaseGuardrail!: () => void;
    let markModelFailed!: () => void;
    const guardrailCanFinish = new Promise<void>((resolve) => {
      releaseGuardrail = resolve;
    });
    const modelFailed = new Promise<void>((resolve) => {
      markModelFailed = resolve;
    });
    let modelCalls = 0;
    const model: Model = {
      async getResponse() {
        modelCalls += 1;
        if (modelCalls === 1) {
          markModelFailed();
          throw new Error('model failed before guardrail completion');
        }
        return {
          output: [fakeModelMessage('done')],
          usage: new Usage(),
        };
      },
      async *getStreamedResponse() {
        yield* [];
        throw new Error('Not implemented');
      },
    };
    const guardrail = vi.fn(async () => {
      await guardrailCanFinish;
      return { tripwireTriggered: false, outputInfo: {} };
    });
    const agent = new Agent({ name: 'guardrail-after-model-failure', model });
    const state = createResumableState(agent);
    state.addInput('persist after guardrail success');
    const session = new MemorySession();
    const runner = new Runner({
      inputGuardrails: [{ name: 'pending-guardrail', execute: guardrail }],
    });
    let runSettled = false;

    const running = runner.run(agent, state, { session }).finally(() => {
      runSettled = true;
    });
    await modelFailed;
    await Promise.resolve();

    expect(runSettled).toBe(false);
    expect(state.pendingInput).toEqual([
      message('persist after guardrail success'),
    ]);
    expect(
      state._generatedItems.filter((item) => item instanceof RunInputItem),
    ).toHaveLength(0);
    expect(await session.getItems()).toEqual([]);

    releaseGuardrail();
    await expect(running).rejects.toThrow(
      'model failed before guardrail completion',
    );
    expect(state.pendingInput).toEqual([]);
    expect(
      state._generatedItems.filter((item) => item instanceof RunInputItem),
    ).toHaveLength(1);
    expect(await session.getItems()).toEqual([
      message('persist after guardrail success'),
    ]);

    const completed = await runner.run(agent, state, { session });
    expect(completed.finalOutput).toBe('done');
    expect(modelCalls).toBe(2);
    expect(guardrail).toHaveBeenCalledTimes(1);
    expect(await session.getItems()).toEqual([
      message('persist after guardrail success'),
      fakeModelMessage('done'),
    ]);
  });

  it('prefers a parallel staged-input guardrail failure over a model refusal handler', async () => {
    let releaseGuardrail!: () => void;
    let markModelFailed!: () => void;
    const guardrailCanFinish = new Promise<void>((resolve) => {
      releaseGuardrail = resolve;
    });
    const modelFailed = new Promise<void>((resolve) => {
      markModelFailed = resolve;
    });
    const guardrail = vi.fn(async () => {
      await guardrailCanFinish;
      return {
        tripwireTriggered: true,
        outputInfo: { reason: 'blocked after model failure' },
      };
    });
    const model: Model = {
      async getResponse() {
        markModelFailed();
        throw new ModelRefusalError('refused before guardrail completion');
      },
      async *getStreamedResponse() {
        yield* [];
        throw new Error('Not implemented');
      },
    };
    const agent = new Agent({ name: 'guardrail-before-refusal', model });
    const state = createResumableState(agent);
    state.addInput('guard before fallback');
    const refusalHandler = vi.fn(() => ({ finalOutput: 'fallback' }));
    const runner = new Runner({
      inputGuardrails: [{ name: 'pending-guardrail', execute: guardrail }],
    });
    let runSettled = false;

    const running = runner
      .run(agent, state, {
        errorHandlers: { modelRefusal: refusalHandler },
      })
      .finally(() => {
        runSettled = true;
      });
    await modelFailed;
    await Promise.resolve();

    expect(runSettled).toBe(false);
    expect(refusalHandler).not.toHaveBeenCalled();

    releaseGuardrail();
    await expect(running).rejects.toBeInstanceOf(
      InputGuardrailTripwireTriggered,
    );
    expect(refusalHandler).not.toHaveBeenCalled();
    expect(state.pendingInput).toEqual([message('guard before fallback')]);
    expect(
      state._generatedItems.filter((item) => item instanceof RunInputItem),
    ).toHaveLength(0);
  });

  it('fails closed after a late non-streaming staged-input guardrail failure', async () => {
    let releaseGuardrail!: () => void;
    const guardrailCanFinish = new Promise<void>((resolve) => {
      releaseGuardrail = resolve;
    });
    const execute = vi.fn(async () => 'must not run');
    const guardedTool = tool({
      name: 'guarded_tool',
      description: 'Must not run after a guardrail failure.',
      parameters: z.object({}).strict(),
      execute,
    });
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'guarded_tool',
      callId: 'guarded-call',
      status: 'completed',
      arguments: '{}',
    };
    const model = new RecordingModel([
      {
        output: [functionCall],
        usage: new Usage(),
        responseId: 'guarded-accepted-response',
      },
    ]);
    const agent = new Agent({
      name: 'late-guardrail-accepted-response',
      model,
      tools: [guardedTool],
    });
    const state = createResumableState(agent);
    state.setConversationContext('late-guardrail-conversation');
    state.addInput('guard accepted response');
    const runner = new Runner({
      inputGuardrails: [
        {
          name: 'pending-guardrail',
          execute: async () => {
            await guardrailCanFinish;
            return {
              tripwireTriggered: true,
              outputInfo: { reason: 'reject accepted response' },
            };
          },
        },
      ],
    });

    const running = runner.run(agent, state, {
      conversationId: 'late-guardrail-conversation',
    });
    await vi.waitFor(() => {
      expect(state._lastProcessedResponse).toBeDefined();
    });
    releaseGuardrail();

    await expect(running).rejects.toBeInstanceOf(
      InputGuardrailTripwireTriggered,
    );
    expect(state.pendingInput).toEqual([]);
    expect(state._lastProcessedResponse).toBeUndefined();
    expect(state._currentStep).toMatchObject({
      type: 'next_step_interruption',
      data: { responseAccepted: true },
    });

    const restored = await RunState.fromString(agent, state.toString());
    await expect(
      runner.run(agent, restored, {
        conversationId: 'late-guardrail-conversation',
      }),
    ).rejects.toThrow(/accepted model response could not be processed/i);
    expect(model.requests).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('persists local admission once before a failed model request', async () => {
    const model = new FailOnceModel({
      output: [fakeModelMessage('done')],
      usage: new Usage(),
    });
    const agent = new Agent({ name: 'local-failure', model });
    const state = createResumableState(agent);
    state.addInput('durable local input');
    const session = new MemorySession();
    const runner = new Runner();

    await expect(runner.run(agent, state, { session })).rejects.toThrow(
      'model request failed',
    );
    expect(state.pendingInput).toEqual([]);
    expect(
      state._generatedItems.filter((item) => item instanceof RunInputItem),
    ).toHaveLength(1);
    expect(await session.getItems()).toEqual([message('durable local input')]);

    const completed = await runner.run(agent, state, { session });
    expect(completed.finalOutput).toBe('done');
    expect(await session.getItems()).toEqual([
      message('durable local input'),
      fakeModelMessage('done'),
    ]);
    const retryInput = model.requests[1]?.input as AgentInputItem[];
    expect(
      retryInput.filter(
        (item) =>
          item.type === 'message' && item.content === 'durable local input',
      ),
    ).toHaveLength(1);
  });

  it.each([
    { label: 'non-streaming', stream: false },
    { label: 'streaming', stream: true },
  ])(
    'retries a failed local admission write before the $label model request',
    async ({ stream }) => {
      const session = new FailOnceSession();
      let modelCalls = 0;
      const response: ModelResponse = {
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      };
      const model: Model = {
        async getResponse() {
          modelCalls += 1;
          expect(session.addAttempts).toBe(2);
          return response;
        },
        async *getStreamedResponse() {
          modelCalls += 1;
          expect(session.addAttempts).toBe(2);
          yield {
            type: 'response_done',
            response: {
              id: 'response-local-session-retry',
              usage: {
                requests: response.usage.requests,
                inputTokens: response.usage.inputTokens,
                outputTokens: response.usage.outputTokens,
                totalTokens: response.usage.totalTokens,
              },
              output: response.output,
            },
          } as protocol.StreamEvent;
        },
      };
      const agent = new Agent({ name: 'local-session-retry', model });
      const state = createResumableState(agent);
      state.addInput('retry durable input');
      const runner = new Runner();

      if (stream) {
        const failed = await runner.run(agent, state, {
          session,
          stream: true,
        });
        await expect(failed.completed).rejects.toThrow('session write failed');
      } else {
        await expect(runner.run(agent, state, { session })).rejects.toThrow(
          'session write failed',
        );
      }

      expect(modelCalls).toBe(0);
      expect(session.addAttempts).toBe(1);
      expect(state.pendingInput).toEqual([]);
      expect(
        state._generatedItems.filter((item) => item instanceof RunInputItem),
      ).toHaveLength(1);

      if (stream) {
        const completed = await runner.run(agent, state, {
          session,
          stream: true,
        });
        await completed.completed;
        expect(completed.finalOutput).toBe('done');
      } else {
        const completed = await runner.run(agent, state, { session });
        expect(completed.finalOutput).toBe('done');
      }

      expect(modelCalls).toBe(1);
      expect(await session.getItems()).toEqual([
        message('retry durable input'),
        fakeModelMessage('done'),
      ]);
    },
  );

  it('keeps server-managed input pending until a response is accepted', async () => {
    const model = new FailOnceModel({
      output: [fakeModelMessage('done')],
      usage: new Usage(),
      responseId: 'response-1',
    });
    const agent = new Agent({ name: 'server-failure', model });
    const state = createResumableState(agent);
    state.setConversationContext('conversation-1');
    state.addInput('durable server input');
    const runner = new Runner();

    await expect(
      runner.run(agent, state, { conversationId: 'conversation-1' }),
    ).rejects.toThrow('model request failed');
    expect(state.pendingInput).toEqual([message('durable server input')]);
    expect(
      state._generatedItems.filter((item) => item instanceof RunInputItem),
    ).toHaveLength(0);

    const completed = await runner.run(agent, state, {
      conversationId: 'conversation-1',
    });
    expect(completed.finalOutput).toBe('done');
    expect(state.pendingInput).toEqual([]);
    expect(
      state._generatedItems.filter((item) => item instanceof RunInputItem),
    ).toHaveLength(1);
  });

  it.each([
    {
      label: 'unsafe replay',
      advice: { replaySafety: 'unsafe' as const },
      conversationId: 'unsafe-failure-conversation',
      previousResponseId: undefined,
    },
    {
      label: 'response-start evidence',
      advice: { responseStarted: true },
      conversationId: undefined,
      previousResponseId: 'response-started-previous',
    },
  ])(
    'fails closed after a server-managed request reports $label',
    async ({ advice, conversationId, previousResponseId }) => {
      let modelCalls = 0;
      const model: Model = {
        async getResponse() {
          modelCalls += 1;
          throw new Error('request may have been accepted');
        },
        getRetryAdvice() {
          return { suggested: false, ...advice };
        },
        async *getStreamedResponse() {
          yield* [];
          throw new Error('Not implemented');
        },
      };
      const agent = new Agent({ name: 'unsafe-server-failure', model });
      const state = createResumableState(agent);
      state.setConversationContext(conversationId, previousResponseId);
      state.addInput('accepted without a response');
      const options = { conversationId, previousResponseId };

      await expect(run(agent, state, options)).rejects.toThrow(
        'request may have been accepted',
      );
      expect(state.pendingInput).toEqual([]);
      expect(
        state._generatedItems.filter((item) => item instanceof RunInputItem),
      ).toHaveLength(1);
      expect(state._currentStep).toMatchObject({
        type: 'next_step_interruption',
        data: { responseAccepted: true },
      });

      const restored = await RunState.fromString(agent, state.toString());
      await expect(run(agent, restored, options)).rejects.toThrow(
        /accepted model response could not be processed/i,
      );
      expect(modelCalls).toBe(1);
    },
  );

  it('keeps server-managed input replayable when the application approves an unsafe retry', async () => {
    let modelCalls = 0;
    const model: Model = {
      async getResponse() {
        modelCalls += 1;
        if (modelCalls === 1) {
          throw new Error('request may have been accepted');
        }
        return {
          output: [fakeModelMessage('done')],
          usage: new Usage(),
          responseId: 'approved-retry-response',
        };
      },
      getRetryAdvice() {
        return {
          suggested: false,
          replaySafety: 'unsafe',
          responseStarted: true,
        };
      },
      async *getStreamedResponse() {
        yield* [];
        throw new Error('Not implemented');
      },
    };
    const agent = new Agent({
      name: 'approved-unsafe-server-retry',
      model,
      modelSettings: {
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: () => ({ retry: true, approveUnsafeReplay: true }),
        },
      },
    });
    const state = createResumableState(agent);
    state.setConversationContext('approved-retry-conversation');
    state.addInput('approved replay occurrence');

    const result = await run(agent, state, {
      conversationId: 'approved-retry-conversation',
    });

    expect(result.finalOutput).toBe('done');
    expect(modelCalls).toBe(2);
    expect(state.pendingInput).toEqual([]);
    expect(
      state._generatedItems.filter((item) => item instanceof RunInputItem),
    ).toHaveLength(1);
  });

  it('fails closed when an approved unsafe retry is aborted before the next attempt', async () => {
    const controller = new AbortController();
    let modelCalls = 0;
    const model: Model = {
      async getResponse() {
        modelCalls += 1;
        throw new Error('request may have been accepted');
      },
      getRetryAdvice() {
        return {
          suggested: false,
          replaySafety: 'unsafe',
          responseStarted: true,
        };
      },
      async *getStreamedResponse() {
        yield* [];
        throw new Error('Not implemented');
      },
    };
    const agent = new Agent({
      name: 'aborted-approved-unsafe-server-retry',
      model,
      modelSettings: {
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 100, jitter: false },
          policy: () => {
            queueMicrotask(() => controller.abort());
            return { retry: true, approveUnsafeReplay: true };
          },
        },
      },
    });
    const state = createResumableState(agent);
    state.setConversationContext('aborted-approved-retry-conversation');
    state.addInput('possibly accepted before abort');

    await expect(
      run(agent, state, {
        conversationId: 'aborted-approved-retry-conversation',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(modelCalls).toBe(1);
    expect(state.pendingInput).toEqual([]);
    expect(
      state._generatedItems.filter((item) => item instanceof RunInputItem),
    ).toHaveLength(1);
    expect(state._currentStep).toMatchObject({
      type: 'next_step_interruption',
      data: { responseAccepted: true },
    });

    const restored = await RunState.fromString(agent, state.toString());
    await expect(
      run(agent, restored, {
        conversationId: 'aborted-approved-retry-conversation',
      }),
    ).rejects.toThrow(/accepted model response could not be processed/i);
    expect(modelCalls).toBe(1);
  });

  it('preserves input appended while a server-managed request is in flight', async () => {
    let markFirstRequestStarted!: () => void;
    let releaseFirstRequest!: () => void;
    const firstRequestStarted = new Promise<void>((resolve) => {
      markFirstRequestStarted = resolve;
    });
    const firstRequestCanFinish = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'continue_turn',
      callId: 'continue-turn-call',
      status: 'completed',
      arguments: '{}',
    };
    const requests: ModelRequest[] = [];
    const model: Model = {
      async getResponse(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          markFirstRequestStarted();
          await firstRequestCanFinish;
          return {
            output: [functionCall],
            usage: new Usage(),
            responseId: 'append-first-response',
          };
        }
        return {
          output: [fakeModelMessage('done')],
          usage: new Usage(),
          responseId: 'append-second-response',
        };
      },
      async *getStreamedResponse() {
        yield* [];
        throw new Error('Not implemented');
      },
    };
    const continueTurn = tool({
      name: 'continue_turn',
      description: 'Continues the current run.',
      parameters: z.object({}).strict(),
      execute: async () => 'continued',
    });
    const agent = new Agent({
      name: 'append-during-admission',
      model,
      tools: [continueTurn],
    });
    const state = createResumableState(agent, 4);
    state.setConversationContext('append-during-admission-conversation');
    state.addInput('first occurrence');

    const running = run(agent, state, {
      conversationId: 'append-during-admission-conversation',
    });
    await firstRequestStarted;
    state.addInput('second occurrence');
    releaseFirstRequest();
    const result = await running;

    expect(result.finalOutput).toBe('done');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.input).toContainEqual(message('first occurrence'));
    expect(requests[0]?.input).not.toContainEqual(message('second occurrence'));
    expect(requests[1]?.input).toContainEqual(message('second occurrence'));
    expect(state.pendingInput).toEqual([]);
    expect(
      state._generatedItems.filter((item) => item instanceof RunInputItem),
    ).toHaveLength(2);
  });

  it('commits previous-response input only after successful acceptance', async () => {
    const model = new RecordingModel([
      {
        output: [fakeModelMessage('done')],
        usage: new Usage(),
        responseId: 'response-next',
      },
    ]);
    const agent = new Agent({ name: 'previous-response-input', model });
    const state = createResumableState(agent);
    state.setConversationContext(undefined, 'response-previous');
    state.addInput('previous response delta');
    const session = new MemorySession();

    const completed = await run(agent, state, {
      previousResponseId: 'response-previous',
      session,
    });

    expect(completed.finalOutput).toBe('done');
    expect(model.requests[0]?.previousResponseId).toBe('response-previous');
    expect(state._previousResponseId).toBe('response-next');
    expect(state.pendingInput).toEqual([]);
    expect(
      state._generatedItems.filter((item) => item instanceof RunInputItem),
    ).toHaveLength(1);
    expect(await session.getItems()).toEqual([]);
  });

  it('admits staged input once on a streaming resume', async () => {
    const model = new RecordingStreamModel([
      {
        output: [fakeModelMessage('streamed')],
        usage: new Usage(),
        responseId: 'stream-response',
      },
    ]);
    const agent = new Agent({ name: 'streaming-pending-input', model });
    const state = createResumableState(agent);
    state.addInput('streamed input');

    const completed = await run(agent, state, { stream: true });
    await completed.completed;

    expect(completed.finalOutput).toBe('streamed');
    expect(state.pendingInput).toEqual([]);
    expect(
      (model.requests[0]?.input as AgentInputItem[]).filter(
        (item) => item.type === 'message' && item.content === 'streamed input',
      ),
    ).toHaveLength(1);
    expect(
      state._generatedItems.filter((item) => item instanceof RunInputItem),
    ).toHaveLength(1);
  });

  it('distinguishes an identical staged occurrence after state restoration', async () => {
    const model = new RecordingModel([
      {
        output: [fakeModelMessage('done')],
        usage: new Usage(),
        responseId: 'response-next',
      },
    ]);
    const agent = new Agent({ name: 'identical-occurrence', model });
    const state = createResumableState(agent);
    state._generatedItems.push(
      new RunInputItem(message('Repeat'), agent, 'first-occurrence'),
    );
    state._modelResponses.push({
      output: [],
      usage: new Usage(),
      responseId: 'response-previous',
    });
    state.setConversationContext(undefined, 'response-previous');
    const restored = await RunState.fromString(agent, state.toString());
    restored.addInput('Repeat');

    const completed = await run(agent, restored, {
      previousResponseId: 'response-previous',
    });

    expect(completed.finalOutput).toBe('done');
    expect(
      (model.requests[0]?.input as AgentInputItem[]).filter(
        (item) => item.type === 'message' && item.content === 'Repeat',
      ),
    ).toHaveLength(1);
    const admitted = restored._generatedItems.filter(
      (item): item is RunInputItem => item instanceof RunInputItem,
    );
    expect(admitted).toHaveLength(2);
    expect(new Set(admitted.map((item) => item.inputId)).size).toBe(2);
  });

  it.each([
    { label: 'conversationId non-streaming', stream: false },
    { label: 'previousResponseId streaming', stream: true },
  ])(
    'does not resend accepted input on an immediate $label continuation',
    async ({ label, stream }) => {
      const execute = vi.fn(async () => 'tool result');
      const continuationTool = tool({
        name: 'continuation_tool',
        description: 'Continues to another model turn.',
        parameters: z.object({}).strict(),
        execute,
      });
      const functionCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: 'continuation_tool',
        callId: `continuation-${label}`,
        status: 'completed',
        arguments: '{}',
      };
      const responses: ModelResponse[] = [
        {
          output: [functionCall],
          usage: new Usage(),
          responseId: `first-${label}`,
        },
        {
          output: [fakeModelMessage('done')],
          usage: new Usage(),
          responseId: `second-${label}`,
        },
      ];
      const model = stream
        ? new RecordingStreamModel(responses)
        : new RecordingModel(responses);
      const agent = new Agent({
        name: `immediate-continuation-${label}`,
        model,
        tools: [continuationTool],
      });
      const state = createResumableState(agent, 4);
      const serverOptions = stream
        ? { previousResponseId: 'response-previous' }
        : { conversationId: 'conversation-immediate' };
      if (stream) {
        state._modelResponses.push({
          output: [],
          usage: new Usage(),
          responseId: 'response-previous',
        });
        state.setConversationContext(undefined, 'response-previous');
      } else {
        state.setConversationContext('conversation-immediate');
      }
      state.addInput('accepted once');

      let finalOutput: string | undefined;
      if (stream) {
        const streamed = await run(agent, state, {
          ...serverOptions,
          stream: true,
        });
        await streamed.completed;
        finalOutput = streamed.finalOutput;
      } else {
        finalOutput = (await run(agent, state, serverOptions)).finalOutput;
      }

      expect(finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);
      expect(
        (model.requests[0]?.input as AgentInputItem[]).filter(
          (item) => item.type === 'message' && item.content === 'accepted once',
        ),
      ).toHaveLength(1);
      expect(
        (model.requests[1]?.input as AgentInputItem[]).filter(
          (item) => item.type === 'message' && item.content === 'accepted once',
        ),
      ).toHaveLength(0);
      expect(
        state._generatedItems.filter((item) => item instanceof RunInputItem),
      ).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps omitted input pending and commits an in-place rewrite', async () => {
    const omittedModel = new RecordingModel([
      { output: [fakeModelMessage('omitted')], usage: new Usage() },
    ]);
    const omittedAgent = new Agent({
      name: 'omitted-input',
      model: omittedModel,
    });
    const omittedState = createResumableState(omittedAgent);
    omittedState.addInput('omit me');
    await run(omittedAgent, omittedState, {
      callModelInputFilter: ({ modelData }) => ({
        ...modelData,
        input: modelData.input.filter(
          (item) => item.type !== 'message' || item.content !== 'omit me',
        ),
      }),
    });
    expect(omittedState.pendingInput).toEqual([message('omit me')]);
    expect(
      omittedState._generatedItems.filter(
        (item) => item instanceof RunInputItem,
      ),
    ).toHaveLength(0);

    const rewrittenModel = new RecordingModel([
      { output: [fakeModelMessage('rewritten')], usage: new Usage() },
    ]);
    const rewrittenAgent = new Agent({
      name: 'rewritten-input',
      model: rewrittenModel,
    });
    const rewrittenState = createResumableState(rewrittenAgent);
    rewrittenState.addInput('rewrite me');
    await run(rewrittenAgent, rewrittenState, {
      callModelInputFilter: ({ modelData }) => {
        const pending = modelData.input.find(
          (item) => item.type === 'message' && item.content === 'rewrite me',
        );
        if (pending?.type === 'message') {
          pending.content = 'rewritten input';
        }
        return modelData;
      },
    });
    const admitted = rewrittenState._generatedItems.find(
      (item): item is RunInputItem => item instanceof RunInputItem,
    );
    expect(admitted?.rawItem).toEqual(message('rewritten input'));
    expect(rewrittenState.pendingInput).toEqual([]);
  });

  it('rejects an ambiguous reconstructed filter item before model invocation', async () => {
    const model = new RecordingModel([
      { output: [fakeModelMessage('unused')], usage: new Usage() },
    ]);
    const agent = new Agent({ name: 'ambiguous-filter', model });
    const state = createResumableState(agent);
    state._originalInput = 'same';
    state.addInput('same');
    const beforeTurn = state._currentTurn;
    const beforeStep = structuredClone(state._currentStep);

    await expect(
      run(agent, state, {
        callModelInputFilter: ({ modelData }) => ({
          ...modelData,
          input: [message('same')],
        }),
      }),
    ).rejects.toThrow(/cannot safely associate a reconstructed item/);
    expect(model.requests).toHaveLength(0);
    expect(state.pendingInput).toEqual([message('same')]);
    expect(state._generatedItems).toHaveLength(0);
    expect(state._currentTurn).toBe(beforeTurn);
    expect(state._currentStep).toEqual(beforeStep);
  });

  it('fails closed after accepted response validation fails', async () => {
    const execute = vi.fn(async () => 'should not run');
    const strictTool = tool({
      name: 'strict_tool',
      description: 'Requires a string value.',
      parameters: z.object({ value: z.string() }).strict(),
      execute,
      errorFunction: null,
    });
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'strict_tool',
      callId: 'strict-call',
      status: 'completed',
      arguments: '{"value":1}',
    };
    const model = new RecordingModel([
      { output: [functionCall], usage: new Usage(), responseId: 'accepted-1' },
    ]);
    const agent = new Agent({
      name: 'accepted-validation-failure',
      model,
      tools: [strictTool],
    });
    const state = createResumableState(agent);
    state.setConversationContext('accepted-validation-conversation');
    state.addInput('accepted once');
    const runner = new Runner();

    await expect(
      runner.run(agent, state, {
        conversationId: 'accepted-validation-conversation',
      }),
    ).rejects.toThrow();
    expect(model.requests).toHaveLength(1);
    expect(state._currentStep).toMatchObject({
      type: 'next_step_interruption',
      data: { responseAccepted: true, localProcessingStarted: true },
    });

    await expect(
      runner.run(agent, state, {
        conversationId: 'accepted-validation-conversation',
      }),
    ).rejects.toThrow(/unfinished local tool work/);
    expect(model.requests).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(0);
  });

  it.each([
    { label: 'non-streaming', stream: false },
    { label: 'streaming', stream: true },
  ])(
    'checkpoints an accepted $label response when filtering omits pending input',
    async ({ stream }) => {
      const execute = vi.fn(async () => 'should not run');
      const strictTool = tool({
        name: 'strict_tool',
        description: 'Requires a string value.',
        parameters: z.object({ value: z.string() }).strict(),
        execute,
        errorFunction: null,
      });
      const functionCall: protocol.FunctionCallItem = {
        type: 'function_call',
        name: 'strict_tool',
        callId: 'filtered-strict-call',
        status: 'completed',
        arguments: '{"value":1}',
      };
      const response = {
        output: [functionCall],
        usage: new Usage(),
        responseId: 'filtered-accepted-response',
      };
      const model = stream
        ? new RecordingStreamModel([response])
        : new RecordingModel([response]);
      const agent = new Agent({
        name: 'filtered-accepted-validation-failure',
        model,
        tools: [strictTool],
      });
      const state = createResumableState(agent);
      state.setConversationContext('filtered-accepted-conversation');
      state.addInput('omit this occurrence');
      const options = {
        conversationId: 'filtered-accepted-conversation',
        callModelInputFilter: ({
          modelData,
        }: {
          modelData: { input: AgentInputItem[]; instructions?: string };
        }) => ({
          ...modelData,
          input: modelData.input.filter(
            (item: AgentInputItem) =>
              !(
                item.type === 'message' &&
                item.role === 'user' &&
                item.content === 'omit this occurrence'
              ),
          ),
        }),
      };

      if (stream) {
        const failed = await new Runner().run(agent, state, {
          ...options,
          stream: true,
        });
        await expect(failed.completed).rejects.toThrow();
      } else {
        await expect(new Runner().run(agent, state, options)).rejects.toThrow();
      }

      expect(model.requests).toHaveLength(1);
      expect(state.pendingInput).toEqual([message('omit this occurrence')]);
      expect(state._currentStep).toMatchObject({
        type: 'next_step_interruption',
        data: { responseAccepted: true, localProcessingStarted: true },
      });
      const restored = await RunState.fromString(agent, state.toString());

      if (stream) {
        const retried = await new Runner().run(agent, restored, {
          ...options,
          stream: true,
        });
        await expect(retried.completed).rejects.toThrow(
          /unfinished local tool work/,
        );
      } else {
        await expect(
          new Runner().run(agent, restored, options),
        ).rejects.toThrow(/unfinished local tool work/);
      }
      expect(model.requests).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(0);
    },
  );

  it.each([
    { label: 'non-streaming', stream: false },
    { label: 'streaming', stream: true },
  ])(
    'fails closed after accepted $label structured-output validation fails',
    async ({ stream }) => {
      let validationCalls = 0;
      const outputType = z.object({
        value: z.string().refine(() => {
          validationCalls += 1;
          return false;
        }, 'validation failed after side effect'),
      });
      const response = {
        output: [fakeModelMessage('{"value":"invalid"}')],
        usage: new Usage(),
        responseId: 'accepted-structured-response',
      };
      const model = stream
        ? new RecordingStreamModel([response])
        : new RecordingModel([response]);
      const agent = new Agent({
        name: 'accepted-structured-validation',
        model,
        outputType,
      });
      const state = createResumableState(agent);
      state.setConversationContext('accepted-structured-conversation');
      state.addInput('validate once');
      const options = {
        conversationId: 'accepted-structured-conversation',
      };

      if (stream) {
        const failed = await new Runner().run(agent, state, {
          ...options,
          stream: true,
        });
        await expect(failed.completed).rejects.toThrow(/Invalid output type/);
      } else {
        await expect(new Runner().run(agent, state, options)).rejects.toThrow(
          /Invalid output type/,
        );
      }

      expect(validationCalls).toBe(1);
      expect(model.requests).toHaveLength(1);
      expect(state._lastProcessedResponse).toBeUndefined();
      const restored = await RunState.fromString(agent, state.toString());

      if (stream) {
        const retried = await new Runner().run(agent, restored, {
          ...options,
          stream: true,
        });
        await expect(retried.completed).rejects.toThrow(
          /accepted model response could not be processed/,
        );
      } else {
        await expect(
          new Runner().run(agent, restored, options),
        ).rejects.toThrow(/accepted model response could not be processed/);
      }
      expect(validationCalls).toBe(1);
      expect(model.requests).toHaveLength(1);
    },
  );

  it('rejects accepted response authority without server ownership', async () => {
    const model = new RecordingModel([
      { output: [fakeModelMessage('must not run')], usage: new Usage() },
    ]);
    const agent = new Agent({ name: 'unowned-accepted-response', model });
    const state = createResumableState(agent);
    state._currentStep = {
      type: 'next_step_interruption',
      data: { interruptions: [], responseAccepted: true },
    };
    state._lastTurnResponse = {
      output: [fakeModelMessage('stored')],
      usage: new Usage(),
    };
    state._modelResponses.push(state._lastTurnResponse);
    state._lastProcessedResponse = {
      newItems: [],
      handoffs: [],
      functions: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun: () => false,
    };

    await expect(new Runner().run(agent, state)).rejects.toThrow(
      /requires exactly one server-managed conversation owner/,
    );
    expect(model.requests).toHaveLength(0);
    await expect(RunState.fromString(agent, state.toString())).rejects.toThrow(
      /requires exactly one server-managed conversation owner/,
    );

    for (const ownership of [
      { conversationId: 'conversation-owned' },
      { previousResponseId: 'response-owned' },
    ]) {
      const ownedState = createResumableState(agent);
      ownedState._currentStep = structuredClone(state._currentStep);
      ownedState._lastTurnResponse = state._lastTurnResponse;
      ownedState._modelResponses.push(state._lastTurnResponse);
      ownedState._lastProcessedResponse = state._lastProcessedResponse;
      ownedState.setConversationContext(
        ownership.conversationId,
        ownership.previousResponseId,
      );
      await expect(
        RunState.fromString(agent, ownedState.toString()),
      ).resolves.toBeInstanceOf(RunState);
    }

    const dualOwner = createResumableState(agent);
    dualOwner._currentStep = structuredClone(state._currentStep);
    dualOwner._lastTurnResponse = state._lastTurnResponse;
    dualOwner._modelResponses.push(state._lastTurnResponse);
    dualOwner._lastProcessedResponse = state._lastProcessedResponse;
    dualOwner.setConversationContext('conversation-owned', 'response-owned');
    await expect(
      RunState.fromString(agent, dualOwner.toString()),
    ).rejects.toThrow(/exactly one server-managed conversation owner/);

    for (const ownership of [
      { conversationId: '', previousResponseId: 'response-owned' },
      { conversationId: 'conversation-owned', previousResponseId: '' },
    ]) {
      const emptySecondOwner = createResumableState(agent);
      emptySecondOwner._currentStep = structuredClone(state._currentStep);
      emptySecondOwner._lastTurnResponse = state._lastTurnResponse;
      emptySecondOwner._modelResponses.push(state._lastTurnResponse);
      emptySecondOwner._lastProcessedResponse = state._lastProcessedResponse;
      emptySecondOwner.setConversationContext(
        ownership.conversationId,
        ownership.previousResponseId,
      );
      const before = emptySecondOwner.toString();

      await expect(RunState.fromString(agent, before)).rejects.toThrow(
        /exactly one server-managed conversation owner/,
      );
      await expect(new Runner().run(agent, emptySecondOwner)).rejects.toThrow(
        /exactly one server-managed conversation owner/,
      );
      expect(model.requests).toHaveLength(0);
      expect(emptySecondOwner.toString()).toBe(before);
    }
  });

  it.each([
    {
      label: 'non-streaming conversation value',
      stream: false,
      stored: { conversationId: 'conversation-a' },
      requested: { conversationId: 'conversation-b' },
    },
    {
      label: 'streaming previous-response value',
      stream: true,
      stored: { previousResponseId: 'response-a' },
      requested: { previousResponseId: 'response-b' },
    },
    {
      label: 'non-streaming conversation mode',
      stream: false,
      stored: { conversationId: 'conversation-a' },
      requested: { previousResponseId: 'response-b' },
    },
    {
      label: 'streaming previous-response mode',
      stream: true,
      stored: { previousResponseId: 'response-a' },
      requested: { conversationId: 'conversation-b' },
    },
  ])(
    'rejects an accepted checkpoint with mismatched $label authority before mutation',
    async ({ stream, stored, requested }) => {
      const model = stream
        ? new RecordingStreamModel([
            { output: [fakeModelMessage('must not run')], usage: new Usage() },
          ])
        : new RecordingModel([
            { output: [fakeModelMessage('must not run')], usage: new Usage() },
          ]);
      const agent = new Agent({ name: 'mismatched-accepted-owner', model });
      const state = createResumableState(agent);
      state._currentStep = {
        type: 'next_step_interruption',
        data: { interruptions: [], responseAccepted: true },
      };
      state.setConversationContext(
        stored.conversationId,
        stored.previousResponseId,
      );
      const before = state.toString();

      if (stream) {
        await expect(
          new Runner().run(agent, state, { ...requested, stream: true }),
        ).rejects.toThrow(
          /cannot change its server-managed conversation owner/,
        );
      } else {
        await expect(new Runner().run(agent, state, requested)).rejects.toThrow(
          /cannot change its server-managed conversation owner/,
        );
      }
      expect(model.requests).toHaveLength(0);
      expect(state.toString()).toBe(before);
    },
  );

  it.each([
    {
      label: 'non-streaming dual owner',
      stream: false,
      conversationId: 'conversation-a',
      previousResponseId: 'response-a',
    },
    {
      label: 'streaming dual owner',
      stream: true,
      conversationId: 'conversation-a',
      previousResponseId: 'response-a',
    },
    {
      label: 'non-streaming empty conversation owner',
      stream: false,
      conversationId: '',
      previousResponseId: 'response-a',
    },
    {
      label: 'streaming empty previous-response owner',
      stream: true,
      conversationId: 'conversation-a',
      previousResponseId: '',
    },
  ])(
    'rejects $label before pending-input request publication',
    async ({ stream, conversationId, previousResponseId }) => {
      const model = stream
        ? new RecordingStreamModel([
            { output: [fakeModelMessage('must not run')], usage: new Usage() },
          ])
        : new RecordingModel([
            { output: [fakeModelMessage('must not run')], usage: new Usage() },
          ]);
      const agent = new Agent({ name: 'invalid-pending-owner', model });
      const state = createResumableState(agent);
      state.setConversationContext(conversationId, previousResponseId);
      state.addInput('must remain pending');
      const before = state.toString();
      const options = { conversationId, previousResponseId };

      if (stream) {
        const failed = await new Runner().run(agent, state, {
          ...options,
          stream: true,
        });
        await expect(failed.completed).rejects.toThrow(
          /requires exactly one server-managed conversation owner/,
        );
      } else {
        await expect(new Runner().run(agent, state, options)).rejects.toThrow(
          /requires exactly one server-managed conversation owner/,
        );
      }

      expect(model.requests).toHaveLength(0);
      expect(state.toString()).toBe(before);
    },
  );

  it.each([
    { label: 'non-streaming', stream: false },
    { label: 'streaming', stream: true },
  ])(
    'does not replay accepted $label finalization after a callback failure',
    async ({ stream }) => {
      const response = {
        output: [fakeModelMessage('done')],
        usage: new Usage(),
        responseId: 'accepted-final-response',
      };
      const model = stream
        ? new RecordingStreamModel([response])
        : new RecordingModel([response]);
      const agent = new Agent({ name: 'accepted-finalization', model });
      const state = createResumableState(agent);
      state.setConversationContext('accepted-final-conversation');
      state.addInput('accepted final input');
      const runner = new Runner();
      let callbackCalls = 0;
      runner.on('agent_end', () => {
        callbackCalls += 1;
        throw new Error('agent end failed');
      });

      if (stream) {
        const failed = await runner.run(agent, state, {
          conversationId: 'accepted-final-conversation',
          stream: true,
        });
        await expect(failed.completed).rejects.toThrow('agent end failed');
      } else {
        await expect(
          runner.run(agent, state, {
            conversationId: 'accepted-final-conversation',
          }),
        ).rejects.toThrow('agent end failed');
      }

      expect(callbackCalls).toBe(1);
      expect(model.requests).toHaveLength(1);
      expect(state._currentStep).toMatchObject({
        type: 'next_step_final_output',
        responseAccepted: true,
        localFinalizationStarted: true,
      });
      const restored = await RunState.fromString(agent, state.toString());

      if (stream) {
        const retried = await runner.run(agent, restored, {
          conversationId: 'accepted-final-conversation',
          stream: true,
        });
        await expect(retried.completed).rejects.toThrow(
          /unfinished local finalization/,
        );
      } else {
        await expect(
          runner.run(agent, restored, {
            conversationId: 'accepted-final-conversation',
          }),
        ).rejects.toThrow(/unfinished local finalization/);
      }
      expect(callbackCalls).toBe(1);
      expect(model.requests).toHaveLength(1);
    },
  );

  it('scopes error-handler attempt tracking to one run invocation', async () => {
    const errorStateAgent = new Agent({ name: 'shared-error-state' });
    const sharedError = new ModelRefusalError(
      'shared refusal',
      createResumableState(errorStateAgent),
    );
    const model: Model = {
      async getResponse() {
        throw sharedError;
      },
      async *getStreamedResponse() {
        yield* [];
        throw new Error('Not implemented');
      },
    };
    const agent = new Agent({ name: 'shared-refusal-error', model });
    let handlerCalls = 0;
    const options = {
      errorHandlers: {
        modelRefusal: () => {
          handlerCalls += 1;
          return { finalOutput: 'handled' };
        },
      },
    };

    const first = await new Runner().run(
      agent,
      createResumableState(agent),
      options,
    );
    const second = await new Runner().run(
      agent,
      createResumableState(agent),
      options,
    );

    expect(first.finalOutput).toBe('handled');
    expect(second.finalOutput).toBe('handled');
    expect(handlerCalls).toBe(2);
  });

  it.each([
    { label: 'non-streaming', stream: false },
    { label: 'streaming', stream: true },
  ])(
    'does not replay accepted $label error-handler finalization after a callback failure',
    async ({ stream }) => {
      const response = {
        output: [fakeModelRefusal('refused')],
        usage: new Usage(),
        responseId: 'accepted-refusal-response',
      };
      const model = stream
        ? new RecordingStreamModel([response])
        : new RecordingModel([response]);
      const agent = new Agent({ name: 'accepted-error-handler', model });
      const state = createResumableState(agent);
      state.setConversationContext('accepted-error-handler-conversation');
      state.addInput('accepted error-handler input');
      const runner = new Runner();
      let callbackCalls = 0;
      runner.on('agent_end', () => {
        callbackCalls += 1;
        throw new Error('error-handler agent end failed');
      });
      const options = {
        conversationId: 'accepted-error-handler-conversation',
        errorHandlers: {
          modelRefusal: () => ({ finalOutput: 'safe fallback' }),
        },
      };

      if (stream) {
        const failed = await runner.run(agent, state, {
          ...options,
          stream: true,
        });
        await expect(failed.completed).rejects.toThrow(
          'error-handler agent end failed',
        );
      } else {
        await expect(runner.run(agent, state, options)).rejects.toThrow(
          'error-handler agent end failed',
        );
      }

      expect(callbackCalls).toBe(1);
      expect(model.requests).toHaveLength(1);
      expect(state._currentStep).toMatchObject({
        type: 'next_step_final_output',
        responseAccepted: true,
        localFinalizationStarted: true,
      });
      const restored = await RunState.fromString(agent, state.toString());

      if (stream) {
        const retried = await runner.run(agent, restored, {
          ...options,
          stream: true,
        });
        await expect(retried.completed).rejects.toThrow(
          /unfinished local finalization/,
        );
      } else {
        await expect(runner.run(agent, restored, options)).rejects.toThrow(
          /unfinished local finalization/,
        );
      }
      expect(callbackCalls).toBe(1);
      expect(model.requests).toHaveLength(1);
    },
  );

  it.each([
    { label: 'non-streaming', stream: false },
    { label: 'streaming', stream: true },
  ])(
    'invokes a declining accepted $label error handler only once',
    async ({ stream }) => {
      const response = {
        output: [fakeModelRefusal('refused')],
        usage: new Usage(),
        responseId: 'accepted-declined-handler-response',
      };
      const model = stream
        ? new RecordingStreamModel([response])
        : new RecordingModel([response]);
      const agent = new Agent({ name: 'accepted-declined-handler', model });
      const state = createResumableState(agent);
      state.setConversationContext('accepted-declined-handler-conversation');
      state.addInput('accepted declined-handler input');
      let handlerCalls = 0;
      const options = {
        conversationId: 'accepted-declined-handler-conversation',
        errorHandlers: {
          modelRefusal: () => {
            handlerCalls += 1;
          },
        },
      };

      if (stream) {
        const failed = await new Runner().run(agent, state, {
          ...options,
          stream: true,
        });
        await expect(failed.completed).rejects.toBeInstanceOf(
          ModelRefusalError,
        );
      } else {
        await expect(
          new Runner().run(agent, state, options),
        ).rejects.toBeInstanceOf(ModelRefusalError);
      }

      expect(handlerCalls).toBe(1);
      expect(model.requests).toHaveLength(1);
      expect(state._currentStep).toMatchObject({
        type: 'next_step_interruption',
        data: { responseAccepted: true, localProcessingStarted: true },
      });
      expect(state._lastProcessedResponse).toBeUndefined();
      const restored = await RunState.fromString(agent, state.toString());

      if (stream) {
        const retried = await new Runner().run(agent, restored, {
          ...options,
          stream: true,
        });
        await expect(retried.completed).rejects.toThrow(
          /accepted model response could not be processed/,
        );
      } else {
        await expect(
          new Runner().run(agent, restored, options),
        ).rejects.toThrow(/accepted model response could not be processed/);
      }
      expect(handlerCalls).toBe(1);
      expect(model.requests).toHaveLength(1);
    },
  );

  it.each([
    { label: 'non-streaming', stream: false },
    { label: 'streaming', stream: true },
  ])(
    'does not replay an accepted $label error handler that throws',
    async ({ stream }) => {
      const response = {
        output: [fakeModelRefusal('refused')],
        usage: new Usage(),
        responseId: 'accepted-throwing-handler-response',
      };
      const model = stream
        ? new RecordingStreamModel([response])
        : new RecordingModel([response]);
      const agent = new Agent({ name: 'accepted-throwing-handler', model });
      const state = createResumableState(agent);
      state.setConversationContext('accepted-throwing-handler-conversation');
      state.addInput('accepted throwing-handler input');
      let handlerCalls = 0;
      const options = {
        conversationId: 'accepted-throwing-handler-conversation',
        errorHandlers: {
          modelRefusal: async () => {
            handlerCalls += 1;
            throw new Error('error handler failed after side effect');
          },
        },
      };

      if (stream) {
        const failed = await new Runner().run(agent, state, {
          ...options,
          stream: true,
        });
        await expect(failed.completed).rejects.toThrow(
          'error handler failed after side effect',
        );
      } else {
        await expect(new Runner().run(agent, state, options)).rejects.toThrow(
          'error handler failed after side effect',
        );
      }

      expect(handlerCalls).toBe(1);
      expect(model.requests).toHaveLength(1);
      expect(state._currentStep).toMatchObject({
        type: 'next_step_interruption',
        data: { responseAccepted: true, localProcessingStarted: true },
      });
      expect(state._lastProcessedResponse).toBeUndefined();
      const restored = await RunState.fromString(agent, state.toString());

      if (stream) {
        const retried = await new Runner().run(agent, restored, {
          ...options,
          stream: true,
        });
        await expect(retried.completed).rejects.toThrow(
          /accepted model response could not be processed/,
        );
      } else {
        await expect(
          new Runner().run(agent, restored, options),
        ).rejects.toThrow(/accepted model response could not be processed/);
      }
      expect(handlerCalls).toBe(1);
      expect(model.requests).toHaveLength(1);
    },
  );

  it('does not start a non-streaming model request after cancellation during local persistence', async () => {
    const model = new RecordingModel([
      { output: [fakeModelMessage('must not run')], usage: new Usage() },
    ]);
    const agent = new Agent({ name: 'cancel-local-persistence', model });
    const state = createResumableState(agent);
    state.addInput('persist before cancellation');
    const session = new BlockingSession();
    const controller = new AbortController();

    const running = new Runner().run(agent, state, {
      session,
      signal: controller.signal,
    });
    await session.addStarted;
    controller.abort();
    session.release();

    await expect(running).rejects.toThrow();
    expect(model.requests).toHaveLength(0);
    expect(state.pendingInput).toEqual([]);
    expect(
      state._generatedItems.filter((item) => item instanceof RunInputItem),
    ).toHaveLength(1);
    expect(
      (await session.getItems()).filter(
        (item) =>
          item.type === 'message' &&
          item.content === 'persist before cancellation',
      ),
    ).toHaveLength(1);
  });

  it('does not start a streaming model request after cancellation during local persistence', async () => {
    const model = new NeverCalledStreamModel();
    const agent = new Agent({ name: 'cancel-stream-persistence', model });
    const state = createResumableState(agent);
    state.addInput('persist before stream cancellation');
    const session = new BlockingSession();

    const streamed = await new Runner().run(agent, state, {
      session,
      stream: true,
    });
    const reader = (streamed.toStream() as any).getReader();
    await session.addStarted;
    const cancellation = reader.cancel('cancel during persistence');
    session.release();
    await cancellation;
    await streamed.completed;

    expect(model.streamCalls).toBe(0);
    expect(state.pendingInput).toEqual([]);
    expect(
      state._generatedItems.filter((item) => item instanceof RunInputItem),
    ).toHaveLength(1);
    expect(
      (await session.getItems()).filter(
        (item) =>
          item.type === 'message' &&
          item.content === 'persist before stream cancellation',
      ),
    ).toHaveLength(1);
  });

  it('commits tool output before a failing end hook and does not rerun it', async () => {
    const execute = vi.fn(async () => 'side effect completed');
    const sideEffectTool = tool({
      name: 'side_effect_tool',
      description: 'Runs once.',
      parameters: z.object({}).strict(),
      execute,
    });
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'side_effect_tool',
      callId: 'side-effect-call',
      status: 'completed',
      arguments: '{}',
    };
    const model = new RecordingModel([
      { output: [functionCall], usage: new Usage(), responseId: 'accepted-2' },
      { output: [fakeModelMessage('done')], usage: new Usage() },
    ]);
    const agent = new Agent({
      name: 'tool-end-failure',
      model,
      tools: [sideEffectTool],
    });
    const state = createResumableState(agent);
    state.setConversationContext('tool-end-conversation');
    state.addInput('accepted once');
    const runner = new Runner();
    let failEndHook = true;
    runner.on('agent_tool_end', () => {
      if (failEndHook) {
        failEndHook = false;
        throw new Error('tool end hook failed');
      }
    });

    await expect(
      runner.run(agent, state, {
        conversationId: 'tool-end-conversation',
      }),
    ).rejects.toThrow('tool end hook failed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      state._generatedItems.filter(
        (item) =>
          item.type === 'tool_call_output_item' &&
          item.rawItem.callId === 'side-effect-call',
      ),
    ).toHaveLength(1);

    const restored = await RunState.fromString(agent, state.toString());
    const completed = await runner.run(agent, restored, {
      conversationId: 'tool-end-conversation',
    });
    expect(completed.finalOutput).toBe('done');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.requests).toHaveLength(2);
  });

  it('keeps one local occurrence across an explicitly approved unsafe replay', async () => {
    let attempts = 0;
    const requestInputs: AgentInputItem[][] = [];
    const model: Model = {
      async getResponse(request) {
        attempts += 1;
        requestInputs.push(structuredClone(request.input as AgentInputItem[]));
        if (attempts === 1) {
          throw new Error('request may have been accepted');
        }
        return {
          output: [fakeModelMessage('done')],
          usage: new Usage(),
        };
      },
      getRetryAdvice() {
        return {
          suggested: false,
          replaySafety: 'unsafe',
          responseStarted: true,
        };
      },
      async *getStreamedResponse() {
        yield* [];
        throw new Error('Not implemented');
      },
    };
    const agent = new Agent({
      name: 'unsafe-replay-pending-input',
      model,
      modelSettings: {
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: () => ({ retry: true, approveUnsafeReplay: true }),
        },
      },
    });
    const state = createResumableState(agent);
    state.addInput('logical occurrence');
    const session = new MemorySession();

    const completed = await run(agent, state, { session });

    expect(completed.finalOutput).toBe('done');
    expect(attempts).toBe(2);
    expect(requestInputs[0]).toEqual(requestInputs[1]);
    expect(
      state._generatedItems.filter((item) => item instanceof RunInputItem),
    ).toHaveLength(1);
    expect(
      (await session.getItems()).filter(
        (item) =>
          item.type === 'message' && item.content === 'logical occurrence',
      ),
    ).toHaveLength(1);
  });

  it('fails closed when a server-managed stream was accepted without a final response', async () => {
    const model = new FailingAcceptedStreamModel();
    const agent = new Agent({ name: 'accepted-stream', model });
    const state = createResumableState(agent);
    state.setConversationContext('conversation-stream');
    state._lastTurnResponse = {
      output: [fakeModelMessage('prior response')],
      usage: new Usage(),
      responseId: 'prior-response',
    };
    state._modelResponses.push(state._lastTurnResponse);
    state._lastProcessedResponse = {
      newItems: [],
      handoffs: [],
      functions: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun: () => false,
    };
    state.addInput('stream occurrence');

    const streamed = await run(agent, state, {
      stream: true,
      conversationId: 'conversation-stream',
    });
    await expect(streamed.completed).rejects.toThrow(
      'stream failed after acceptance',
    );
    expect(state.pendingInput).toEqual([]);
    expect(state._currentStep).toMatchObject({
      type: 'next_step_interruption',
      data: { responseAccepted: true },
    });
    expect(state._lastTurnResponse).toBeUndefined();
    expect(state._lastProcessedResponse).toBeUndefined();

    const restored = await RunState.fromString(agent, state.toString());

    await expect(
      run(agent, restored, { conversationId: 'conversation-stream' }),
    ).rejects.toThrow(/accepted model response could not be processed/i);
    expect(model.streamCalls).toBe(1);
  });

  it.each([
    {
      label: 'unsafe replay',
      advice: { replaySafety: 'unsafe' as const },
      conversationId: 'unsafe-stream-conversation',
      previousResponseId: undefined,
    },
    {
      label: 'response-start evidence',
      advice: { responseStarted: true },
      conversationId: undefined,
      previousResponseId: 'response-started-stream-previous',
    },
  ])(
    'fails closed before the first server-managed stream event after $label',
    async ({ advice, conversationId, previousResponseId }) => {
      let streamCalls = 0;
      const model: Model = {
        async getResponse() {
          throw new Error('Not implemented');
        },
        async *getStreamedResponse() {
          streamCalls += 1;
          yield* [];
          throw new Error('stream request may have been accepted');
        },
        getRetryAdvice() {
          return { suggested: false, ...advice };
        },
      };
      const agent = new Agent({ name: 'unsafe-server-stream', model });
      const state = createResumableState(agent);
      state.setConversationContext(conversationId, previousResponseId);
      state.addInput('accepted streamed occurrence');
      const options = {
        conversationId,
        previousResponseId,
      };

      const streamed = await run(agent, state, { ...options, stream: true });
      await expect(streamed.completed).rejects.toThrow(
        'stream request may have been accepted',
      );
      expect(state.pendingInput).toEqual([]);
      expect(
        state._generatedItems.filter((item) => item instanceof RunInputItem),
      ).toHaveLength(1);
      expect(state._currentStep).toMatchObject({
        type: 'next_step_interruption',
        data: { responseAccepted: true },
      });

      const restored = await RunState.fromString(agent, state.toString());
      await expect(run(agent, restored, options)).rejects.toThrow(
        /accepted model response could not be processed/i,
      );
      expect(streamCalls).toBe(1);
    },
  );

  it('keeps staged input replayable after a provider-safe pre-event stream failure', async () => {
    let streamCalls = 0;
    const model: Model = {
      async getResponse() {
        throw new Error('Not implemented');
      },
      async *getStreamedResponse() {
        streamCalls += 1;
        yield* [];
        throw new Error('safe stream failure');
      },
      getRetryAdvice() {
        return { suggested: false, replaySafety: 'safe' };
      },
    };
    const agent = new Agent({ name: 'safe-server-stream', model });
    const state = createResumableState(agent);
    state.setConversationContext('safe-stream-conversation');
    state.addInput('replayable streamed occurrence');

    const streamed = await run(agent, state, {
      conversationId: 'safe-stream-conversation',
      stream: true,
    });
    await expect(streamed.completed).rejects.toThrow('safe stream failure');
    expect(state.pendingInput).toEqual([
      message('replayable streamed occurrence'),
    ]);
    expect(
      state._generatedItems.filter((item) => item instanceof RunInputItem),
    ).toHaveLength(0);
    expect(streamCalls).toBe(1);
  });

  it('checkpoints server acceptance before surfacing a parallel staged-input guardrail failure', async () => {
    let releaseFirstEvent!: () => void;
    let markModelStarted!: () => void;
    const firstEventCanArrive = new Promise<void>((resolve) => {
      releaseFirstEvent = resolve;
    });
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve;
    });
    let streamCalls = 0;
    const model: Model = {
      async getResponse() {
        throw new Error('Not implemented');
      },
      async *getStreamedResponse() {
        streamCalls += 1;
        markModelStarted();
        await firstEventCanArrive;
        yield {
          type: 'output_text_delta',
          delta: 'accepted but guarded',
          providerData: {},
        } as protocol.StreamEvent;
      },
    };
    const agent = new Agent({ name: 'accepted-guardrail-stream', model });
    const state = createResumableState(agent);
    state.setConversationContext('accepted-guardrail-conversation');
    state.addInput('accepted guarded occurrence');
    const guardrail = vi.fn(async () => {
      await modelStarted;
      return {
        tripwireTriggered: true,
        outputInfo: { reason: 'blocked after server acceptance' },
      };
    });
    const runner = new Runner({
      inputGuardrails: [{ name: 'pending-guardrail', execute: guardrail }],
    });

    const streamed = await runner.run(agent, state, {
      stream: true,
      conversationId: 'accepted-guardrail-conversation',
    });
    const consumed = (async () => {
      const events: unknown[] = [];
      let error: unknown;
      try {
        for await (const event of streamed) {
          events.push(event);
        }
      } catch (caughtError) {
        error = caughtError;
      }
      return { events, error };
    })();

    await vi.waitFor(() => {
      expect(state._inputGuardrailResults).toHaveLength(1);
    });
    releaseFirstEvent();

    await expect(streamed.completed).rejects.toBeInstanceOf(
      InputGuardrailTripwireTriggered,
    );
    const streamOutcome = await consumed;
    expect(streamOutcome.error).toBeInstanceOf(InputGuardrailTripwireTriggered);
    expect(streamOutcome.events).toEqual([]);
    expect(state.pendingInput).toEqual([]);
    expect(
      state._generatedItems.filter((item) => item instanceof RunInputItem),
    ).toHaveLength(1);
    expect(state._currentStep).toMatchObject({
      type: 'next_step_interruption',
      data: { responseAccepted: true },
    });

    const restored = await RunState.fromString(agent, state.toString());
    await expect(
      runner.run(agent, restored, {
        conversationId: 'accepted-guardrail-conversation',
      }),
    ).rejects.toThrow(/accepted model response could not be processed/i);
    expect(streamCalls).toBe(1);
  });

  it('treats an explicit server-managed stream abort as an unsafe accepted request', async () => {
    const model = new AbortBeforeEventStreamModel();
    const agent = new Agent({ name: 'aborted-server-stream', model });
    const state = createResumableState(agent);
    state.setConversationContext('conversation-abort');
    state.addInput('possibly accepted');

    const streamed = await run(agent, state, {
      stream: true,
      conversationId: 'conversation-abort',
    });
    const reader = (streamed.toStream() as any).getReader();
    await model.started;
    await reader.cancel('stop');
    await streamed.completed;

    expect(state.pendingInput).toEqual([]);
    expect(state._currentStep).toMatchObject({
      type: 'next_step_interruption',
      data: { responseAccepted: true },
    });
    await expect(
      run(agent, state, { conversationId: 'conversation-abort' }),
    ).rejects.toThrow(/accepted model response could not be processed/i);
    expect(model.streamCalls).toBe(1);
  });

  it('leaves pending input untouched when cancellation follows approval tool work', async () => {
    let markInstructionsStarted!: () => void;
    let releaseInstructions!: () => void;
    const instructionsStarted = new Promise<void>((resolve) => {
      markInstructionsStarted = resolve;
    });
    const instructionsCanFinish = new Promise<void>((resolve) => {
      releaseInstructions = resolve;
    });
    const execute = vi.fn(async () => 'approved output');
    const approvalTool = tool({
      name: 'approval_tool',
      description: 'Requires approval.',
      parameters: z.object({}).strict(),
      needsApproval: true,
      execute,
    });
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      name: 'approval_tool',
      callId: 'approval-call',
      status: 'completed',
      arguments: '{}',
    };
    const initialModel = new RecordingModel([
      { output: [functionCall], usage: new Usage() },
    ]);
    let instructionCalls = 0;
    const agent = new Agent({
      name: 'cancel-after-approval-tool',
      model: initialModel,
      tools: [approvalTool],
      instructions: async () => {
        instructionCalls += 1;
        if (instructionCalls > 1) {
          markInstructionsStarted();
          await instructionsCanFinish;
        }
        return 'ready';
      },
    });
    const interrupted = await run(agent, 'initial');
    const state = interrupted.state;
    state.addInput('not admitted');
    state.approve(state.getInterruptions()[0]!);
    const model = new NeverCalledStreamModel();
    agent.model = model;

    const streamed = await run(agent, state, { stream: true });
    const reader = (streamed.toStream() as any).getReader();
    await instructionsStarted;
    const cancellation = reader.cancel('stop before request');
    releaseInstructions();
    await cancellation;
    await streamed.completed;

    expect(streamed.cancelled).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.streamCalls).toBe(0);
    expect(state.pendingInput).toEqual([message('not admitted')]);
    expect(
      state._generatedItems.filter((item) => item instanceof RunInputItem),
    ).toHaveLength(0);
    expect(state._currentTurn).toBe(1);

    const finalModel = new RecordingModel([
      { output: [fakeModelMessage('done')], usage: new Usage() },
    ]);
    agent.model = finalModel;
    const completed = await run(agent, state);
    expect(completed.finalOutput).toBe('done');
    expect(
      (finalModel.requests[0]?.input as AgentInputItem[]).filter(
        (item) => item.type === 'message' && item.content === 'not admitted',
      ),
    ).toHaveLength(1);
  });
});
