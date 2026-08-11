import { Buffer } from 'node:buffer';
import { setTimeout as setTimeoutPromise } from 'node:timers/promises';
import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';
import {
  Agent,
  GuardrailExecutionError,
  InputGuardrailTripwireTriggered,
  MaxTurnsExceededError,
  ModelBehaviorError,
  ModelRefusalError,
  ModelResponse,
  OutputGuardrailTripwireTriggered,
  Session,
  UserError,
  ModelInputData,
  type OutputGuardrailFunctionArgs,
  type AgentInputItem,
  extractAllTextOutput,
  run,
  Runner,
  setDefaultModelProvider,
  setTraceProcessors,
  setTracingDisabled,
  BatchTraceProcessor,
  withTrace,
  user,
  assistant,
  type ToolExecutionConfig,
  type ToolNameCollisionPolicy,
  type ToolNotFoundBehavior,
} from '../src';
import { RunStreamEvent } from '../src/events';
import { InvalidToolInputError, ToolCallError } from '../src/errors';
import { ServerConversationTracker } from '../src/runner/conversation';
import { removeAllTools } from '../src/extensions';
import { handoff } from '../src/handoff';
import {
  RunHandoffOutputItem,
  RunMessageOutputItem as MessageOutputItem,
  RunToolApprovalItem as ToolApprovalItem,
  RunToolCallOutputItem as ToolCallOutputItem,
  RunToolSearchCallItem,
  RunToolSearchOutputItem,
} from '../src/items';
import { MemorySession as CoreMemorySession } from '../src/memory/memorySession';
import { getTurnInput, selectModel } from '../src/run';
import { RunContext } from '../src/runContext';
import { RunState } from '../src/runState';
import * as protocol from '../src/types/protocol';
import { Usage } from '../src/usage';
import {
  attachClientToolSearchExecutor,
  tool,
  hostedMcpTool,
  computerTool,
  shellTool,
  applyPatchTool,
  type HostedTool,
} from '../src/tool';
import logger from '../src/logger';
import { getGlobalTraceProvider } from '../src/tracing/provider';
import {
  fakeModelRefusal,
  fakeModelMessageWithRefusal,
  fakeModelMessage,
  ScriptedModelProvider,
  FakeTracingExporter,
  TEST_MODEL_MESSAGE,
  TEST_MODEL_RESPONSE_BASIC,
  TEST_MODEL_FUNCTION_CALL,
  TEST_TOOL,
  FakeComputer,
  FakeEditor,
  FakeShell,
} from './stubs';
import {
  Model,
  ModelProvider,
  ModelRequest,
  ModelSettings,
} from '../src/model';
import {
  ScriptedModel,
  modelError,
  modelResponder,
  modelResponse,
} from '../src/testing';

const PROGRAMMATIC_TOOL_CALLING_TOOL: HostedTool = {
  type: 'hosted_tool',
  name: 'programmatic_tool_calling',
  providerData: { type: 'programmatic_tool_calling' },
};

function getFirstTextContent(item: AgentInputItem): string | undefined {
  if (item.type !== 'message') {
    return undefined;
  }
  if (typeof item.content === 'string') {
    return item.content;
  }
  if (Array.isArray(item.content)) {
    const first = item.content[0] as { text?: string };
    return first?.text;
  }
  return undefined;
}

function getRequestInputItems(request: ModelRequest): AgentInputItem[] {
  return Array.isArray(request.input) ? request.input : [];
}

function cloneModelRequest(request: Readonly<ModelRequest>): ModelRequest {
  return {
    ...request,
    input: Array.isArray(request.input)
      ? (JSON.parse(JSON.stringify(request.input)) as AgentInputItem[])
      : request.input,
  };
}

function createReasoningPolicyModel(options: {
  reasoningId: string;
  functionId: string;
  callId: string;
  toolName: string;
}): ScriptedModel {
  return new ScriptedModel([
    modelResponse({
      output: [
        {
          type: 'reasoning',
          id: options.reasoningId,
          content: [{ type: 'input_text', text: 'reasoning trace' }],
        } satisfies protocol.ReasoningItem,
        {
          type: 'function_call',
          id: options.functionId,
          callId: options.callId,
          name: options.toolName,
          status: 'completed',
          arguments: '{}',
        } satisfies protocol.FunctionCallItem,
      ],
      usage: new Usage(),
    }),
    modelResponse({
      output: [fakeModelMessage('done')],
      usage: new Usage(),
    }),
  ]);
}

describe('Runner.run', () => {
  beforeAll(() => {
    setTracingDisabled(true);
    setDefaultModelProvider(new ScriptedModelProvider());
  });

  describe('basic', () => {
    it('accepts public tool execution config', () => {
      const toolExecution = {
        maxFunctionToolConcurrency: 2,
        preApprovalInputGuardrails: true,
      } satisfies ToolExecutionConfig;

      const runner = new Runner({
        tracingDisabled: true,
        toolExecution,
      });

      expect(runner.config.toolExecution).toBe(toolExecution);
    });

    it('returns a redacted invalid-argument output to the model', async () => {
      const secret = 'SECRET_NON_STREAMING_MODEL_OUTPUT_123';
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockReturnValue(true);
      const model = new ScriptedModel([
        modelResponse({
          output: [
            {
              ...TEST_MODEL_FUNCTION_CALL,
              arguments: secret,
            },
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [fakeModelMessage('recovered')],
          usage: new Usage(),
        }),
      ]);
      const getResponseSpy = vi.spyOn(model, 'getResponse');
      const agent = new Agent({
        name: 'InvalidArgumentAgent',
        model,
        tools: [TEST_TOOL],
      });

      try {
        const result = await run(agent, 'start');

        expect(result.finalOutput).toBe('recovered');
        expect(getResponseSpy).toHaveBeenCalledTimes(2);
        const secondRequest = getResponseSpy.mock.calls[1][0];
        const toolOutput = getRequestInputItems(secondRequest).find(
          (item) => item.type === 'function_call_result',
        ) as protocol.FunctionCallResultItem | undefined;
        expect(toolOutput?.output).toEqual({
          type: 'text',
          text: 'An error occurred while parsing tool arguments. Please try again with valid JSON.',
        });
        expect(JSON.stringify(toolOutput)).not.toContain(secret);
      } finally {
        getResponseSpy.mockRestore();
        flagSpy.mockRestore();
      }
    });

    it.each([
      ['redacted', true],
      ['diagnostic', false],
    ] as const)(
      '%s invalid-argument errors handle real Runner state safely',
      async (_mode, dontLogToolData) => {
        const secret = dontLogToolData
          ? 'SECRET_REDACTED_RUN_STATE_123'
          : 'SECRET_DIAGNOSTIC_RUN_STATE_123';
        const flagSpy = vi
          .spyOn(logger, 'dontLogToolData', 'get')
          .mockReturnValue(dontLogToolData);
        const model = new ScriptedModel([
          modelResponse({
            output: [
              {
                ...TEST_MODEL_FUNCTION_CALL,
                arguments: secret,
              },
            ],
            usage: new Usage(),
          }),
        ]);
        const structuredTool = tool({
          name: 'test',
          description: 'Validate structured input.',
          parameters: z.object({ test: z.string() }),
          outputSchema: z.object({ status: z.string() }),
          errorFunction: null,
          execute: async () => ({ status: 'unexpected' }),
        });
        const agent = new Agent({
          name: 'InvalidArgumentStateAgent',
          model,
          tools: [structuredTool],
        });

        try {
          const error = await run(agent, 'start').catch((caught) => caught);

          expect(error).toBeInstanceOf(ToolCallError);
          const toolCallError = error as ToolCallError;
          expect(toolCallError.error).toBeInstanceOf(InvalidToolInputError);
          const inputError = toolCallError.error as InvalidToolInputError;
          if (dontLogToolData) {
            expect(toolCallError.state).toBeUndefined();
            expect(inputError.state).toBeUndefined();
            expect(inputError.originalError).toBeUndefined();
            expect(inputError.toolInvocation).toBeUndefined();
            expect(JSON.stringify(toolCallError)).not.toContain(secret);
          } else {
            expect(toolCallError.state).toBeDefined();
            expect(inputError.state).toBe(toolCallError.state);
            expect(inputError.originalError).toBeDefined();
            expect(inputError.toolInvocation?.input).toBe(secret);
            expect(
              inputError.state?._lastProcessedResponse?.functions[0].toolCall
                .arguments,
            ).toBe(secret);
          }
        } finally {
          flagSpy.mockRestore();
        }
      },
    );

    it('propagates run cancellation to a direct function tool', async () => {
      const controller = new AbortController();
      const abortReason = new Error('stop direct tool');
      let toolSignal: AbortSignal | undefined;
      let markToolStarted: (() => void) | undefined;
      const toolStarted = new Promise<void>((resolve) => {
        markToolStarted = resolve;
      });
      let releaseTool: (() => void) | undefined;
      const toolCanFinish = new Promise<void>((resolve) => {
        releaseTool = resolve;
      });
      const abortableTool = tool({
        name: 'test',
        description: 'finishes cleanup after the run is cancelled',
        parameters: z.object({ test: z.string() }),
        execute: async (_input, _context, details) => {
          toolSignal = details?.signal;
          markToolStarted?.();
          await toolCanFinish;
          return 'cancelled after cleanup';
        },
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [{ ...TEST_MODEL_FUNCTION_CALL }],
          usage: new Usage(),
        }),
        modelResponse({
          output: [fakeModelMessage('unexpected second response')],
          usage: new Usage(),
        }),
      ]);
      const getResponseSpy = vi.spyOn(model, 'getResponse');
      const agent = new Agent({
        name: 'DirectCancellationAgent',
        model,
        tools: [abortableTool],
      });
      const state = new RunState(new RunContext(), 'start', agent, 10);

      const runPromise = run(agent, state, { signal: controller.signal });
      const rejection = expect(runPromise).rejects.toBe(abortReason);
      await toolStarted;

      expect(toolSignal).toBe(controller.signal);
      controller.abort(abortReason);
      releaseTool?.();

      await rejection;
      expect(getResponseSpy).toHaveBeenCalledTimes(1);
      expect(
        state._generatedItems.filter(
          (item) => item.rawItem.type === 'function_call_result',
        ),
      ).toHaveLength(1);
    });

    it('preserves a function tool abort reason without wrapping it', async () => {
      const controller = new AbortController();
      const abortReason = new Error('stop failed tool');
      let markToolStarted: (() => void) | undefined;
      const toolStarted = new Promise<void>((resolve) => {
        markToolStarted = resolve;
      });
      const abortableTool = tool({
        name: 'test',
        description: 'throws the run abort reason',
        parameters: z.object({ test: z.string() }),
        execute: async (_input, _context, details) => {
          markToolStarted?.();
          if (!details?.signal) {
            throw new Error('Expected the run abort signal');
          }
          await setTimeoutPromise(60_000, undefined, {
            signal: details.signal,
          });
          return 'unexpected tool output';
        },
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [{ ...TEST_MODEL_FUNCTION_CALL }],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'AbortReasonAgent',
        model,
        tools: [abortableTool],
      });
      const state = new RunState(new RunContext(), 'start', agent, 10);

      const runPromise = run(agent, state, { signal: controller.signal });
      const rejection = expect(runPromise).rejects.toBe(abortReason);
      await toolStarted;

      controller.abort(abortReason);

      await rejection;
      expect(
        state._generatedItems.filter(
          (item) =>
            item.rawItem.type === 'function_call_result' &&
            item.rawItem.callId === TEST_MODEL_FUNCTION_CALL.callId &&
            item.rawItem.status === 'incomplete',
        ),
      ).toHaveLength(1);
    });

    it('waits for sibling function tools before surfacing cancellation', async () => {
      const controller = new AbortController();
      const abortReason = new Error('stop parallel tools');
      let markAbortToolStarted: (() => void) | undefined;
      const abortToolStarted = new Promise<void>((resolve) => {
        markAbortToolStarted = resolve;
      });
      let markAbortObserved: (() => void) | undefined;
      const abortObserved = new Promise<void>((resolve) => {
        markAbortObserved = resolve;
      });
      let markSiblingStarted: (() => void) | undefined;
      const siblingStarted = new Promise<void>((resolve) => {
        markSiblingStarted = resolve;
      });
      let releaseSibling: (() => void) | undefined;
      const siblingCanFinish = new Promise<void>((resolve) => {
        releaseSibling = resolve;
      });
      let siblingFinished = false;

      const abortableTool = tool({
        name: 'abortable_tool',
        description: 'throws the run abort reason',
        parameters: z.object({ test: z.string() }),
        errorFunction: null,
        execute: async (_input, _context, details) => {
          markAbortToolStarted?.();
          if (!details?.signal) {
            throw new Error('Expected the run abort signal');
          }
          try {
            await setTimeoutPromise(60_000, undefined, {
              signal: details.signal,
            });
          } catch (error) {
            markAbortObserved?.();
            throw error;
          }
          return 'unexpected tool output';
        },
      });
      const siblingTool = tool({
        name: 'sibling_tool',
        description: 'finishes independently of run cancellation',
        parameters: z.object({ test: z.string() }),
        execute: async () => {
          markSiblingStarted?.();
          await siblingCanFinish;
          siblingFinished = true;
          return 'sibling complete';
        },
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            {
              ...TEST_MODEL_FUNCTION_CALL,
              id: 'abortable-call',
              callId: 'abortable-call',
              name: 'abortable_tool',
            },
            {
              ...TEST_MODEL_FUNCTION_CALL,
              id: 'sibling-call',
              callId: 'sibling-call',
              name: 'sibling_tool',
            },
          ],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'ParallelCancellationAgent',
        model,
        tools: [abortableTool, siblingTool],
      });
      const state = new RunState(new RunContext(), 'start', agent, 10);

      const runPromise = run(agent, state, { signal: controller.signal });
      let runSettled = false;
      const runOutcome = runPromise.then(
        () => {
          runSettled = true;
          return { error: undefined };
        },
        (error: unknown) => {
          runSettled = true;
          return { error };
        },
      );
      await Promise.all([abortToolStarted, siblingStarted]);

      controller.abort(abortReason);
      await abortObserved;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const settledBeforeSibling = runSettled;

      releaseSibling?.();
      const outcome = await runOutcome;

      expect(settledBeforeSibling).toBe(false);
      expect(siblingFinished).toBe(true);
      expect(outcome.error).toBe(abortReason);
      expect(
        state._generatedItems.filter(
          (item) =>
            item.rawItem.type === 'function_call_result' &&
            item.rawItem.callId === 'sibling-call',
        ),
      ).toHaveLength(1);
    });

    it('waits for a concurrent computer action before surfacing cancellation', async () => {
      const controller = new AbortController();
      const abortReason = new Error('stop parallel actions');
      let markAbortToolStarted: (() => void) | undefined;
      const abortToolStarted = new Promise<void>((resolve) => {
        markAbortToolStarted = resolve;
      });
      let markAbortObserved: (() => void) | undefined;
      const abortObserved = new Promise<void>((resolve) => {
        markAbortObserved = resolve;
      });
      let markComputerStarted: (() => void) | undefined;
      const computerStarted = new Promise<void>((resolve) => {
        markComputerStarted = resolve;
      });
      let releaseComputer: (() => void) | undefined;
      const computerCanFinish = new Promise<void>((resolve) => {
        releaseComputer = resolve;
      });
      let computerFinished = false;

      const abortableTool = tool({
        name: 'abortable_tool',
        description: 'throws the run abort reason',
        parameters: z.object({ test: z.string() }),
        errorFunction: null,
        execute: async (_input, _context, details) => {
          markAbortToolStarted?.();
          if (!details?.signal) {
            throw new Error('Expected the run abort signal');
          }
          if (!details.signal.aborted) {
            await new Promise<void>((resolve) => {
              details.signal?.addEventListener('abort', () => resolve(), {
                once: true,
              });
            });
          }
          markAbortObserved?.();
          details.signal.throwIfAborted();
          return 'unexpected tool output';
        },
      });
      const computer = new FakeComputer();
      const computerClick = vi.fn(async () => {
        markComputerStarted?.();
        await computerCanFinish;
        computerFinished = true;
      });
      computer.click = computerClick;
      const computerCall: protocol.ComputerUseCallItem = {
        type: 'computer_call',
        id: 'computer-call',
        callId: 'computer-call',
        status: 'completed',
        action: {
          type: 'click',
          x: 1,
          y: 1,
          button: 'left',
        },
      };
      const model = new ScriptedModel([
        modelResponse({
          output: [
            {
              ...TEST_MODEL_FUNCTION_CALL,
              id: 'abortable-call',
              callId: 'abortable-call',
              name: 'abortable_tool',
            },
            computerCall,
          ],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'ParallelActionCancellationAgent',
        model,
        tools: [abortableTool, computerTool({ computer })],
      });
      const state = new RunState(new RunContext(), 'start', agent, 10);

      const runPromise = run(agent, state, { signal: controller.signal });
      let runSettled = false;
      const runOutcome = runPromise.then(
        () => {
          runSettled = true;
          return { error: undefined };
        },
        (error: unknown) => {
          runSettled = true;
          return { error };
        },
      );
      await Promise.all([abortToolStarted, computerStarted]);

      controller.abort(abortReason);
      await abortObserved;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const settledBeforeComputer = runSettled;

      releaseComputer?.();
      const outcome = await runOutcome;

      expect(settledBeforeComputer).toBe(false);
      expect(computerFinished).toBe(true);
      expect(outcome.error).toBe(abortReason);
      expect(computerClick).toHaveBeenCalledTimes(1);
      expect(
        state._generatedItems.filter(
          (item) => item.rawItem.type === 'computer_call_result',
        ),
      ).toHaveLength(1);
    });

    it('cancels and drains function work after a computer category failure', async () => {
      const primaryError = new Error('computer category failed');
      let markFunctionStarted: (() => void) | undefined;
      const functionStarted = new Promise<void>((resolve) => {
        markFunctionStarted = resolve;
      });
      let functionCancelled = false;
      let functionDrained = false;
      let lateSideEffect = false;

      const abortableTool = tool({
        name: 'abortable_tool',
        description: 'waits for sibling category cancellation',
        parameters: z.object({ test: z.string() }),
        errorFunction: null,
        execute: async (_input, _context, details) => {
          markFunctionStarted?.();
          if (!details?.signal) {
            throw new Error('Expected an internal cancellation signal');
          }
          try {
            await setTimeoutPromise(60_000, undefined, {
              signal: details.signal,
            });
            lateSideEffect = true;
            return 'unexpected tool output';
          } catch (error) {
            functionCancelled = true;
            await Promise.resolve();
            functionDrained = true;
            throw error;
          }
        },
      });
      const computer = new FakeComputer();
      const computerCall: protocol.ComputerUseCallItem = {
        type: 'computer_call',
        id: 'computer-call',
        callId: 'computer-call',
        status: 'completed',
        action: { type: 'screenshot' },
        providerData: {
          pending_safety_checks: [
            {
              id: 'safety-check',
              code: 'malicious_instructions',
            },
          ],
        },
      };
      const model = new ScriptedModel([
        modelResponse({
          output: [
            {
              ...TEST_MODEL_FUNCTION_CALL,
              id: 'abortable-call',
              callId: 'abortable-call',
              name: 'abortable_tool',
            },
            computerCall,
          ],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'SiblingCategoryFailureAgent',
        model,
        tools: [
          abortableTool,
          computerTool({
            computer,
            onSafetyCheck: async () => {
              await functionStarted;
              throw primaryError;
            },
          }),
        ],
      });

      const error = await run(agent, 'start').catch((caught) => caught);

      expect(error).toBe(primaryError);
      expect(functionCancelled).toBe(true);
      expect(functionDrained).toBe(true);
      expect(lateSideEffect).toBe(false);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(lateSideEffect).toBe(false);
    });

    it('reserves a batched computer approval failure while sibling callbacks drain', async () => {
      const primaryError = new Error('computer approval failed');
      let markFunctionStarted: (() => void) | undefined;
      const functionStarted = new Promise<void>((resolve) => {
        markFunctionStarted = resolve;
      });
      let markFunctionCancelled: (() => void) | undefined;
      const functionCancelled = new Promise<void>((resolve) => {
        markFunctionCancelled = resolve;
      });
      let startedApprovals = 0;
      let markApprovalsStarted: (() => void) | undefined;
      const approvalsStarted = new Promise<void>((resolve) => {
        markApprovalsStarted = resolve;
      });
      let releaseBlockedApproval: (() => void) | undefined;
      const blockedApprovalCanFinish = new Promise<void>((resolve) => {
        releaseBlockedApproval = resolve;
      });
      let runSettled = false;
      let sideEffectAfterRejection = false;

      const abortableTool = tool({
        name: 'abortable_tool',
        description: 'waits for sibling category cancellation',
        parameters: z.object({ test: z.string() }),
        errorFunction: null,
        execute: async (_input, _context, details) => {
          markFunctionStarted?.();
          if (!details?.signal) {
            throw new Error('Expected an internal cancellation signal');
          }
          await new Promise<void>((resolve) => {
            if (details.signal?.aborted) {
              resolve();
              return;
            }
            details.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
          markFunctionCancelled?.();
          return 'cancelled';
        },
      });
      const computer = new FakeComputer();
      const screenshot = vi.fn(async () => 'img');
      computer.screenshot = screenshot;
      const needsApproval = vi.fn(
        async (_context: RunContext, action: protocol.ComputerAction) => {
          startedApprovals += 1;
          if (startedApprovals === 2) {
            markApprovalsStarted?.();
          }
          await approvalsStarted;
          if (action.type === 'click') {
            await functionStarted;
            throw primaryError;
          }
          await blockedApprovalCanFinish;
          sideEffectAfterRejection = runSettled;
          return false;
        },
      );
      const computerCall: protocol.ComputerUseCallItem = {
        type: 'computer_call',
        id: 'computer-call',
        callId: 'computer-call',
        status: 'completed',
        actions: [
          { type: 'click', x: 1, y: 2, button: 'left' },
          { type: 'move', x: 3, y: 4 },
        ],
      };
      const model = new ScriptedModel([
        modelResponse({
          output: [
            {
              ...TEST_MODEL_FUNCTION_CALL,
              id: 'abortable-call',
              callId: 'abortable-call',
              name: 'abortable_tool',
            },
            computerCall,
          ],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'BatchedComputerApprovalFailureAgent',
        model,
        tools: [abortableTool, computerTool({ computer, needsApproval })],
      });

      const runOutcome = run(agent, 'start')
        .then(
          () => undefined,
          (error: unknown) => error,
        )
        .finally(() => {
          runSettled = true;
        });

      await functionCancelled;
      expect(runSettled).toBe(false);
      releaseBlockedApproval?.();

      expect(await runOutcome).toBe(primaryError);
      expect(sideEffectAfterRejection).toBe(false);
      expect(needsApproval).toHaveBeenCalledTimes(2);
      expect(screenshot).not.toHaveBeenCalled();
    });

    it('drains function post-invocation work after a category failure', async () => {
      const primaryError = new Error('computer category failed');
      let markPostInvocationStarted: (() => void) | undefined;
      const postInvocationStarted = new Promise<void>((resolve) => {
        markPostInvocationStarted = resolve;
      });
      let releasePostInvocation: (() => void) | undefined;
      const postInvocationCanFinish = new Promise<void>((resolve) => {
        releasePostInvocation = resolve;
      });
      let postInvocationFinished = false;

      const quickTool = tool({
        name: 'quick_tool',
        description: 'finishes before sibling category failure',
        parameters: z.object({ test: z.string() }),
        execute: async () => 'tool output',
        customDataExtractor: async () => {
          markPostInvocationStarted?.();
          await postInvocationCanFinish;
          postInvocationFinished = true;
          return { lifecycle: 'complete' };
        },
      });
      const computerCall: protocol.ComputerUseCallItem = {
        type: 'computer_call',
        id: 'computer-call',
        callId: 'computer-call',
        status: 'completed',
        action: { type: 'screenshot' },
        providerData: {
          pending_safety_checks: [
            {
              id: 'safety-check',
              code: 'malicious_instructions',
            },
          ],
        },
      };
      const model = new ScriptedModel([
        modelResponse({
          output: [
            {
              ...TEST_MODEL_FUNCTION_CALL,
              id: 'quick-call',
              callId: 'quick-call',
              name: 'quick_tool',
            },
            computerCall,
          ],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'PostInvocationDrainAgent',
        model,
        tools: [
          quickTool,
          computerTool({
            computer: new FakeComputer(),
            onSafetyCheck: async () => {
              await postInvocationStarted;
              throw primaryError;
            },
          }),
        ],
      });

      let runSettled = false;
      const runOutcome = run(agent, 'start').then(
        () => {
          runSettled = true;
          return undefined;
        },
        (error: unknown) => {
          runSettled = true;
          return error;
        },
      );
      await postInvocationStarted;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(runSettled).toBe(false);
      releasePostInvocation?.();
      const error = await runOutcome;
      expect(error).toBe(primaryError);
      expect(postInvocationFinished).toBe(true);
    });

    it('stops computer actions while failed function work drains', async () => {
      const primaryError = new Error('function category failed');
      let markSlowFunctionStarted: (() => void) | undefined;
      const slowFunctionStarted = new Promise<void>((resolve) => {
        markSlowFunctionStarted = resolve;
      });
      let markComputerPreparationStarted: (() => void) | undefined;
      const computerPreparationStarted = new Promise<void>((resolve) => {
        markComputerPreparationStarted = resolve;
      });
      let releaseComputerPreparation: (() => void) | undefined;
      const computerPreparationCanFinish = new Promise<void>((resolve) => {
        releaseComputerPreparation = resolve;
      });
      let markFunctionCleanupStarted: (() => void) | undefined;
      const functionCleanupStarted = new Promise<void>((resolve) => {
        markFunctionCleanupStarted = resolve;
      });
      let releaseFunctionCleanup: (() => void) | undefined;
      const functionCleanupCanFinish = new Promise<void>((resolve) => {
        releaseFunctionCleanup = resolve;
      });
      let functionCleanupFinished = false;

      const failingTool = tool({
        name: 'failing_tool',
        description: 'fails after sibling categories start',
        parameters: z.object({ test: z.string() }),
        errorFunction: null,
        execute: async () => {
          await Promise.all([slowFunctionStarted, computerPreparationStarted]);
          throw primaryError;
        },
      });
      const slowTool = tool({
        name: 'slow_tool',
        description: 'blocks cleanup after cancellation',
        parameters: z.object({ test: z.string() }),
        errorFunction: null,
        execute: async (_input, _context, details) => {
          markSlowFunctionStarted?.();
          if (!details?.signal) {
            throw new Error('Expected an internal cancellation signal');
          }
          try {
            await setTimeoutPromise(60_000, undefined, {
              signal: details.signal,
            });
            return 'unexpected tool output';
          } catch (error) {
            markFunctionCleanupStarted?.();
            await functionCleanupCanFinish;
            functionCleanupFinished = true;
            throw error;
          }
        },
      });
      const computer = new FakeComputer();
      const screenshot = vi.fn(async () => 'img');
      computer.screenshot = screenshot;
      const firstComputerCall: protocol.ComputerUseCallItem = {
        type: 'computer_call',
        id: 'computer-call-1',
        callId: 'computer-call-1',
        status: 'completed',
        action: { type: 'screenshot' },
        providerData: {
          pending_safety_checks: [
            {
              id: 'safety-check',
              code: 'malicious_instructions',
            },
          ],
        },
      };
      const secondComputerCall: protocol.ComputerUseCallItem = {
        type: 'computer_call',
        id: 'computer-call-2',
        callId: 'computer-call-2',
        status: 'completed',
        action: { type: 'screenshot' },
      };
      const model = new ScriptedModel([
        modelResponse({
          output: [
            {
              ...TEST_MODEL_FUNCTION_CALL,
              id: 'failing-call',
              callId: 'failing-call',
              name: 'failing_tool',
            },
            {
              ...TEST_MODEL_FUNCTION_CALL,
              id: 'slow-call',
              callId: 'slow-call',
              name: 'slow_tool',
            },
            firstComputerCall,
            secondComputerCall,
          ],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'FunctionFailureStopsComputerAgent',
        model,
        tools: [
          failingTool,
          slowTool,
          computerTool({
            computer,
            onSafetyCheck: async () => {
              markComputerPreparationStarted?.();
              await computerPreparationCanFinish;
              return true;
            },
          }),
        ],
      });

      let runSettled = false;
      const runOutcome = run(agent, 'start').then(
        () => {
          runSettled = true;
          return undefined;
        },
        (error: unknown) => {
          runSettled = true;
          return error;
        },
      );
      await functionCleanupStarted;

      releaseComputerPreparation?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(screenshot).not.toHaveBeenCalled();
      expect(runSettled).toBe(false);

      releaseFunctionCleanup?.();
      const error = await runOutcome;
      expect(error).toBeInstanceOf(ToolCallError);
      expect((error as ToolCallError).error).toBe(primaryError);
      expect(functionCleanupFinished).toBe(true);
      expect(screenshot).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(screenshot).not.toHaveBeenCalled();
    });

    it('finishes a rejected computer safety check as aborted after a function failure', async () => {
      const primaryError = new Error('function category failed');
      const secondaryError = new Error(
        'safety check failed after cancellation',
      );
      let markSafetyCheckStarted: (() => void) | undefined;
      const safetyCheckStarted = new Promise<void>((resolve) => {
        markSafetyCheckStarted = resolve;
      });
      let releaseSafetyCheck: (() => void) | undefined;
      const safetyCheckCanFinish = new Promise<void>((resolve) => {
        releaseSafetyCheck = resolve;
      });
      let markSlowFunctionStarted: (() => void) | undefined;
      const slowFunctionStarted = new Promise<void>((resolve) => {
        markSlowFunctionStarted = resolve;
      });
      let markCancellationObserved: (() => void) | undefined;
      const cancellationObserved = new Promise<void>((resolve) => {
        markCancellationObserved = resolve;
      });

      const failingTool = tool({
        name: 'failing_tool',
        description: 'fails after the computer safety check starts',
        parameters: z.object({ test: z.string() }),
        errorFunction: null,
        execute: async () => {
          await Promise.all([safetyCheckStarted, slowFunctionStarted]);
          throw primaryError;
        },
      });
      const slowTool = tool({
        name: 'slow_tool',
        description: 'observes sibling cancellation',
        parameters: z.object({ test: z.string() }),
        execute: async (_input, _context, details) => {
          markSlowFunctionStarted?.();
          await new Promise<void>((resolve) => {
            details?.signal?.addEventListener(
              'abort',
              () => {
                markCancellationObserved?.();
                resolve();
              },
              { once: true },
            );
          });
          return 'cancelled';
        },
      });
      const queuedParser = vi.fn(() => true);
      const queuedToolExecute = vi.fn(async () => 'unexpected');
      const queuedTool = tool({
        name: 'queued_tool',
        description: 'must remain unclaimed after the function failure',
        parameters: z.object({ value: z.string().refine(queuedParser) }),
        execute: queuedToolExecute,
      });
      const fakeComputer = new FakeComputer();
      const screenshot = vi.fn(async () => 'img');
      fakeComputer.screenshot = screenshot;
      const computer = computerTool({
        computer: fakeComputer,
        onSafetyCheck: async () => {
          markSafetyCheckStarted?.();
          await safetyCheckCanFinish;
          throw secondaryError;
        },
      });
      const computerCall: protocol.ComputerUseCallItem = {
        type: 'computer_call',
        id: 'computer-call',
        callId: 'computer-call',
        status: 'completed',
        action: { type: 'screenshot' },
        providerData: {
          pending_safety_checks: [
            {
              id: 'safety-check',
              code: 'malicious_instructions',
            },
          ],
        },
      };
      const model = new ScriptedModel([
        modelResponse({
          output: [
            {
              ...TEST_MODEL_FUNCTION_CALL,
              id: 'failing-call',
              callId: 'failing-call',
              name: 'failing_tool',
            },
            {
              ...TEST_MODEL_FUNCTION_CALL,
              id: 'slow-call',
              callId: 'slow-call',
              name: 'slow_tool',
            },
            {
              ...TEST_MODEL_FUNCTION_CALL,
              id: 'queued-call',
              callId: 'queued-call',
              name: 'queued_tool',
              arguments: JSON.stringify({ value: 'queued' }),
            },
            computerCall,
          ],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'RejectedSafetyCheckCancellationAgent',
        model,
        tools: [failingTool, slowTool, queuedTool, computer],
      });
      const runner = new Runner({
        toolExecution: { maxFunctionToolConcurrency: 2 },
      });
      const end = vi.fn();
      runner.on('agent_tool_end', end);

      let settled = false;
      const runOutcome = runner.run(agent, 'start').then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await cancellationObserved;

      expect(settled).toBe(false);
      releaseSafetyCheck?.();

      const error = await runOutcome;
      const computerEndCalls = end.mock.calls.filter(
        ([, , endedTool]) => endedTool === computer,
      );
      expect(error).toBeInstanceOf(ToolCallError);
      expect((error as ToolCallError).error).toBe(primaryError);
      expect(screenshot).not.toHaveBeenCalled();
      expect(queuedParser).not.toHaveBeenCalled();
      expect(queuedToolExecute).not.toHaveBeenCalled();
      expect(computerEndCalls).toHaveLength(1);
      expect(computerEndCalls[0]?.[3]).toBe('aborted');
    });

    it('reconciles later actions without starting them after cancellation', async () => {
      const controller = new AbortController();
      const abortReason = new Error('stop mixed actions');
      let markToolStarted: (() => void) | undefined;
      const toolStarted = new Promise<void>((resolve) => {
        markToolStarted = resolve;
      });
      const abortableTool = tool({
        name: 'abortable_tool',
        description: 'throws the run abort reason',
        parameters: z.object({ test: z.string() }),
        errorFunction: null,
        execute: async (_input, _context, details) => {
          markToolStarted?.();
          if (!details?.signal) {
            throw new Error('Expected the run abort signal');
          }
          if (!details.signal.aborted) {
            await new Promise<void>((resolve) => {
              details.signal?.addEventListener('abort', () => resolve(), {
                once: true,
              });
            });
          }
          details.signal.throwIfAborted();
          return 'unexpected tool output';
        },
      });
      const approvalToolExecute = vi.fn(async () => 'approved');
      const approvalTool = tool({
        name: 'approval_tool',
        description: 'requires approval',
        parameters: z.object({ test: z.string() }),
        needsApproval: true,
        execute: approvalToolExecute,
      });
      const shell = new FakeShell();
      const editor = new FakeEditor();
      const model = new ScriptedModel([
        modelResponse({
          output: [
            {
              ...TEST_MODEL_FUNCTION_CALL,
              id: 'abortable-call',
              callId: 'abortable-call',
              name: 'abortable_tool',
            },
            {
              type: 'shell_call',
              callId: 'shell-call',
              status: 'completed',
              action: { commands: ['echo completed'] },
            },
            {
              type: 'apply_patch_call',
              callId: 'apply-patch-call',
              status: 'completed',
              operation: {
                type: 'update_file',
                path: 'README.md',
                diff: 'diff --git',
              },
            },
            {
              ...TEST_MODEL_FUNCTION_CALL,
              id: 'approval-call',
              callId: 'approval-call',
              name: 'approval_tool',
            },
          ],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'MixedActionCancellationAgent',
        model,
        tools: [
          abortableTool,
          approvalTool,
          shellTool({ shell }),
          applyPatchTool({ editor }),
        ],
      });
      const state = new RunState(new RunContext(), 'start', agent, 10);

      const runPromise = run(agent, state, { signal: controller.signal });
      const rejection = expect(runPromise).rejects.toBe(abortReason);
      await toolStarted;

      controller.abort(abortReason);

      await rejection;
      expect(shell.calls).toHaveLength(0);
      expect(editor.operations).toHaveLength(0);
      expect(approvalToolExecute).not.toHaveBeenCalled();
      expect(state.getInterruptions()).toHaveLength(1);
      expect(state.getInterruptions()[0].rawItem).toMatchObject({
        type: 'function_call',
        callId: 'approval-call',
      });
      expect(
        state._generatedItems.filter(
          (item) =>
            item.rawItem.type === 'function_call_result' &&
            item.rawItem.callId === 'abortable-call' &&
            item.rawItem.status === 'incomplete',
        ),
      ).toHaveLength(1);
      expect(
        state._generatedItems.filter(
          (item) =>
            item.rawItem.type === 'shell_call_output' &&
            item.rawItem.callId === 'shell-call' &&
            item.rawItem.status === 'incomplete',
        ),
      ).toHaveLength(1);
      expect(
        state._generatedItems.filter(
          (item) =>
            item.rawItem.type === 'apply_patch_call_output' &&
            item.rawItem.callId === 'apply-patch-call' &&
            item.rawItem.status === 'failed',
        ),
      ).toHaveLength(1);
    });

    it('does not start queued function tools after cancellation', async () => {
      const controller = new AbortController();
      const abortReason = new Error('stop queued tools');
      let markToolStarted: (() => void) | undefined;
      const toolStarted = new Promise<void>((resolve) => {
        markToolStarted = resolve;
      });
      const abortableTool = tool({
        name: 'abortable_tool',
        description: 'throws the run abort reason',
        parameters: z.object({ test: z.string() }),
        errorFunction: null,
        execute: async (_input, _context, details) => {
          markToolStarted?.();
          if (!details?.signal) {
            throw new Error('Expected the run abort signal');
          }
          if (!details.signal.aborted) {
            await new Promise<void>((resolve) => {
              details.signal?.addEventListener('abort', () => resolve(), {
                once: true,
              });
            });
          }
          details.signal.throwIfAborted();
          return 'unexpected tool output';
        },
      });
      const queuedExecute = vi.fn(async () => 'unexpected queued output');
      const queuedTool = tool({
        name: 'queued_tool',
        description: 'must not start after cancellation',
        parameters: z.object({ test: z.string() }),
        execute: queuedExecute,
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            {
              ...TEST_MODEL_FUNCTION_CALL,
              id: 'abortable-call',
              callId: 'abortable-call',
              name: 'abortable_tool',
            },
            {
              ...TEST_MODEL_FUNCTION_CALL,
              id: 'queued-call',
              callId: 'queued-call',
              name: 'queued_tool',
            },
          ],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'QueuedCancellationAgent',
        model,
        tools: [abortableTool, queuedTool],
      });
      const state = new RunState(new RunContext(), 'start', agent, 10);
      const runner = new Runner({
        toolExecution: { maxFunctionToolConcurrency: 1 },
      });

      const runPromise = runner.run(agent, state, {
        signal: controller.signal,
      });
      const rejection = expect(runPromise).rejects.toBe(abortReason);
      await toolStarted;

      controller.abort(abortReason);

      await rejection;
      expect(queuedExecute).not.toHaveBeenCalled();
      expect(
        state._generatedItems.filter(
          (item) =>
            item.rawItem.type === 'function_call_result' &&
            item.rawItem.status === 'incomplete',
        ),
      ).toHaveLength(2);
    });

    it('propagates run cancellation to an approved function tool', async () => {
      const controller = new AbortController();
      const abortReason = new Error('stop approved tool');
      let toolSignal: AbortSignal | undefined;
      let markToolStarted: (() => void) | undefined;
      const toolStarted = new Promise<void>((resolve) => {
        markToolStarted = resolve;
      });
      let releaseTool: (() => void) | undefined;
      const toolCanFinish = new Promise<void>((resolve) => {
        releaseTool = resolve;
      });
      const approvalTool = tool({
        name: 'test',
        description: 'requires approval before waiting for cancellation',
        parameters: z.object({ test: z.string() }),
        needsApproval: true,
        execute: async (_input, _context, details) => {
          toolSignal = details?.signal;
          markToolStarted?.();
          await toolCanFinish;
          return 'approved tool cleanup complete';
        },
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [{ ...TEST_MODEL_FUNCTION_CALL }],
          usage: new Usage(),
        }),
        modelResponse({
          output: [fakeModelMessage('unexpected second response')],
          usage: new Usage(),
        }),
      ]);
      const getResponseSpy = vi.spyOn(model, 'getResponse');
      const agent = new Agent({
        name: 'ApprovedCancellationAgent',
        model,
        tools: [approvalTool],
      });

      const interruptedResult = await run(agent, 'start');
      expect(interruptedResult.interruptions).toHaveLength(1);
      interruptedResult.state.approve(interruptedResult.interruptions[0]);

      const runPromise = run(agent, interruptedResult.state, {
        signal: controller.signal,
      });
      const rejection = expect(runPromise).rejects.toBe(abortReason);
      await toolStarted;

      expect(toolSignal).toBe(controller.signal);
      controller.abort(abortReason);
      releaseTool?.();

      await rejection;
      expect(getResponseSpy).toHaveBeenCalledTimes(1);
      expect(
        interruptedResult.state._generatedItems.filter(
          (item) => item.rawItem.type === 'function_call_result',
        ),
      ).toHaveLength(1);
    });

    it('preserves approved sibling results when cancellation is surfaced', async () => {
      const controller = new AbortController();
      const abortReason = new Error('stop approved siblings');
      let markAbortToolStarted: (() => void) | undefined;
      const abortToolStarted = new Promise<void>((resolve) => {
        markAbortToolStarted = resolve;
      });
      let markSiblingStarted: (() => void) | undefined;
      const siblingStarted = new Promise<void>((resolve) => {
        markSiblingStarted = resolve;
      });
      let releaseSibling: (() => void) | undefined;
      const siblingCanFinish = new Promise<void>((resolve) => {
        releaseSibling = resolve;
      });
      const abortableTool = tool({
        name: 'approved_abortable_tool',
        description: 'throws the run abort reason after approval',
        parameters: z.object({ test: z.string() }),
        needsApproval: true,
        errorFunction: null,
        execute: async (_input, _context, details) => {
          markAbortToolStarted?.();
          if (!details?.signal) {
            throw new Error('Expected the run abort signal');
          }
          if (!details.signal.aborted) {
            await new Promise<void>((resolve) => {
              details.signal?.addEventListener('abort', () => resolve(), {
                once: true,
              });
            });
          }
          details.signal.throwIfAborted();
          return 'unexpected tool output';
        },
      });
      const siblingTool = tool({
        name: 'approved_sibling_tool',
        description: 'finishes independently after approval',
        parameters: z.object({ test: z.string() }),
        needsApproval: true,
        execute: async () => {
          markSiblingStarted?.();
          await siblingCanFinish;
          return 'approved sibling complete';
        },
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            {
              ...TEST_MODEL_FUNCTION_CALL,
              id: 'approved-abortable-call',
              callId: 'approved-abortable-call',
              name: 'approved_abortable_tool',
            },
            {
              ...TEST_MODEL_FUNCTION_CALL,
              id: 'approved-sibling-call',
              callId: 'approved-sibling-call',
              name: 'approved_sibling_tool',
            },
          ],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'ApprovedSiblingCancellationAgent',
        model,
        tools: [abortableTool, siblingTool],
      });

      const interruptedResult = await run(agent, 'start');
      expect(interruptedResult.interruptions).toHaveLength(2);
      for (const interruption of interruptedResult.interruptions) {
        interruptedResult.state.approve(interruption);
      }

      const runPromise = run(agent, interruptedResult.state, {
        signal: controller.signal,
      });
      const rejection = expect(runPromise).rejects.toBe(abortReason);
      await Promise.all([abortToolStarted, siblingStarted]);

      controller.abort(abortReason);
      releaseSibling?.();

      await rejection;
      expect(interruptedResult.state.getInterruptions()).toHaveLength(0);
      expect(
        interruptedResult.state._generatedItems.filter(
          (item) =>
            item.rawItem.type === 'function_call_result' &&
            item.rawItem.callId === 'approved-abortable-call' &&
            item.rawItem.status === 'incomplete',
        ),
      ).toHaveLength(1);
      expect(
        interruptedResult.state._generatedItems.filter(
          (item) =>
            item.rawItem.type === 'function_call_result' &&
            item.rawItem.callId === 'approved-sibling-call' &&
            item.rawItem.status === 'completed',
        ),
      ).toHaveLength(1);
    });

    it('accepts public tool not found behavior config', () => {
      const toolNotFoundBehavior =
        'return_error_to_model' satisfies ToolNotFoundBehavior;

      const runner = new Runner({
        tracingDisabled: true,
        toolNotFoundBehavior,
      });

      expect(runner.config.toolNotFoundBehavior).toBe('return_error_to_model');
    });

    it('defaults the public tool name collision policy to warn', () => {
      const runner = new Runner({ tracingDisabled: true });

      expect(runner.config.toolNameCollisionPolicy).toBe('warn');
    });

    it('accepts the public tool name collision policy config', () => {
      const toolNameCollisionPolicy = 'error' satisfies ToolNameCollisionPolicy;
      const runner = new Runner({
        tracingDisabled: true,
        toolNameCollisionPolicy,
      });

      expect(runner.config.toolNameCollisionPolicy).toBe('error');
    });

    it('rejects an invalid tool name collision policy in Runner config', () => {
      expect(
        () =>
          new Runner({
            toolNameCollisionPolicy: 'invalid' as ToolNameCollisionPolicy,
          }),
      ).toThrow('toolNameCollisionPolicy must be either "warn" or "error".');
    });

    it('rejects a null tool name collision policy in Runner config', () => {
      expect(
        () =>
          new Runner({
            toolNameCollisionPolicy: null as any,
          }),
      ).toThrow('toolNameCollisionPolicy must be either "warn" or "error".');
    });

    it('rejects an invalid per-run tool name collision policy before model calls', async () => {
      const model = new ScriptedModel([
        modelResponse(TEST_MODEL_RESPONSE_BASIC),
      ]);
      const getResponse = vi.spyOn(model, 'getResponse');
      const agent = new Agent({ name: 'Invalid policy agent', model });

      await expect(
        new Runner().run(agent, 'hello', {
          toolNameCollisionPolicy: 'invalid' as ToolNameCollisionPolicy,
        }),
      ).rejects.toThrow(
        'toolNameCollisionPolicy must be either "warn" or "error".',
      );
      expect(getResponse).not.toHaveBeenCalled();
    });

    it('rejects a null per-run tool name collision policy before model calls', async () => {
      const model = new ScriptedModel([
        modelResponse(TEST_MODEL_RESPONSE_BASIC),
      ]);
      const getResponse = vi.spyOn(model, 'getResponse');
      const agent = new Agent({ name: 'Null policy agent', model });

      await expect(
        new Runner().run(agent, 'hello', {
          toolNameCollisionPolicy: null as any,
        }),
      ).rejects.toThrow(
        'toolNameCollisionPolicy must be either "warn" or "error".',
      );
      expect(getResponse).not.toHaveBeenCalled();
    });

    it('keeps the default provider lazy until a string model needs it', async () => {
      const model = new ScriptedModel([
        modelResponse(TEST_MODEL_RESPONSE_BASIC),
      ]);
      const provider = {
        getModel: vi.fn(() => model),
      } satisfies ModelProvider;
      setDefaultModelProvider(provider);

      try {
        const runner = new Runner({
          model: 'default-model',
          tracingDisabled: true,
        });

        expect(provider.getModel).not.toHaveBeenCalled();

        await runner.run(new Agent({ name: 'Lazy Provider Agent' }), 'hello');

        expect(provider.getModel).toHaveBeenCalledWith('default-model');
      } finally {
        setDefaultModelProvider(new ScriptedModelProvider());
      }
    });

    it("keeps a runner's resolved default provider stable", async () => {
      const firstProvider = {
        getModel: vi.fn(
          () =>
            new ScriptedModel([
              modelResponse({ ...TEST_MODEL_RESPONSE_BASIC }),
            ]),
        ),
      } satisfies ModelProvider;
      const laterProvider = {
        getModel: vi.fn(
          () =>
            new ScriptedModel([
              modelResponse({ ...TEST_MODEL_RESPONSE_BASIC }),
            ]),
        ),
      } satisfies ModelProvider;
      setDefaultModelProvider(firstProvider);

      try {
        const runner = new Runner({
          model: 'default-model',
          tracingDisabled: true,
        });

        await runner.run(new Agent({ name: 'Stable Provider Agent' }), 'hello');
        setDefaultModelProvider(laterProvider);
        await runner.run(new Agent({ name: 'Stable Provider Agent' }), 'hello');

        expect(firstProvider.getModel).toHaveBeenCalledTimes(2);
        expect(laterProvider.getModel).not.toHaveBeenCalled();
      } finally {
        setDefaultModelProvider(new ScriptedModelProvider());
      }
    });

    it('does not require a modelProvider when the selected model is a Model object', async () => {
      const model = new ScriptedModel([
        modelResponse(TEST_MODEL_RESPONSE_BASIC),
      ]);
      const provider = {
        getModel: vi.fn(() => {
          throw new Error('default provider should not be used');
        }),
      } satisfies ModelProvider;
      setDefaultModelProvider(provider);

      try {
        const runner = new Runner({
          model,
          tracingDisabled: true,
        });

        await runner.run(new Agent({ name: 'Model Object Agent' }), 'hello');

        expect(provider.getModel).not.toHaveBeenCalled();
      } finally {
        setDefaultModelProvider(new ScriptedModelProvider());
      }
    });

    it('rejects invalid function tool concurrency config', () => {
      expect(
        () =>
          new Runner({
            tracingDisabled: true,
            toolExecution: { maxFunctionToolConcurrency: 0 },
          }),
      ).toThrow(UserError);
      expect(
        () =>
          new Runner({
            tracingDisabled: true,
            toolExecution: { maxFunctionToolConcurrency: 1.5 },
          }),
      ).toThrow(
        'toolExecution.maxFunctionToolConcurrency must be an integer greater than or equal to 1.',
      );
    });

    it('rejects invalid pre-approval input guardrail config', () => {
      expect(
        () =>
          new Runner({
            tracingDisabled: true,
            toolExecution: { preApprovalInputGuardrails: 'yes' as any },
          }),
      ).toThrow(
        'toolExecution.preApprovalInputGuardrails must be a boolean when provided.',
      );
    });

    it('returns missing function tool errors to the model when opted in', async () => {
      class RecordingModel extends ScriptedModel {
        get requests(): readonly Readonly<ModelRequest>[] {
          return this.calls.map((call) => call.request);
        }
      }

      const model = new RecordingModel([
        modelResponse({
          output: [
            {
              ...TEST_MODEL_FUNCTION_CALL,
              name: 'missing_tool',
              callId: 'call_missing',
              arguments: '{}',
            },
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [fakeModelMessage('recovered')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'MissingToolAgent',
        model,
        modelSettings: { toolChoice: 'required' },
        toolUseBehavior: 'run_llm_again',
      });

      const result = await run(agent, 'start', {
        toolNotFoundBehavior: 'return_error_to_model',
      });

      expect(result.finalOutput).toBe('recovered');
      expect(model.requests).toHaveLength(2);
      expect(model.requests[0].modelSettings.toolChoice).toBe('required');
      expect(model.requests[1].modelSettings.toolChoice).toBeUndefined();
      const secondInput = model.requests[1].input as AgentInputItem[];
      expect(secondInput).toContainEqual({
        type: 'function_call_result',
        name: 'missing_tool',
        callId: 'call_missing',
        status: 'completed',
        output: {
          type: 'text',
          text: "Tool 'missing_tool' not found.",
        },
      });
    });

    it('uses toolErrorFormatter for missing function tool errors', async () => {
      class RecordingModel extends ScriptedModel {
        get requests(): readonly Readonly<ModelRequest>[] {
          return this.calls.map((call) => call.request);
        }
      }

      const model = new RecordingModel([
        modelResponse({
          output: [
            {
              ...TEST_MODEL_FUNCTION_CALL,
              name: 'missing_tool',
              callId: 'call_missing',
              arguments: '{}',
            },
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [fakeModelMessage('formatter recovered')],
          usage: new Usage(),
        }),
      ]);
      const seenKinds: string[] = [];
      const agent = new Agent({
        name: 'MissingToolFormatterAgent',
        model,
        toolUseBehavior: 'run_llm_again',
      });

      const result = await run(agent, 'start', {
        toolNotFoundBehavior: 'return_error_to_model',
        toolErrorFormatter: (args) => {
          seenKinds.push(args.kind);
          if (args.kind !== 'tool_not_found') {
            return undefined;
          }
          return `${args.toolName} unavailable for ${args.callId}`;
        },
      });

      expect(result.finalOutput).toBe('formatter recovered');
      expect(seenKinds).toEqual(['tool_not_found']);
      const secondInput = model.requests[1].input as AgentInputItem[];
      expect(secondInput).toContainEqual({
        type: 'function_call_result',
        name: 'missing_tool',
        callId: 'call_missing',
        status: 'completed',
        output: {
          type: 'text',
          text: 'missing_tool unavailable for call_missing',
        },
      });
    });

    it('redacts hostile tool-not-found formatter errors and keeps the fallback result', async () => {
      class RecordingModel extends ScriptedModel {
        get requests(): readonly Readonly<ModelRequest>[] {
          return this.calls.map((call) => call.request);
        }
      }

      const model = new RecordingModel([
        modelResponse({
          output: [
            {
              ...TEST_MODEL_FUNCTION_CALL,
              name: 'missing_tool',
              callId: 'call_missing',
              arguments: '{}',
            },
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [fakeModelMessage('formatter fallback recovered')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'MissingToolFormatterFallbackAgent',
        model,
        toolUseBehavior: 'run_llm_again',
      });
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      vi.spyOn(logger, 'dontLogToolData', 'get').mockReturnValue(true);
      const hostileError = new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error('SECRET_TOOL_NOT_FOUND_FORMATTER_123');
          },
        },
      );

      const result = await run(agent, 'start', {
        toolNotFoundBehavior: 'return_error_to_model',
        toolErrorFormatter: () => {
          throw hostileError;
        },
      });

      expect(result.finalOutput).toBe('formatter fallback recovered');
      expect(warnSpy).toHaveBeenCalledWith(
        'toolErrorFormatter threw while formatting tool not found:',
        'object',
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(
        'SECRET_TOOL_NOT_FOUND_FORMATTER_123',
      );
      const secondInput = model.requests[1].input as AgentInputItem[];
      expect(secondInput).toContainEqual({
        type: 'function_call_result',
        name: 'missing_tool',
        callId: 'call_missing',
        status: 'completed',
        output: {
          type: 'text',
          text: "Tool 'missing_tool' not found.",
        },
      });
    });

    it('does not persist nested agent-tool metadata when resuming a RunState', async () => {
      const agent = new Agent({
        name: 'ReusedNestedStateAgent',
        instructions: 'Finish the run.',
        model: new ScriptedModel([modelResponse(TEST_MODEL_RESPONSE_BASIC)]),
      });
      const nestedState = new RunState(new RunContext(), 'input', agent, 1);
      nestedState._agentToolInvocation = {
        toolName: 'nested_tool',
        toolCallId: 'call-outer',
        toolArguments: '{"input":"hello"}',
      };
      const restoredState = await RunState.fromString(
        agent,
        nestedState.toString(),
      );

      const result = await new Runner().run(agent, restoredState);

      expect(result.agentToolInvocation).toBeUndefined();
      expect(restoredState._agentToolInvocation).toBeUndefined();
      expect(restoredState.toJSON()).not.toHaveProperty('agentToolInvocation');
    });

    it('clears stale agent-tool metadata when reusing an in-memory RunState', async () => {
      const agent = new Agent({
        name: 'ReusedInMemoryNestedStateAgent',
        instructions: 'Finish the run.',
        model: new ScriptedModel([modelResponse(TEST_MODEL_RESPONSE_BASIC)]),
      });
      const nestedState = new RunState(new RunContext(), 'input', agent, 1);
      nestedState._agentToolInvocation = {
        toolName: 'nested_tool',
        toolCallId: 'call-outer',
        toolArguments: '{"input":"hello"}',
      };

      const result = await new Runner().run(agent, nestedState);

      expect(result.agentToolInvocation).toBeUndefined();
      expect(nestedState._agentToolInvocation).toBeUndefined();
    });

    function buildRejectedToolRunState(
      agent: Agent<any, any>,
      rejectMessage?: string,
    ) {
      const rawItem = {
        name: 'toolZ',
        callId: 'c1',
        type: 'function_call',
        arguments: '{}',
      } as any;
      const approvalItem = new ToolApprovalItem(rawItem, agent);
      const state = new RunState(new RunContext(), '', agent, 1);
      state._currentStep = {
        type: 'next_step_interruption',
        data: { interruptions: [approvalItem] },
      };
      state.reject(
        approvalItem,
        rejectMessage !== undefined ? { message: rejectMessage } : undefined,
      );
      state._generatedItems.push(approvalItem);
      state._lastTurnResponse = {
        output: [],
        usage: {
          requests: 1,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        responseId: 'abc',
      } as any;
      state._lastProcessedResponse = {
        newItems: [],
        functions: [
          {
            toolCall: rawItem,
            tool: {
              name: 'toolZ',
              invoke: async () => 'wrong path',
              needsApproval: async () => true,
            },
          },
        ],
        handoffs: [],
        mcpApprovalRequests: [],
        computerActions: [],
      } as any;
      return { state };
    }

    it('should run a basic agent', async () => {
      const agent = new Agent({
        name: 'Test',
      });

      const result = await run(agent, 'Hello');

      expect(result.finalOutput).toBe('Hello World');
      expectTypeOf(result.finalOutput).toEqualTypeOf<string | undefined>();
    });

    it('rejects custom client tool_search parameters without execute before calling the model', async () => {
      const model = new ScriptedModel([
        modelResponse(TEST_MODEL_RESPONSE_BASIC),
      ]);
      const agent = new Agent({
        name: 'ClientToolSearchValidationAgent',
        model,
        tools: [
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: {
              type: 'tool_search',
              execution: 'client',
              parameters: {
                type: 'object',
                properties: {
                  namespaceHints: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
                required: ['namespaceHints'],
                additionalProperties: false,
              },
            },
          } as any,
        ],
      });

      const runPromise = new Runner().run(agent, 'hello');

      await expect(runPromise).rejects.toThrow(UserError);
      await expect(runPromise).rejects.toThrow(
        /require toolSearchTool\(\{ execution: "client", execute \}\)/,
      );
      expect(model.calls).toHaveLength(0);
    });

    it('loads runtime tools from custom client tool_search execute callbacks across turns', async () => {
      const lookupAccount = tool({
        name: 'lookup_account',
        description: 'Look up an account in CRM.',
        parameters: z.object({
          accountId: z.string(),
        }),
        execute: async ({ accountId }) => `account:${accountId}`,
      });
      const execute = vi.fn().mockResolvedValue(lookupAccount);
      const toolSearch = attachClientToolSearchExecutor(
        {
          type: 'hosted_tool',
          name: 'tool_search',
          providerData: {
            type: 'tool_search',
            execution: 'client',
            parameters: {
              type: 'object',
              properties: {
                namespaceHints: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
              required: ['namespaceHints'],
              additionalProperties: false,
            },
          },
        },
        execute,
      );
      const model = new ScriptedModel([
        modelResponse({
          output: [
            {
              type: 'tool_search_call',
              id: 'ts_call_lookup',
              status: 'completed',
              arguments: {
                namespaceHints: ['crm'],
              },
              providerData: {
                call_id: 'call_tool_search_lookup',
              },
            } as protocol.ToolSearchCallItem,
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [
            {
              type: 'function_call',
              id: 'fc_lookup_account',
              callId: 'call_lookup_account',
              name: 'lookup_account',
              status: 'completed',
              arguments: JSON.stringify({ accountId: 'acct_42' }),
            } as protocol.FunctionCallItem,
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [fakeModelMessage('Account loaded.')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'CustomClientToolSearchAgent',
        model,
        tools: [toolSearch],
      });
      const state = new RunState(new RunContext(), 'hello', agent, 10);

      const result = await new Runner().run(agent, state);

      expect(result.finalOutput).toBe('Account loaded.');
      expect(execute).toHaveBeenCalledTimes(1);
      const executeArgs = execute.mock.calls[0]?.[0];
      expect(executeArgs?.agent).toBe(agent);
      expect(executeArgs?.availableTools).toEqual([toolSearch]);
      expect(executeArgs?.runContext).toBe(state._context);
      expect(executeArgs?.toolCall).toMatchObject({
        type: 'tool_search_call',
        arguments: {
          namespaceHints: ['crm'],
        },
      });
      expect(executeArgs?.loadDefault).toEqual(expect.any(Function));
      expect(state.getToolSearchRuntimeTools(agent)).toEqual([lookupAccount]);
      expect(executeArgs?.loadDefault(['missing_tool'])).toEqual([]);
    });

    it('rehydrates custom client tool_search runtime tools after RunState serialization', async () => {
      const lookupAccount = tool({
        name: 'lookup_account',
        description: 'Look up an account in CRM.',
        parameters: z.object({
          accountId: z.string(),
        }),
        execute: async ({ accountId }) => `account:${accountId}`,
      });
      const execute = vi.fn().mockResolvedValue(lookupAccount);
      const toolSearch = attachClientToolSearchExecutor(
        {
          type: 'hosted_tool',
          name: 'tool_search',
          providerData: {
            type: 'tool_search',
            execution: 'client',
            parameters: {
              type: 'object',
              properties: {
                namespaceHints: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
              required: ['namespaceHints'],
              additionalProperties: false,
            },
          },
        },
        execute,
      );
      const model = new ScriptedModel([
        modelResponse({
          output: [
            {
              type: 'tool_search_call',
              id: 'ts_call_lookup',
              status: 'completed',
              arguments: {
                namespaceHints: ['crm'],
              },
              providerData: {
                call_id: 'call_tool_search_lookup',
              },
            } as protocol.ToolSearchCallItem,
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [
            {
              type: 'function_call',
              id: 'fc_lookup_account',
              callId: 'call_lookup_account',
              name: 'lookup_account',
              status: 'completed',
              arguments: JSON.stringify({ accountId: 'acct_42' }),
            } as protocol.FunctionCallItem,
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [fakeModelMessage('Account loaded.')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'SerializedCustomClientToolSearchAgent',
        model,
        tools: [toolSearch],
      });
      const initialError = await run(agent, 'hello', { maxTurns: 1 }).catch(
        (error) => error,
      );

      expect(initialError).toBeInstanceOf(MaxTurnsExceededError);
      const state = (initialError as MaxTurnsExceededError).state as RunState<
        unknown,
        Agent<any, any>
      >;
      expect(execute).toHaveBeenCalledTimes(1);
      expect(state.getToolSearchRuntimeTools(agent)).toEqual([lookupAccount]);

      const restored = await RunState.fromString(agent, state.toString());
      restored._maxTurns = 10;

      expect(execute).toHaveBeenCalledTimes(2);
      expect(restored.getToolSearchRuntimeTools(agent)).toEqual([
        lookupAccount,
      ]);

      const resumedResult = await run(agent, restored);

      expect(resumedResult.finalOutput).toBe('Account loaded.');
      expect(execute).toHaveBeenCalledTimes(2);
      expect(resumedResult.history).toContainEqual(
        expect.objectContaining({
          type: 'function_call',
          name: 'lookup_account',
        }),
      );
    });

    it('fails early when custom client tool_search runtime tools are resumed without an executor', async () => {
      const toolSearch = {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: {
          type: 'tool_search',
          execution: 'client',
          parameters: {
            type: 'object',
            properties: {
              namespaceHints: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['namespaceHints'],
            additionalProperties: false,
          },
        },
      } as const;
      const agent = new Agent({
        name: 'MissingExecutorToolSearchAgent',
        model: new ScriptedModel(),
        tools: [toolSearch as any],
      });
      const state = new RunState(new RunContext(), 'hello', agent, 10);
      state._generatedItems.push(
        new RunToolSearchCallItem(
          {
            type: 'tool_search_call',
            id: 'ts_call_lookup',
            status: 'completed',
            arguments: {
              namespaceHints: ['crm'],
            },
            providerData: {
              call_id: 'call_tool_search_lookup',
              execution: 'client',
            },
          } as protocol.ToolSearchCallItem,
          agent,
        ),
        new RunToolSearchOutputItem(
          {
            type: 'tool_search_output',
            status: 'completed',
            tools: [
              {
                type: 'function',
                name: 'lookup_account',
                description: 'Look up an account in CRM.',
                strict: true,
                parameters: {
                  type: 'object',
                  properties: {
                    accountId: {
                      type: 'string',
                    },
                  },
                  required: ['accountId'],
                  additionalProperties: false,
                },
              },
            ],
            providerData: {
              call_id: 'call_tool_search_lookup',
              execution: 'client',
            },
          } as protocol.ToolSearchOutputItem,
          agent,
        ),
      );

      await expect(() =>
        RunState.fromString(agent, state.toString()),
      ).rejects.toThrow(
        /require toolSearchTool\(\{ execution: "client", execute \}\) when custom client tool_search parameters are provided/,
      );
    });

    it('does not require rehydration for built-in client tool_search outputs that match configured deferred tools', async () => {
      const getShippingEta = tool({
        name: 'get_shipping_eta',
        description: 'Look up a shipping ETA.',
        parameters: z.object({
          trackingNumber: z.string(),
        }),
        deferLoading: true,
        execute: async () => 'tomorrow',
      });
      const agent = new Agent({
        name: 'BuiltInClientToolSearchResumeAgent',
        model: new ScriptedModel(),
        tools: [getShippingEta],
      });
      const state = new RunState(new RunContext(), 'hello', agent, 10);
      state._generatedItems.push(
        new RunToolSearchCallItem(
          {
            type: 'tool_search_call',
            id: 'ts_call_shipping',
            status: 'completed',
            arguments: {
              paths: ['get_shipping_eta'],
            },
            providerData: {
              call_id: 'call_tool_search_shipping',
              execution: 'client',
            },
          } as protocol.ToolSearchCallItem,
          agent,
        ),
        new RunToolSearchOutputItem(
          {
            type: 'tool_search_output',
            status: 'completed',
            tools: [
              {
                type: 'function',
                name: 'get_shipping_eta',
                description: 'Look up a shipping ETA.',
                strict: true,
                deferLoading: true,
                parameters: {
                  type: 'object',
                  properties: {
                    trackingNumber: {
                      type: 'string',
                    },
                  },
                  required: ['trackingNumber'],
                  additionalProperties: false,
                },
              },
            ],
            providerData: {
              call_id: 'call_tool_search_shipping',
              execution: 'client',
            },
          } as protocol.ToolSearchOutputItem,
          agent,
        ),
      );

      const restored = await RunState.fromString(agent, state.toString());

      expect(restored.getToolSearchRuntimeTools(agent)).toEqual([]);
    });

    it('treats prior tool_search outputs in input history as loaded deferred tools', async () => {
      const getShippingEta = tool({
        name: 'get_shipping_eta',
        description: 'Look up a shipping ETA.',
        parameters: z.object({
          trackingNumber: z.string(),
        }),
        deferLoading: true,
        execute: async () => 'tomorrow',
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [
            {
              type: 'function_call',
              id: 'fc_shipping_eta',
              callId: 'call_shipping_eta',
              name: 'get_shipping_eta',
              status: 'completed',
              arguments: JSON.stringify({ trackingNumber: 'ZX-123' }),
            } as protocol.FunctionCallItem,
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [fakeModelMessage('The package arrives tomorrow.')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'ShippingAgent',
        instructions: 'Use the tool when it is available.',
        model,
        tools: [getShippingEta],
        toolUseBehavior: 'run_llm_again',
      });
      const inputHistory: AgentInputItem[] = [
        user('Load shipping tools first.'),
        {
          type: 'tool_search_output',
          status: 'completed',
          tools: [
            {
              type: 'tool_reference',
              functionName: 'get_shipping_eta',
            },
          ],
        } as any,
      ];

      const result = await run(agent, inputHistory);

      expect(result.finalOutput).toBe('The package arrives tomorrow.');
      expect(result.history).toContainEqual(
        expect.objectContaining({
          type: 'function_call',
          name: 'get_shipping_eta',
        }),
      );
    });

    it('exposes aggregated usage on run results', async () => {
      const model = new ScriptedModel([
        modelResponse({
          output: [fakeModelMessage('hi there')],
          usage: new Usage({
            requests: 1,
            inputTokens: 2,
            outputTokens: 3,
            totalTokens: 5,
          }),
          responseId: 'usage-res',
        }),
      ]);
      const agent = new Agent({
        name: 'UsageAgent',
        model,
      });

      const result = await run(agent, 'ping');

      expect(result.state.usage.inputTokens).toBe(2);
      expect(result.state.usage.outputTokens).toBe(3);
      expect(result.state.usage.totalTokens).toBe(5);
      expect(result.state.usage.requestUsageEntries).toEqual([
        {
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
          inputTokensDetails: {},
          outputTokensDetails: {},
        },
      ]);
    });

    it('emits turn input on agent_start lifecycle hooks', async () => {
      const model = new ScriptedModel([
        modelResponse({
          output: [fakeModelMessage('Acknowledged')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'LifecycleInputAgent',
        model,
      });
      const runner = new Runner();

      const agentInputs: AgentInputItem[][] = [];
      const runnerInputs: AgentInputItem[][] = [];

      agent.on('agent_start', (_context, _agent, turnInput) => {
        agentInputs.push(turnInput ?? []);
      });
      runner.on('agent_start', (_context, _agent, turnInput) => {
        runnerInputs.push(turnInput ?? []);
      });

      await runner.run(agent, 'capture this input for tracing');

      expect(agentInputs).toHaveLength(1);
      expect(runnerInputs).toHaveLength(1);
      expect(agentInputs[0].map(getFirstTextContent)).toEqual([
        'capture this input for tracing',
      ]);
      expect(runnerInputs[0].map(getFirstTextContent)).toEqual([
        'capture this input for tracing',
      ]);
    });

    it('applies toolChoice updates from agent_tool_end before the next model call', async () => {
      class ToolChoiceTrackingModel extends ScriptedModel {
        constructor() {
          super([
            modelResponse({
              output: [
                {
                  ...TEST_MODEL_FUNCTION_CALL,
                  id: 'tool-call-1',
                  callId: 'tool-call-1',
                  name: 'test',
                  arguments: '{"test":"first"}',
                },
              ],
              usage: new Usage(),
            }),
            modelResponse({
              output: [fakeModelMessage('finished')],
              usage: new Usage(),
            }),
          ]);
        }

        get requests(): readonly ModelRequest[] {
          return this.calls.map((call) => call.request);
        }
      }

      const model = new ToolChoiceTrackingModel();
      const agent = new Agent({
        name: 'ToolChoiceLifecycleAgent',
        model,
        tools: [TEST_TOOL],
        modelSettings: { toolChoice: 'required' },
      });

      agent.on('agent_tool_end', () => {
        agent.modelSettings.toolChoice = 'none';
      });

      const result = await run(agent, 'trigger tool');

      expect(result.finalOutput).toBe('finished');
      expect(model.requests).toHaveLength(2);
      expect(model.requests[0]?.modelSettings.toolChoice).toBe('required');
      expect(model.requests[1]?.modelSettings.toolChoice).toBe('none');
    });

    it('continues Programmatic Tool Calling through nested calls and program output', async () => {
      class ProgrammaticToolCallingModel extends ScriptedModel {
        constructor() {
          super([
            modelResponse({
              output: [
                {
                  type: 'program',
                  id: 'prog_1',
                  callId: 'call_prog_1',
                  code: 'const values = await Promise.all([tools.lookup({key:"a"}), tools.lookup({key:"b"})]); text(JSON.stringify(values));',
                  fingerprint: 'fp_1',
                },
                {
                  type: 'function_call',
                  id: 'fc_1',
                  callId: 'call_1',
                  name: 'lookup',
                  arguments: '{"key":"a"}',
                  caller: { type: 'program', callerId: 'call_prog_1' },
                },
                {
                  type: 'function_call',
                  id: 'fc_2',
                  callId: 'call_2',
                  name: 'lookup',
                  arguments: '{"key":"b"}',
                  caller: { type: 'program', callerId: 'call_prog_1' },
                },
              ],
              usage: new Usage(),
            }),
            modelResponse({
              output: [
                {
                  type: 'program_output',
                  id: 'prog_out_1',
                  callId: 'call_prog_1',
                  output: '[{"key":"a"},{"key":"b"}]',
                  status: 'completed',
                },
              ],
              usage: new Usage(),
            }),
            modelResponse({
              output: [fakeModelMessage('Program completed.')],
              usage: new Usage(),
            }),
          ]);
        }

        get requests(): readonly ModelRequest[] {
          return this.calls.map((call) => call.request);
        }
      }

      const model = new ProgrammaticToolCallingModel();
      const lookup = tool({
        name: 'lookup',
        description: 'Return the requested key.',
        parameters: z.object({ key: z.string() }),
        allowedCallers: ['programmatic'],
        outputSchema: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
          additionalProperties: false,
        },
        execute: async ({ key }) => ({ key }),
      });
      const agent = new Agent({
        name: 'ProgramAgent',
        model,
        tools: [lookup, PROGRAMMATIC_TOOL_CALLING_TOOL],
        toolUseBehavior: 'stop_on_first_tool',
        modelSettings: { toolChoice: 'programmatic_tool_calling' },
      });

      const result = await run(agent, 'Run the program.');

      expect(result.finalOutput).toBe('Program completed.');
      expect(model.requests).toHaveLength(3);
      expect(model.requests[0]?.modelSettings.toolChoice).toBe(
        'programmatic_tool_calling',
      );
      expect(model.requests[1]?.modelSettings.toolChoice).toBeUndefined();
      const secondInput = model.requests[1]?.input as AgentInputItem[];
      expect(secondInput.map((item) => item.type)).toEqual([
        'message',
        'program',
        'function_call',
        'function_call',
        'function_call_result',
        'function_call_result',
      ]);
      expect(
        secondInput
          .filter((item) => item.type === 'function_call_result')
          .map((item) => item.caller),
      ).toEqual([
        { type: 'program', callerId: 'call_prog_1' },
        { type: 'program', callerId: 'call_prog_1' },
      ]);
      const thirdInput = model.requests[2]?.input as AgentInputItem[];
      expect(thirdInput.at(-1)).toMatchObject({
        type: 'program_output',
        callId: 'call_prog_1',
        output: '[{"key":"a"},{"key":"b"}]',
      });
    });

    it('accepts Programmatic Tool Calling supplied by a prompt template', async () => {
      const lookup = tool({
        name: 'prompt_lookup',
        description: 'Return the requested key.',
        parameters: z.object({ key: z.string() }),
        allowedCallers: ['programmatic'],
        outputSchema: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
          additionalProperties: false,
        },
        execute: async ({ key }) => ({ key }),
      });
      const agent = new Agent({
        name: 'PromptProgramAgent',
        model: new ScriptedModel([
          modelResponse({
            output: [
              {
                type: 'program',
                id: 'prog_prompt_supplied',
                callId: 'call_prog_prompt_supplied',
                code: 'text(await tools.prompt_lookup({key:"prompt"}))',
                fingerprint: 'fp_prompt_supplied',
              },
              {
                type: 'function_call',
                id: 'fc_prompt_supplied',
                callId: 'call_prompt_lookup',
                name: 'prompt_lookup',
                arguments: '{"key":"prompt"}',
                caller: {
                  type: 'program',
                  callerId: 'call_prog_prompt_supplied',
                },
              },
            ],
            usage: new Usage(),
          }),
          modelResponse({
            output: [
              {
                type: 'program_output',
                id: 'prog_out_prompt_supplied',
                callId: 'call_prog_prompt_supplied',
                output: '{"key":"prompt"}',
                status: 'completed',
              },
              fakeModelMessage('Prompt program completed.'),
            ],
            usage: new Usage(),
          }),
        ]),
        prompt: { promptId: 'pmpt_programmatic_tool_calling' },
        tools: [lookup],
      });

      const result = await run(agent, 'Run the prompt program.');

      expect(result.finalOutput).toBe('Prompt program completed.');
      expect(result.newItems.map((item) => item.rawItem.type)).toEqual([
        'program',
        'function_call',
        'function_call_result',
        'program_output',
        'message',
      ]);
    });

    it('rejects prompt-supplied Programmatic Tool Calling when tools are explicitly disabled', async () => {
      const agent = new Agent({
        name: 'PromptProgramAgent',
        model: new ScriptedModel([
          modelResponse({
            output: [
              {
                type: 'program',
                id: 'prog_prompt_disabled',
                callId: 'call_prog_prompt_disabled',
                code: 'text("blocked")',
                fingerprint: 'fp_prompt_disabled',
              },
            ],
            usage: new Usage(),
          }),
        ]),
        prompt: { promptId: 'pmpt_programmatic_tool_calling' },
        tools: [],
      });

      await expect(run(agent, 'Run the prompt program.')).rejects.toThrow(
        /without programmaticToolCallingTool\(\)/,
      );
    });

    it('sholuld handle structured output', async () => {
      const fakeModel = new ScriptedModel([
        modelResponse({
          ...TEST_MODEL_RESPONSE_BASIC,
          output: [fakeModelMessage('{"city": "San Francisco"}')],
        }),
      ]);

      const runner = new Runner();
      const agent = new Agent({
        name: 'Test',
        model: fakeModel,
        outputType: z.object({
          city: z.string(),
        }),
      });

      const result = await runner.run(
        agent,
        'What is the weather in San Francisco?',
      );

      expect(result.finalOutput).toEqual({ city: 'San Francisco' });
      expectTypeOf(result.finalOutput).toEqualTypeOf<
        { city: string } | undefined
      >();
    });

    it('returns static final output when tool execution is rejected', async () => {
      const agent = new Agent({
        name: 'RejectTest',
        toolUseBehavior: 'stop_on_first_tool',
      });
      const { state } = buildRejectedToolRunState(agent);

      const result = await run(agent, state);

      expect(result.finalOutput).toBe('Tool execution was not approved.');
    });

    it('uses toolErrorFormatter for static final output when tool execution is rejected', async () => {
      const agent = new Agent({
        name: 'RejectTest',
        toolUseBehavior: 'stop_on_first_tool',
      });
      const { state } = buildRejectedToolRunState(agent);
      const runner = new Runner({
        toolErrorFormatter: () =>
          'Tool execution was dismissed. You may retry this tool later.',
      });

      const result = await runner.run(agent, state);

      expect(result.finalOutput).toBe(
        'Tool execution was dismissed. You may retry this tool later.',
      );
    });

    it('prefers per-run toolErrorFormatter over runner config', async () => {
      const agent = new Agent({
        name: 'RejectTest',
        toolUseBehavior: 'stop_on_first_tool',
      });
      const { state } = buildRejectedToolRunState(agent);
      const runner = new Runner({
        toolErrorFormatter: () => 'runner default rejection',
      });

      const result = await runner.run(agent, state, {
        toolErrorFormatter: () => 'per-run rejection',
      });

      expect(result.finalOutput).toBe('per-run rejection');
    });

    it('uses reject message as final output when provided', async () => {
      const agent = new Agent({
        name: 'RejectTest',
        toolUseBehavior: 'stop_on_first_tool',
      });
      const { state } = buildRejectedToolRunState(
        agent,
        'Tool execution was dismissed. You may retry this tool later.',
      );

      const result = await run(agent, state);

      expect(result.finalOutput).toBe(
        'Tool execution was dismissed. You may retry this tool later.',
      );
    });

    it('reject message takes precedence over toolErrorFormatter', async () => {
      const agent = new Agent({
        name: 'RejectTest',
        toolUseBehavior: 'stop_on_first_tool',
      });
      const { state } = buildRejectedToolRunState(
        agent,
        'per-call rejection message',
      );
      const runner = new Runner({
        toolErrorFormatter: () => 'formatter rejection',
      });

      const result = await runner.run(agent, state);

      expect(result.finalOutput).toBe('per-call rejection message');
    });

    it('reject message preserves an empty string', async () => {
      const agent = new Agent({
        name: 'RejectTest',
        toolUseBehavior: 'stop_on_first_tool',
      });
      const { state } = buildRejectedToolRunState(agent, '');
      const runner = new Runner({
        toolErrorFormatter: () => 'formatter rejection',
      });

      const result = await runner.run(agent, state);

      expect(result.finalOutput).toBe('');
    });

    it('propagates model errors', async () => {
      const agent = new Agent({
        name: 'Fail',
        model: new ScriptedModel([
          modelError(new Error('Scripted model failure')),
        ]),
      });

      await expect(run(agent, 'fail')).rejects.toThrow(
        'Scripted model failure',
      );
    });

    it('sets overridePromptModel when agent supplies a prompt and explicit model', async () => {
      class CapturingModel extends ScriptedModel {
        constructor() {
          super([
            modelResponse({
              output: [fakeModelMessage('override')],
              usage: new Usage(),
            }),
          ]);
        }

        get lastRequest(): Readonly<ModelRequest> | undefined {
          return this.lastCall?.request;
        }
      }

      const capturingModel = new CapturingModel();

      const agent = new Agent({
        name: 'Prompted',
        instructions: 'Use the prompt.',
        model: capturingModel,
        prompt: { promptId: 'prompt_123' },
      });

      await run(agent, 'hello');

      expect(capturingModel.lastRequest?.prompt).toBeDefined();
      expect(capturingModel.lastRequest?.overridePromptModel).toBe(true);
    });

    it('serializes GA computer tools without requiring display metadata', async () => {
      class CapturingModel extends ScriptedModel {
        constructor() {
          super([
            modelResponse({
              output: [fakeModelMessage('computer ok')],
              usage: new Usage(),
            }),
          ]);
        }

        get lastRequest(): Readonly<ModelRequest> | undefined {
          return this.lastCall?.request;
        }
      }

      const capturingModel = new CapturingModel();
      const agent = new Agent({
        name: 'ComputerPrompted',
        model: capturingModel,
        tools: [
          computerTool({
            computer: {
              screenshot: async () => 'img',
              click: async () => {},
              doubleClick: async () => {},
              drag: async () => {},
              keypress: async () => {},
              move: async () => {},
              scroll: async () => {},
              type: async () => {},
              wait: async () => {},
            } as any,
          }),
        ],
      });

      const result = await run(agent, 'hello');

      expect(result.finalOutput).toBe('computer ok');
      expect(capturingModel.lastRequest?.tools).toEqual([
        {
          type: 'computer',
          name: 'computer_use_preview',
        },
      ]);
    });

    it('emits agent_end lifecycle event for non-streaming agents', async () => {
      const agent = new Agent({
        name: 'TestAgent',
      });

      // Track agent_end events on both the agent and runner
      const agentEndEvents: Array<{ context: any; output: string }> = [];
      const runnerEndEvents: Array<{
        context: any;
        agent: any;
        output: string;
      }> = [];

      agent.on('agent_end', (context, output) => {
        agentEndEvents.push({ context, output });
      });

      const runner = new Runner();
      runner.on('agent_end', (context, agent, output) => {
        runnerEndEvents.push({ context, agent, output });
      });

      const result = await runner.run(agent, 'test input');

      // Verify the result has the expected output
      expect(result.finalOutput).toBe('Hello World');

      // Verify agent_end was called on both agent and runner
      expect(agentEndEvents).toHaveLength(1);
      expect(agentEndEvents[0].output).toBe('Hello World');

      expect(runnerEndEvents).toHaveLength(1);
      expect(runnerEndEvents[0].agent).toBe(agent);
      expect(runnerEndEvents[0].output).toBe('Hello World');
    });

    it('emits agent_end once when final output comes from tool results', async () => {
      const model = new ScriptedModel([
        modelResponse({
          output: [{ ...TEST_MODEL_FUNCTION_CALL }],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'ToolAgent',
        model,
        tools: [TEST_TOOL],
        toolUseBehavior: 'stop_on_first_tool',
      });

      const agentEndEvents: Array<{ context: any; output: string }> = [];
      const runnerEndEvents: Array<{
        context: any;
        agent: any;
        output: string;
      }> = [];

      agent.on('agent_end', (context, output) => {
        agentEndEvents.push({ context, output });
      });

      const runner = new Runner();
      runner.on('agent_end', (context, endAgent, output) => {
        runnerEndEvents.push({ context, agent: endAgent, output });
      });

      const result = await runner.run(agent, 'trigger tool');

      expect(result.finalOutput).toBe('Hello World');
      expect(agentEndEvents).toHaveLength(1);
      expect(agentEndEvents[0].output).toBe('Hello World');
      expect(runnerEndEvents).toHaveLength(1);
      expect(runnerEndEvents[0].agent).toBe(agent);
      expect(runnerEndEvents[0].output).toBe('Hello World');
    });

    it('disposes computer lifecycle initializers after a completed run', async () => {
      const createdComputer = new FakeComputer();
      const create = vi.fn(async () => createdComputer);
      const dispose = vi.fn(async () => {});
      const computer = computerTool({
        computer: { create, dispose },
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [fakeModelMessage('done')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'ComputerAgent',
        model,
        tools: [computer],
      });

      const result = await run(agent, 'hello');

      expect(result.finalOutput).toBe('done');
      expect(create).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledWith({
        runContext: result.state._context,
        computer: createdComputer,
      });
    });

    it('calls initRun once per run and skips reinitializing on resume', async () => {
      const computerInstance = new FakeComputer() as FakeComputer & {
        initRun?: (ctx?: RunContext) => Promise<void>;
      };
      computerInstance.initRun = vi.fn(async () => {});
      const computer = computerTool({
        computer: computerInstance,
      });

      const approvalTool = tool({
        name: 'needsApproval',
        description: 'requires approval',
        parameters: z.object({}).strict(),
        execute: async () => 'ok',
        needsApproval: true,
      });

      const functionCall: protocol.FunctionCallItem = {
        ...TEST_MODEL_FUNCTION_CALL,
        name: 'needsApproval',
        callId: 'call-1',
        arguments: '{}',
      };
      const model = new ScriptedModel([
        modelResponse({
          output: [functionCall, fakeModelMessage('pending')],
          usage: new Usage(),
        }),
        modelResponse({
          output: [fakeModelMessage('all done')],
          usage: new Usage(),
        }),
      ]);

      const agent = new Agent({
        name: 'ApprovalAgent',
        model,
        tools: [computer, approvalTool],
      });

      const firstRun = await run(agent, 'hello');
      expect(firstRun.interruptions).toHaveLength(1);
      expect(computerInstance.initRun).toHaveBeenCalledTimes(1);

      const approval = firstRun.interruptions?.[0];
      firstRun.state._context.approveTool(approval);
      await run(agent, firstRun.state);

      expect(computerInstance.initRun).toHaveBeenCalledTimes(1);
    });

    it('reinitializes computer tools when reusing a RunContext across runs', async () => {
      const computerInstance = new FakeComputer() as FakeComputer & {
        initRun?: (ctx?: RunContext) => Promise<void>;
      };
      computerInstance.initRun = vi.fn(async () => {});
      const computer = computerTool({
        computer: computerInstance,
      });
      const model = new ScriptedModel([
        modelResponse({
          output: [fakeModelMessage('done once')],
          usage: new Usage(),
        }),
        modelResponse({
          output: [fakeModelMessage('done twice')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'ComputerAgent',
        model,
        tools: [computer],
      });
      const runContext = new RunContext();

      await run(agent, 'hello', { context: runContext });
      await run(agent, 'hello again', { context: runContext });

      expect(computerInstance.initRun).toHaveBeenCalledTimes(2);
    });

    it('initializes computer tools when they appear after a handoff', async () => {
      const computerA = new FakeComputer() as FakeComputer & {
        initRun?: (ctx?: RunContext) => Promise<void>;
      };
      computerA.initRun = vi.fn(async () => {});
      const computerB = new FakeComputer() as FakeComputer & {
        initRun?: (ctx?: RunContext) => Promise<void>;
      };
      computerB.initRun = vi.fn(async () => {});

      const toolA = computerTool({ name: 'computer_a', computer: computerA });
      const toolB = computerTool({ name: 'computer_b', computer: computerB });

      const agentB = new Agent({
        name: 'HandoffB',
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('done B')],
            usage: new Usage(),
          }),
        ]),
        tools: [toolB],
      });
      const handoffToB = handoff(agentB);
      const callItem: protocol.FunctionCallItem = {
        id: 'handoff-1',
        type: 'function_call',
        name: handoffToB.toolName,
        callId: 'call-1',
        status: 'completed',
        arguments: '{}',
      };
      const agentA = new Agent({
        name: 'HandoffA',
        model: new ScriptedModel([
          modelResponse({ output: [callItem], usage: new Usage() }),
        ]),
        handoffs: [handoffToB],
        tools: [toolA],
      });

      const runner = new Runner();
      const result = await runner.run(agentA, 'hello');

      expect(result.finalOutput).toBe('done B');
      expect(computerA.initRun).toHaveBeenCalledTimes(1);
      expect(computerB.initRun).toHaveBeenCalledTimes(1);
    });

    it('defers disposal while a run is interrupted and cleans up after resuming', async () => {
      const createdComputer = new FakeComputer();
      const create = vi.fn(async () => createdComputer);
      const dispose = vi.fn(async () => {});
      const computer = computerTool({
        computer: { create, dispose },
      });

      const approvalTool = tool({
        name: 'needsApproval',
        description: 'requires approval',
        parameters: z.object({}).strict(),
        execute: async () => 'ok',
        needsApproval: true,
      });

      const functionCall: protocol.FunctionCallItem = {
        ...TEST_MODEL_FUNCTION_CALL,
        name: 'needsApproval',
        callId: 'call-1',
        arguments: '{}',
      };
      const model = new ScriptedModel([
        modelResponse({
          output: [functionCall, fakeModelMessage('pending')],
          usage: new Usage(),
        }),
        modelResponse({
          output: [fakeModelMessage('all done')],
          usage: new Usage(),
        }),
      ]);

      const agent = new Agent({
        name: 'ApprovalAgent',
        model,
        tools: [computer, approvalTool],
      });

      const firstRun = await run(agent, 'hello');
      expect(firstRun.interruptions).toHaveLength(1);
      expect(dispose).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);

      const approval = firstRun.interruptions?.[0];
      if (!approval) {
        throw new Error('Expected an approval interruption');
      }
      firstRun.state.approve(approval);

      const finalRun = await run(agent, firstRun.state);

      expect(finalRun.finalOutput).toBe('all done');
      expect(create).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledWith({
        runContext: finalRun.state._context,
        computer: createdComputer,
      });
    });
  });

  describe('additional scenarios', () => {
    class StreamingModel extends ScriptedModel {
      constructor(resp: protocol.AssistantMessageItem) {
        super(
          Array.from({ length: 3 }, (_, index) =>
            modelResponse({
              output: [resp],
              usage: new Usage(),
              responseId: `r${index + 1}`,
            }),
          ),
        );
      }
    }

    it('resumes from serialized RunState', async () => {
      const agent = new Agent({
        name: 'Resume',
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('hi')],
            usage: new Usage(),
          }),
        ]),
      });
      const first = await run(agent, 'hi');
      const json = first.state.toJSON();
      delete (json as any).currentAgentSpan;
      const restored = await RunState.fromString(agent, JSON.stringify(json));
      const resumed = await run(agent, restored);
      expect(resumed.finalOutput).toBe(first.finalOutput);
    });

    it('resumes from schema 1.0 RunState', async () => {
      const agent = new Agent({
        name: 'ResumeV1',
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('hi')],
            usage: new Usage(),
          }),
        ]),
      });
      const first = await run(agent, 'hi');
      const json = first.state.toJSON() as any;
      delete json.currentAgentSpan;
      delete json.currentTurnInProgress;
      delete json.conversationId;
      delete json.previousResponseId;
      json.$schemaVersion = '1.0';
      const restored = await RunState.fromString(agent, JSON.stringify(json));
      expect(restored._currentTurnInProgress).toBe(false);
      expect(restored._conversationId).toBeUndefined();
      expect(restored._previousResponseId).toBeUndefined();
      const resumed = await run(agent, restored);
      expect(resumed.finalOutput).toBe(first.finalOutput);
    });

    it('prefers runner trace config over RunState trace when resuming', async () => {
      setTracingDisabled(false);
      const provider = getGlobalTraceProvider();
      const agent = new Agent({
        name: 'ResumeTraceOverrides',
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('hi')],
            usage: new Usage(),
          }),
        ]),
      });
      const runner = new Runner({
        traceId: 'override-trace-id',
        workflowName: 'Override workflow',
        groupId: 'override-group',
        traceMetadata: { source: 'runner' },
        tracing: { apiKey: 'override-key' },
      });
      const state = new RunState(new RunContext(), 'hi', agent, 1);
      const trace = provider.createTrace({
        traceId: 'original-trace-id',
        name: 'Original workflow',
        groupId: 'original-group',
        metadata: { source: 'state' },
        tracingApiKey: 'original-key',
      });
      const span = provider.createSpan(
        { data: { type: 'agent', name: 'OriginalSpan' } },
        trace,
      );
      state._trace = trace;
      state._currentAgentSpan = span;

      const resumed = await runner.run(agent, state);
      expect(resumed.state._trace?.traceId).toBe('override-trace-id');
      expect(resumed.state._trace?.name).toBe('Override workflow');
      expect(resumed.state._trace?.groupId).toBe('override-group');
      expect(resumed.state._trace?.metadata).toEqual({ source: 'runner' });
      expect(resumed.state._trace?.tracingApiKey).toBe('override-key');
      expect(resumed.state._currentAgentSpan?.traceId).toBe(
        'override-trace-id',
      );
      expect(resumed.state._currentAgentSpan?.traceMetadata).toEqual({
        source: 'runner',
      });
      expect(resumed.state._currentAgentSpan?.tracingApiKey).toBe(
        'override-key',
      );
      setTracingDisabled(true);
    });

    it('can clear a restored RunState trace so resume uses the ambient trace', async () => {
      setTracingDisabled(false);
      try {
        const provider = getGlobalTraceProvider();
        const agent = new Agent({
          name: 'ResumeAmbientTrace',
          model: new ScriptedModel([
            modelResponse({
              output: [fakeModelMessage('hi')],
              usage: new Usage(),
            }),
          ]),
        });
        const state = new RunState(new RunContext(), 'hi', agent, 1);
        const restoredTrace = provider.createTrace({
          traceId: 'restored-trace-id',
          name: 'Restored workflow',
        });
        state._trace = restoredTrace;
        state._currentAgentSpan = provider.createSpan(
          { data: { type: 'agent', name: 'RestoredSpan' } },
          restoredTrace,
        );
        state.clearTrace();

        const ambientTrace = provider.createTrace({
          traceId: 'ambient-trace-id',
          name: 'Ambient workflow',
        });

        const resumed = await withTrace(ambientTrace, async () =>
          new Runner().run(agent, state),
        );

        expect(resumed.state._trace?.traceId).toBe('ambient-trace-id');
        expect(resumed.state._currentAgentSpan?.traceId).toBe(
          'ambient-trace-id',
        );
        expect(resumed.state._trace?.traceId).not.toBe('restored-trace-id');
        expect(resumed.state._currentAgentSpan?.traceId).not.toBe(
          'restored-trace-id',
        );
      } finally {
        setTracingDisabled(true);
      }
    });

    it('input guardrail executes only once', async () => {
      const firstResponse: ModelResponse = {
        output: [
          {
            id: 'f1',
            type: 'function_call',
            name: 'test',
            callId: 'c1',
            status: 'completed',
            arguments: '{}',
          },
        ],
        usage: new Usage(),
      };
      const secondResponse: ModelResponse = {
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      };
      const guardrailFn = vi.fn(async () => ({
        tripwireTriggered: false,
        outputInfo: {},
      }));
      const runner = new Runner({
        inputGuardrails: [{ name: 'ig', execute: guardrailFn }],
      });
      const agent = new Agent({
        name: 'Guard',
        model: new ScriptedModel([
          modelResponse(firstResponse),
          modelResponse(secondResponse),
        ]),
        tools: [TEST_TOOL],
      });
      const result = await runner.run(agent, 'start');
      expect(result.finalOutput).toBe('done');
      expect(guardrailFn).toHaveBeenCalledTimes(1);
    });

    it('waits for blocking input guardrails before calling the model', async () => {
      let guardrailCompleted = false;
      const blockingGuardrail = {
        name: 'blocking-ig',
        runInParallel: false,
        execute: vi.fn(async () => {
          await Promise.resolve();
          guardrailCompleted = true;
          return { tripwireTriggered: false, outputInfo: {} };
        }),
      };

      class ExpectGuardrailFirstModel extends ScriptedModel {
        constructor() {
          super([
            modelResponder(() => {
              expect(guardrailCompleted).toBe(true);
              return {
                output: [fakeModelMessage('done')],
                usage: new Usage(),
              };
            }),
          ]);
        }
      }

      const agent = new Agent({
        name: 'BlockingGuard',
        model: new ExpectGuardrailFirstModel(),
        inputGuardrails: [blockingGuardrail],
      });

      const result = await run(agent, 'hello');
      expect(result.finalOutput).toBe('done');
      expect(result.inputGuardrailResults).toHaveLength(1);
      expect(blockingGuardrail.execute).toHaveBeenCalledTimes(1);
    });

    it('does not call the model while sibling parallel guardrails drain after a failure', async () => {
      let releaseSlowGuardrail!: () => void;
      let markSlowStarted!: () => void;
      let markErrorThrown!: () => void;
      const slowGuardrailCanFinish = new Promise<void>((resolve) => {
        releaseSlowGuardrail = resolve;
      });
      const slowGuardrailStarted = new Promise<void>((resolve) => {
        markSlowStarted = resolve;
      });
      const errorThrown = new Promise<void>((resolve) => {
        markErrorThrown = resolve;
      });
      const slowGuardrail = {
        name: 'slow-parallel-guardrail',
        execute: async () => {
          markSlowStarted();
          await slowGuardrailCanFinish;
          return { tripwireTriggered: false, outputInfo: {} };
        },
      };
      const errorGuardrail = {
        name: 'failing-parallel-guardrail',
        execute: async () => {
          await slowGuardrailStarted;
          markErrorThrown();
          throw new Error('boom');
        },
      };

      class TrackingModel extends ScriptedModel {
        constructor() {
          super([
            modelResponse({
              output: [fakeModelMessage('should not run')],
              usage: new Usage(),
            }),
          ]);
        }
      }

      const model = new TrackingModel();
      const agent = new Agent({
        name: 'ParallelGuardrailFailure',
        model,
        inputGuardrails: [slowGuardrail, errorGuardrail],
      });

      const runPromise = run(agent, 'hello');
      let runSettled = false;
      void runPromise.then(
        () => {
          runSettled = true;
        },
        () => {
          runSettled = true;
        },
      );
      await errorThrown;
      await new Promise((resolve) => setTimeout(resolve, 0));
      const callsBeforeSiblingFinished = model.calls.length;
      const settledBeforeSiblingFinished = runSettled;
      releaseSlowGuardrail();

      await expect(runPromise).rejects.toBeInstanceOf(GuardrailExecutionError);
      expect(callsBeforeSiblingFinished).toBe(0);
      expect(settledBeforeSiblingFinished).toBe(false);
      expect(model.calls).toHaveLength(0);
    });

    it('retains an admitted turn when a parallel guardrail fails after the model starts', async () => {
      let markModelStarted!: () => void;
      let markGuardrailFailing!: () => void;
      const modelStarted = new Promise<void>((resolve) => {
        markModelStarted = resolve;
      });
      const guardrailFailing = new Promise<void>((resolve) => {
        markGuardrailFailing = resolve;
      });
      const guardrail = {
        name: 'late-parallel-guardrail-error',
        execute: async () => {
          await modelStarted;
          markGuardrailFailing();
          throw new Error('late boom');
        },
      };

      class TrackingModel extends ScriptedModel {
        constructor() {
          super([
            modelResponder(async () => {
              markModelStarted();
              await guardrailFailing;
              return {
                output: [fakeModelMessage('unused')],
                usage: new Usage(),
              };
            }),
          ]);
        }
      }

      const model = new TrackingModel();
      const agent = new Agent({
        name: 'LateParallelGuardrailFailure',
        model,
        inputGuardrails: [guardrail],
      });

      let caughtError: unknown;
      try {
        await run(agent, 'hello');
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(GuardrailExecutionError);
      const guardrailError = caughtError as GuardrailExecutionError;
      expect(model.calls).toHaveLength(1);
      expect(guardrailError.state?._currentTurn).toBe(1);

      const restored = await RunState.fromString(
        agent,
        guardrailError.state!.toString(),
      );
      expect(restored._currentTurn).toBe(1);

      let resumedError: unknown;
      try {
        await run(agent, restored, { maxTurns: 1 });
      } catch (error) {
        resumedError = error;
      }
      expect(resumedError).toBeInstanceOf(MaxTurnsExceededError);
      expect((resumedError as MaxTurnsExceededError).state?._currentTurn).toBe(
        1,
      );
      expect(model.calls).toHaveLength(1);
    });

    it('throws InputGuardrailTripwireTriggered when parallel guardrail trips with structured output and model returns non-JSON', async () => {
      const fakeModel = new ScriptedModel([
        modelResponse({
          output: [fakeModelMessage('I am sorry, this is plain text not JSON')],
          usage: new Usage(),
        }),
      ]);

      const agent = new Agent({
        name: 'GuardrailPriority',
        model: fakeModel,
        outputType: z.object({ response: z.string() }),
        inputGuardrails: [
          {
            name: 'slow-tripwire',
            runInParallel: true,
            execute: async () => {
              await new Promise((r) => setTimeout(r, 50));
              return {
                tripwireTriggered: true,
                outputInfo: { reason: 'blocked' },
              };
            },
          },
        ],
      });

      await expect(run(agent, 'test')).rejects.toBeInstanceOf(
        InputGuardrailTripwireTriggered,
      );
    });

    it('keeps the current agent span attached when an input guardrail trips', async () => {
      setTracingDisabled(false);
      const fakeModel = new ScriptedModel([
        modelResponse({
          output: [fakeModelMessage('plain text')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'GuardrailSpan',
        model: fakeModel,
        inputGuardrails: [
          {
            name: 'tripwire',
            runInParallel: false,
            execute: async () => ({
              tripwireTriggered: true,
              outputInfo: { reason: 'blocked' },
            }),
          },
        ],
      });

      try {
        await run(agent, 'test');
        throw new Error('Expected the input guardrail to trip.');
      } catch (error) {
        expect(error).toBeInstanceOf(InputGuardrailTripwireTriggered);
        const tripwireError = error as InputGuardrailTripwireTriggered;
        expect(tripwireError.state?._currentAgentSpan).toBeTruthy();
        expect(tripwireError.state?._currentAgentSpan?.error).not.toBeNull();
      } finally {
        setTracingDisabled(true);
      }
    });

    it('output guardrail success', async () => {
      const guardrailFn = vi.fn(async () => ({
        tripwireTriggered: false,
        outputInfo: {},
      }));
      const runner = new Runner({
        outputGuardrails: [{ name: 'og', execute: guardrailFn }],
      });
      const agent = new Agent({
        name: 'Out',
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('hi')],
            usage: new Usage(),
          }),
        ]),
      });
      const result = await runner.run(agent, 'input');
      expect(result.finalOutput).toBe('hi');
      expect(guardrailFn).toHaveBeenCalledTimes(1);
      expect(result.outputGuardrailResults).toHaveLength(1);
      expect(result.outputGuardrailResults[0].guardrail.name).toBe('og');
      expect(result.outputGuardrailResults[0].output.tripwireTriggered).toBe(
        false,
      );
      expect(result.outputGuardrailResults[0].agentOutput).toBe('hi');
      expect(result.outputGuardrailResults[0].agent).toBe(agent);
    });

    it('retains completed output guardrail results on execution failure', async () => {
      const runner = new Runner({
        outputGuardrails: [
          {
            name: 'success',
            execute: async () => ({
              tripwireTriggered: false,
              outputInfo: { ok: true },
            }),
          },
          {
            name: 'error',
            execute: async () => {
              throw new Error('boom');
            },
          },
        ],
      });
      const agent = new Agent({
        name: 'Out',
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('hi')],
            usage: new Usage(),
          }),
        ]),
      });
      let caughtError: unknown;

      try {
        await runner.run(agent, 'input');
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(GuardrailExecutionError);
      const guardrailError = caughtError as GuardrailExecutionError;
      expect(guardrailError.error).toEqual(new Error('boom'));
      expect(
        guardrailError.state
          ?.toJSON()
          .outputGuardrailResults.map((result) => result.guardrail.name),
      ).toEqual(['success']);
    });

    it('output guardrail tripwire throws', async () => {
      const guardrailFn = vi.fn(async () => ({
        tripwireTriggered: true,
        outputInfo: { bad: true },
      }));
      const runner = new Runner({
        outputGuardrails: [{ name: 'og', execute: guardrailFn }],
      });
      const agent = new Agent({
        name: 'Out',
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('x')],
            usage: new Usage(),
          }),
        ]),
      });
      await expect(runner.run(agent, 'input')).rejects.toBeInstanceOf(
        OutputGuardrailTripwireTriggered,
      );
    });

    it('passes run details to output guardrails', async () => {
      let receivedArgs: OutputGuardrailFunctionArgs | undefined;
      let guardrailValidatedTool = false;
      const guardrailFn = vi.fn(async (args: OutputGuardrailFunctionArgs) => {
        receivedArgs = args;
        const toolCall = args.details?.output?.find(
          (item): item is protocol.FunctionCallItem =>
            item.type === 'function_call' &&
            (item as protocol.FunctionCallItem).name === 'queryPerson',
        );
        expect(toolCall?.arguments).toContain('person-1');
        guardrailValidatedTool = true;
        return { tripwireTriggered: false, outputInfo: {} };
      });
      const runner = new Runner({
        outputGuardrails: [{ name: 'og', execute: guardrailFn }],
      });
      const queryPerson = tool({
        name: 'queryPerson',
        description: 'Look up a person by id',
        parameters: z.object({ personId: z.string() }),
        execute: async ({ personId }) => `${personId} result`,
      });
      const responses: ModelResponse[] = [
        {
          output: [
            {
              id: 'call-1',
              type: 'function_call',
              name: 'queryPerson',
              callId: 'call-1',
              status: 'completed',
              arguments: '{"personId":"person-1"}',
            },
          ],
          usage: new Usage(),
        },
        {
          output: [fakeModelMessage('done')],
          usage: new Usage(),
        },
      ];
      const agent = new Agent({
        name: 'Out',
        model: new ScriptedModel(Array.from(responses, modelResponse)),
        tools: [queryPerson],
      });

      await runner.run(agent, 'input');

      expect(guardrailFn).toHaveBeenCalledTimes(1);

      const outputItems = receivedArgs?.details?.output ?? [];
      expect(outputItems.length).toBeGreaterThan(0);
      const toolCall = outputItems.find(
        (item): item is protocol.FunctionCallItem =>
          item.type === 'function_call' && (item as any).name === 'queryPerson',
      );
      expect(toolCall?.arguments).toContain('person-1');

      const toolResult = outputItems.find(
        (item): item is protocol.FunctionCallResultItem =>
          item.type === 'function_call_result' &&
          (item as any).callId === 'call-1',
      );
      expect(toolResult).toBeDefined();
      const toolOutput = toolResult?.output;
      if (typeof toolOutput === 'string') {
        expect(toolOutput).toBe('person-1 result');
      } else if (Array.isArray(toolOutput)) {
        expect(
          toolOutput.some(
            (item) =>
              'text' in item &&
              typeof (item as { text?: unknown }).text === 'string' &&
              (item as { text: string }).text === 'person-1 result',
          ),
        ).toBe(true);
      } else {
        expect((toolOutput as { text?: string } | undefined)?.text).toBe(
          'person-1 result',
        );
      }
      expect(guardrailValidatedTool).toBe(true);
    });

    it('executes tool calls and records output', async () => {
      const first: ModelResponse = {
        output: [
          {
            id: 't1',
            type: 'function_call',
            name: 'test',
            callId: 'c1',
            status: 'completed',
            arguments: '{}',
          },
        ],
        usage: new Usage(),
      };
      const second: ModelResponse = {
        output: [fakeModelMessage('final')],
        usage: new Usage(),
      };
      const agent = new Agent({
        name: 'Tool',
        model: new ScriptedModel([modelResponse(first), modelResponse(second)]),
        tools: [TEST_TOOL],
      });
      const result = await run(agent, 'do');
      const types = result.newItems.map((i) => i.type);
      expect(types).toContain('tool_call_item');
      expect(types).toContain('tool_call_output_item');
      expect(result.rawResponses.length).toBeGreaterThanOrEqual(2);
      expect(result.finalOutput).toBe('final');
    });

    it('switches agents via handoff', async () => {
      const agentB = new Agent({
        name: 'B',
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('done B')],
            usage: new Usage(),
          }),
        ]),
      });
      const callItem: protocol.FunctionCallItem = {
        id: 'h1',
        type: 'function_call',
        name: handoff(agentB).toolName,
        callId: 'c1',
        status: 'completed',
        arguments: '{}',
      };
      const agentA = new Agent({
        name: 'A',
        model: new ScriptedModel([
          modelResponse({ output: [callItem], usage: new Usage() }),
        ]),
        handoffs: [handoff(agentB)],
      });
      const runner = new Runner();
      const result = await runner.run(agentA, 'hi');
      expect(result.finalOutput).toBe('done B');
      expect(result.state._currentAgent).toBe(agentB);
    });

    it('does not keep ignored handoffs in history or session state', async () => {
      class RecordingSession implements Session {
        items: AgentInputItem[] = [];

        async getSessionId(): Promise<string> {
          return 'session';
        }

        async getItems(): Promise<AgentInputItem[]> {
          return [...this.items];
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

      const agentB = new Agent({
        name: 'B',
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('done B')],
            usage: new Usage(),
          }),
        ]),
      });
      const agentC = new Agent({
        name: 'C',
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('done C')],
            usage: new Usage(),
          }),
        ]),
      });
      const handoffToB = handoff(agentB);
      const handoffToC = handoff(agentC);
      const acceptedCall: protocol.FunctionCallItem = {
        id: 'h1',
        type: 'function_call',
        name: handoffToB.toolName,
        callId: 'c1',
        status: 'completed',
        arguments: '{}',
      };
      const ignoredCall: protocol.FunctionCallItem = {
        id: 'h2',
        type: 'function_call',
        name: handoffToC.toolName,
        callId: 'c2',
        status: 'completed',
        arguments: '{}',
      };
      const session = new RecordingSession();
      const agentA = new Agent({
        name: 'A',
        model: new ScriptedModel([
          modelResponse({
            output: [acceptedCall, ignoredCall],
            usage: new Usage(),
          }),
        ]),
        handoffs: [handoffToB, handoffToC],
      });

      const result = await new Runner().run(agentA, 'hi', { session });
      const persistedItems = await session.getItems();

      expect(result.finalOutput).toBe('done B');
      expect(
        result.history.some(
          (item) => (item as { callId?: string }).callId === ignoredCall.callId,
        ),
      ).toBe(false);
      expect(
        persistedItems.some(
          (item) => (item as { callId?: string }).callId === ignoredCall.callId,
        ),
      ).toBe(false);
      expect(
        persistedItems.some(
          (item) =>
            (item as { callId?: string }).callId === acceptedCall.callId,
        ),
      ).toBe(true);
    });

    it('streamed run produces same final output', async () => {
      const msg = fakeModelMessage('stream');
      const agent1 = new Agent({ name: 'S1', model: new StreamingModel(msg) });
      const agent2 = new Agent({ name: 'S2', model: new StreamingModel(msg) });
      const streamRes = await run(agent1, 'hi', { stream: true });
      const events: RunStreamEvent[] = [];
      for await (const e of streamRes.toStream()) {
        events.push(e);
      }
      await streamRes.completed;
      const normalRes = await run(agent2, 'hi');
      expect(streamRes.finalOutput).toBe(normalRes.finalOutput);
      expect(streamRes.finalOutput).toBe('stream');
      expect(events.length).toBeGreaterThan(0);
    });

    it('records one model response per turn', async () => {
      const first: ModelResponse = {
        output: [
          {
            id: 'rc1',
            type: 'function_call',
            name: 'test',
            callId: 'c1',
            status: 'completed',
            arguments: '{}',
          },
        ],
        usage: new Usage(),
      };
      const second: ModelResponse = {
        output: [fakeModelMessage('end')],
        usage: new Usage(),
      };
      const agent = new Agent({
        name: 'Record',
        model: new ScriptedModel([modelResponse(first), modelResponse(second)]),
        tools: [TEST_TOOL],
      });
      const result = await run(agent, 'go');
      expect(result.state._modelResponses).toHaveLength(2);
      expect(result.state._modelResponses[0]).toStrictEqual(first);
      expect(result.state._modelResponses[1]).toStrictEqual(second);
    });

    it('records one model response per turn for streaming runs', async () => {
      const first: ModelResponse = {
        output: [
          {
            id: 'sc1',
            type: 'function_call',
            name: 'test',
            callId: 'c1',
            status: 'completed',
            arguments: '{}',
          },
        ],
        usage: new Usage(),
      };
      const second: ModelResponse = {
        output: [fakeModelMessage('final')],
        usage: new Usage(),
      };
      class SimpleStreamingModel extends ScriptedModel {
        constructor(responses: ModelResponse[]) {
          super(responses.map(modelResponse));
        }
      }
      const agent = new Agent({
        name: 'StreamRecord',
        model: new SimpleStreamingModel([first, second]),
        tools: [TEST_TOOL],
      });
      const res = await run(agent, 'go', { stream: true });
      for await (const _ of res.toStream()) {
        // consume
      }
      await res.completed;
      expect(res.state._modelResponses).toHaveLength(2);
    });

    it('max turn exceeded throws', async () => {
      const agent = new Agent({
        name: 'Max',
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('nope')],
            usage: new Usage(),
          }),
        ]),
      });
      const error = await run(agent, 'x', { maxTurns: 0 }).catch((err) => err);

      expect(error).toBeInstanceOf(MaxTurnsExceededError);
      expect((error as MaxTurnsExceededError).state?._currentTurn).toBe(0);
    });

    it('rolls back a turn when request serialization fails before the model call', async () => {
      class TrackingModel extends ScriptedModel {
        get callCount(): number {
          return this.calls.length;
        }
      }

      const model = new TrackingModel([
        modelResponse({
          output: [fakeModelMessage('{"value":"ok"}')],
          usage: new Usage(),
        }),
      ]);
      const agent: Agent<any, any> = new Agent({
        name: 'RequestSerializationFailure',
        model,
        outputType: z.object({ value: z.custom() }),
      });
      const state = new RunState(new RunContext(), 'x', agent, 1);

      const error = await run(agent, state).catch((caught) => caught);

      expect(error).toBeInstanceOf(UserError);
      expect(model.callCount).toBe(0);
      expect(state._currentTurn).toBe(0);

      const restored = await RunState.fromString(agent, state.toString());
      agent.outputType = z.object({ value: z.string() });
      const resumed = await run(agent, restored, { maxTurns: 1 });

      expect(resumed.finalOutput).toEqual({ value: 'ok' });
      expect(resumed.state._currentTurn).toBe(1);
      expect(model.callCount).toBe(1);
    });

    it('preserves an in-progress turn when resumed request serialization fails', async () => {
      class TrackingModel extends ScriptedModel {
        get callCount(): number {
          return this.calls.length;
        }
      }

      const model = new TrackingModel([
        modelResponse({
          output: [fakeModelMessage('{"value":"ok"}')],
          usage: new Usage(),
        }),
      ]);
      const agent: Agent<any, any> = new Agent({
        name: 'ResumedRequestSerializationFailure',
        model,
        outputType: z.object({ value: z.custom() }),
      });
      const state = new RunState(new RunContext(), 'x', agent, 1);
      state._currentTurn = 1;
      state._currentTurnInProgress = true;
      const restored = await RunState.fromString(agent, state.toString());

      const error = await run(agent, restored, { maxTurns: 1 }).catch(
        (caught) => caught,
      );

      expect(error).toBeInstanceOf(UserError);
      expect(model.callCount).toBe(0);
      expect(restored._currentTurn).toBe(1);
      expect(restored._currentTurnInProgress).toBe(true);

      const retryState = await RunState.fromString(agent, restored.toString());
      agent.outputType = z.object({ value: z.string() });
      const resumed = await run(agent, retryState, { maxTurns: 1 });

      expect(resumed.finalOutput).toEqual({ value: 'ok' });
      expect(resumed.state._currentTurn).toBe(1);
      expect(model.callCount).toBe(1);
    });

    it('does not enforce maxTurns when maxTurns is null', async () => {
      const toolResponses = Array.from({ length: 12 }, (_, index) => ({
        output: [
          {
            ...TEST_MODEL_FUNCTION_CALL,
            id: `fc_${index}`,
            callId: `call_${index}`,
            arguments: JSON.stringify({ test: 'input' }),
          },
        ],
        usage: new Usage(),
      }));
      const agent = new Agent({
        name: 'NoMaxTurns',
        model: new ScriptedModel([
          ...toolResponses.map(modelResponse),
          modelResponse({
            output: [fakeModelMessage('done')],
            usage: new Usage(),
          }),
        ]),
        tools: [TEST_TOOL],
      });

      const result = await run(agent, 'x', { maxTurns: null });

      expect(result.finalOutput).toBe('done');
      expect(result.state._maxTurns).toBeNull();
      expect(result.state._currentTurn).toBe(13);
    });

    it('allows resumed states to disable maxTurns with null', async () => {
      const responses = [
        {
          output: [
            {
              ...TEST_MODEL_FUNCTION_CALL,
              id: 'fc_1',
              callId: 'call_1',
              arguments: JSON.stringify({ test: 'first' }),
            },
          ],
          usage: new Usage(),
        },
        {
          output: [
            {
              ...TEST_MODEL_FUNCTION_CALL,
              id: 'fc_2',
              callId: 'call_2',
              arguments: JSON.stringify({ test: 'second' }),
            },
          ],
          usage: new Usage(),
        },
        { output: [fakeModelMessage('done')], usage: new Usage() },
      ];
      const agent = new Agent({
        name: 'NoMaxTurnsResume',
        model: new ScriptedModel(Array.from(responses, modelResponse)),
        tools: [TEST_TOOL],
      });
      const error = await run(agent, 'x', { maxTurns: 1 }).catch((err) => err);
      expect(error).toBeInstanceOf(MaxTurnsExceededError);
      const state = (error as MaxTurnsExceededError).state as RunState<
        unknown,
        typeof agent
      >;
      expect(state._currentTurn).toBe(1);

      const result = await run(agent, state, {
        maxTurns: null,
      });

      expect(result.finalOutput).toBe('done');
      expect(result.state._maxTurns).toBeNull();
    });

    it('max turn handler returns final output', async () => {
      const agent = new Agent({
        name: 'MaxSummary',
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('nope')],
            usage: new Usage(),
          }),
        ]),
      });
      const result = await run(agent, 'x', {
        maxTurns: 0,
        errorHandlers: {
          maxTurns: ({ runData }) => ({
            finalOutput: `summary:${runData.history.length}`,
          }),
        },
      });
      expect(result.finalOutput).toBe('summary:1');
      expect(extractAllTextOutput(result.newItems)).toBe('summary:1');
    });

    it('max turn handler can skip history updates', async () => {
      const agent = new Agent({
        name: 'MaxSummaryNoHistory',
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('nope')],
            usage: new Usage(),
          }),
        ]),
      });
      const result = await run(agent, 'x', {
        maxTurns: 0,
        errorHandlers: {
          maxTurns: () => ({
            finalOutput: 'summary',
            includeInHistory: false,
          }),
        },
      });
      expect(result.finalOutput).toBe('summary');
      expect(result.newItems).toHaveLength(0);
    });

    it('throws model refusal errors instead of retrying refusal-only messages', async () => {
      const agent = new Agent({
        name: 'Refusal',
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelRefusal('I cannot help with that request.')],
            usage: new Usage(),
          }),
        ]),
      });
      await expect(run(agent, 'x', { maxTurns: 3 })).rejects.toMatchObject({
        name: 'ModelRefusalError',
        refusal: 'I cannot help with that request.',
      });
    });

    it('throws model refusal errors before structured output parsing', async () => {
      const agent = new Agent({
        name: 'StructuredRefusalError',
        outputType: z.object({ summary: z.string() }),
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelRefusal('I cannot help with that request.')],
            usage: new Usage(),
          }),
        ]),
      });
      await expect(run(agent, 'x')).rejects.toBeInstanceOf(ModelRefusalError);
    });

    it('uses assistant text when a message also contains refusal content', async () => {
      const agent = new Agent({
        name: 'MixedTextRefusal',
        model: new ScriptedModel([
          modelResponse({
            output: [
              fakeModelMessageWithRefusal(
                'valid answer',
                'I cannot help with a different part.',
              ),
            ],
            usage: new Usage(),
          }),
        ]),
      });
      const result = await run(agent, 'x');
      expect(result.finalOutput).toBe('valid answer');
    });

    it('parses structured assistant text when refusal content is also present', async () => {
      const agent = new Agent({
        name: 'MixedStructuredRefusal',
        outputType: z.object({ summary: z.string() }),
        model: new ScriptedModel([
          modelResponse({
            output: [
              fakeModelMessageWithRefusal(
                '{"summary":"valid answer"}',
                'I cannot help with a different part.',
              ),
            ],
            usage: new Usage(),
          }),
        ]),
      });
      const result = await run(agent, 'x');
      expect(result.finalOutput).toEqual({ summary: 'valid answer' });
    });

    it('model refusal handler returns structured final output', async () => {
      const agent = new Agent({
        name: 'StructuredRefusal',
        outputType: z.object({ summary: z.string() }),
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelRefusal('I cannot help with that request.')],
            usage: new Usage(),
          }),
        ]),
      });
      const result = await run(agent, 'x', {
        errorHandlers: {
          modelRefusal: ({ error, runData }) => {
            expect(error).toBeInstanceOf(ModelRefusalError);
            expect((error as ModelRefusalError).refusal).toBe(
              'I cannot help with that request.',
            );
            expect(runData.rawResponses).toHaveLength(1);
            return { finalOutput: { summary: 'safe fallback' } };
          },
        },
      });
      expect(result.finalOutput).toEqual({ summary: 'safe fallback' });
      expect(extractAllTextOutput(result.newItems)).toBe(
        '{"summary":"safe fallback"}',
      );
    });

    it('model refusal handler can skip history updates', async () => {
      const agent = new Agent({
        name: 'RefusalNoHistory',
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelRefusal('I cannot help with that request.')],
            usage: new Usage(),
          }),
        ]),
      });
      const result = await run(agent, 'x', {
        errorHandlers: {
          modelRefusal: () => ({
            finalOutput: 'safe fallback',
            includeInHistory: false,
          }),
        },
      });
      expect(result.finalOutput).toBe('safe fallback');
      expect(extractAllTextOutput(result.newItems)).toBe('');
    });

    it('default error handler can handle model refusals', async () => {
      const agent = new Agent({
        name: 'DefaultRefusal',
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelRefusal('I cannot help with that request.')],
            usage: new Usage(),
          }),
        ]),
      });
      const result = await run(agent, 'x', {
        errorHandlers: {
          default: ({ error }) => {
            expect(error).toBeInstanceOf(ModelRefusalError);
            return { finalOutput: 'safe fallback' };
          },
        },
      });
      expect(result.finalOutput).toBe('safe fallback');
    });

    it('throws invalid structured final output without a handler', async () => {
      const agent = new Agent({
        name: 'InvalidStructuredOutput',
        outputType: z.object({ summary: z.string() }),
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('not valid json')],
            usage: new Usage(),
          }),
        ]),
      });

      await expect(run(agent, 'x')).rejects.toBeInstanceOf(ModelBehaviorError);
    });

    it('invalid final output handler returns structured final output', async () => {
      const agent = new Agent({
        name: 'InvalidStructuredOutputHandler',
        outputType: z.object({ summary: z.string() }),
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('not valid json')],
            usage: new Usage(),
          }),
        ]),
      });

      const result = await run(agent, 'x', {
        errorHandlers: {
          invalidFinalOutput: ({ error, runData }) => {
            expect(error).toBeInstanceOf(ModelBehaviorError);
            expect(runData.rawResponses).toHaveLength(1);
            expect(extractAllTextOutput(runData.newItems)).toBe(
              'not valid json',
            );
            return { finalOutput: { summary: 'safe fallback' } };
          },
        },
      });

      expect(result.finalOutput).toEqual({ summary: 'safe fallback' });
      expect(extractAllTextOutput(result.newItems)).toBe(
        'not valid json{"summary":"safe fallback"}',
      );
    });

    it('invalid final output handler can skip history updates', async () => {
      const agent = new Agent({
        name: 'InvalidStructuredOutputNoHistory',
        outputType: z.object({ summary: z.string() }),
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('not valid json')],
            usage: new Usage(),
          }),
        ]),
      });

      const result = await run(agent, 'x', {
        errorHandlers: {
          invalidFinalOutput: () => ({
            finalOutput: { summary: 'safe fallback' },
            includeInHistory: false,
          }),
        },
      });

      expect(result.finalOutput).toEqual({ summary: 'safe fallback' });
      expect(extractAllTextOutput(result.newItems)).toBe('not valid json');
    });

    it('invalid final output handler can decline recovery', async () => {
      const agent = new Agent({
        name: 'InvalidStructuredOutputDeclined',
        outputType: z.object({ summary: z.string() }),
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('not valid json')],
            usage: new Usage(),
          }),
        ]),
      });

      await expect(
        run(agent, 'x', {
          errorHandlers: {
            invalidFinalOutput: () => undefined,
          },
        }),
      ).rejects.toBeInstanceOf(ModelBehaviorError);
    });

    it('invalid final output handler validates fallback output', async () => {
      const agent = new Agent({
        name: 'InvalidStructuredOutputBadFallback',
        outputType: z.object({ summary: z.string() }),
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('not valid json')],
            usage: new Usage(),
          }),
        ]),
      });

      await expect(
        run(agent, 'x', {
          errorHandlers: {
            invalidFinalOutput: () => ({
              finalOutput: { unexpected: 'value' } as any,
            }),
          },
        }),
      ).rejects.toThrow(UserError);
    });

    it('default error handler can handle invalid final output', async () => {
      const agent = new Agent({
        name: 'DefaultInvalidStructuredOutput',
        outputType: z.object({ summary: z.string() }),
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('not valid json')],
            usage: new Usage(),
          }),
        ]),
      });

      const result = await run(agent, 'x', {
        errorHandlers: {
          default: ({ error }) => {
            expect(error).toBeInstanceOf(ModelBehaviorError);
            return { finalOutput: { summary: 'safe fallback' } };
          },
        },
      });

      expect(result.finalOutput).toEqual({ summary: 'safe fallback' });
    });

    it.each([
      { name: 'missing message', output: [] },
      { name: 'empty text message', output: [fakeModelMessage('')] },
    ])(
      'empty structured output handler avoids another model turn for $name',
      async ({ output }) => {
        class CountingModel extends ScriptedModel {
          constructor(responses: ModelResponse[]) {
            super(responses.map(modelResponse));
          }

          get requests(): readonly ModelRequest[] {
            return this.calls.map((call) => call.request);
          }
        }

        const model = new CountingModel([
          { output, usage: new Usage() },
          {
            output: [fakeModelMessage('{"summary":"unused"}')],
            usage: new Usage(),
          },
        ]);
        const agent = new Agent({
          name: 'EmptyStructuredOutputHandler',
          outputType: z.object({ summary: z.string() }),
          model,
        });

        const result = await run(agent, 'x', {
          errorHandlers: {
            invalidFinalOutput: ({ error }) => {
              expect(error).toBeInstanceOf(ModelBehaviorError);
              expect((error as ModelBehaviorError).message).toBe(
                'Model returned no final output for the structured output type.',
              );
              return { finalOutput: { summary: 'safe fallback' } };
            },
          },
        });

        expect(result.finalOutput).toEqual({ summary: 'safe fallback' });
        expect(model.requests).toHaveLength(1);
      },
    );

    it('invalid final output fallback does not retry or replay tools', async () => {
      const sideEffects: string[] = [];
      const recordSideEffect = tool({
        name: 'record_side_effect',
        description: 'Records a side effect.',
        parameters: z.object({ value: z.string() }),
        execute: async ({ value }) => {
          sideEffects.push(value);
          return `recorded:${value}`;
        },
      });
      const agent = new Agent({
        name: 'InvalidStructuredOutputAfterTool',
        outputType: z.object({ summary: z.string() }),
        tools: [recordSideEffect],
        model: new ScriptedModel([
          modelResponse({
            output: [
              {
                type: 'function_call',
                id: 'fc_1',
                callId: 'call_1',
                name: 'record_side_effect',
                status: 'completed',
                arguments: '{"value":"once"}',
                providerData: {},
              } as protocol.FunctionCallItem,
            ],
            usage: new Usage(),
          }),
          modelResponse({
            output: [fakeModelMessage('not valid json')],
            usage: new Usage(),
          }),
          modelResponse({
            output: [
              {
                type: 'function_call',
                id: 'fc_2',
                callId: 'call_2',
                name: 'record_side_effect',
                status: 'completed',
                arguments: '{"value":"replayed"}',
                providerData: {},
              } as protocol.FunctionCallItem,
            ],
            usage: new Usage(),
          }),
          modelResponse({
            output: [fakeModelMessage('{"summary":"unexpected retry"}')],
            usage: new Usage(),
          }),
        ]),
      });

      const result = await run(agent, 'x', {
        errorHandlers: {
          invalidFinalOutput: () => ({
            finalOutput: { summary: 'safe fallback' },
          }),
        },
      });

      expect(result.finalOutput).toEqual({ summary: 'safe fallback' });
      expect(sideEffects).toEqual(['once']);
    });

    it('nested agent tools return invalid final output fallbacks', async () => {
      const nestedAgent = new Agent({
        name: 'NestedRecoverer',
        outputType: z.object({ summary: z.string() }),
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('not valid json')],
            usage: new Usage(),
          }),
        ]),
      });
      const nestedTool = nestedAgent.asTool({
        toolName: 'recover_nested',
        toolDescription: 'Recovers a structured nested output.',
        runOptions: {
          errorHandlers: {
            invalidFinalOutput: () => ({
              finalOutput: { summary: 'safe fallback' },
            }),
          },
        },
      });
      const parentAgent = new Agent({
        name: 'ParentAgent',
        tools: [nestedTool],
        model: new ScriptedModel([
          modelResponse({
            output: [
              {
                type: 'function_call',
                id: 'fc_nested',
                callId: 'call_nested',
                name: 'recover_nested',
                status: 'completed',
                arguments: '{"input":"recover"}',
                providerData: {},
              } as protocol.FunctionCallItem,
            ],
            usage: new Usage(),
          }),
          modelResponse({
            output: [fakeModelMessage('parent done')],
            usage: new Usage(),
          }),
        ]),
      });

      const result = await run(parentAgent, 'x');
      const nestedToolOutput = result.newItems.find(
        (item): item is ToolCallOutputItem =>
          item instanceof ToolCallOutputItem &&
          item.rawItem.type === 'function_call_result' &&
          item.rawItem.callId === 'call_nested',
      );

      const nestedOutput = nestedToolOutput?.rawItem.output;
      const nestedOutputText =
        typeof nestedOutput === 'string'
          ? nestedOutput
          : !Array.isArray(nestedOutput) && nestedOutput?.type === 'text'
            ? nestedOutput.text
            : undefined;
      expect(nestedOutputText).toBe('{"summary":"safe fallback"}');
      expect(result.finalOutput).toBe('parent done');
    });

    it('enforces maxTurns across multiple model calls', async () => {
      // Bug: After first model call, _lastTurnResponse is set, so turn counter never advances.
      // With maxTurns=1, we should only allow 1 model call, but currently allows 2.
      const testTool = tool({
        name: 'test_tool',
        description: 'A test tool',
        parameters: z.object({}),
        execute: async () => 'result',
      });

      const agent = new Agent({
        name: 'TurnCounter',
        model: new ScriptedModel([
          modelResponse({
            output: [
              {
                type: 'function_call',
                id: 'fc_1',
                callId: 'call_1',
                name: 'test_tool',
                status: 'completed',
                arguments: '{}',
                providerData: {},
              } as protocol.FunctionCallItem,
            ],
            usage: new Usage(),
          }),
          modelResponse({
            output: [fakeModelMessage('second')],
            usage: new Usage(),
          }),
        ]),
        tools: [testTool],
        toolUseBehavior: 'run_llm_again',
      });

      // With maxTurns=1, this should throw MaxTurnsExceededError after the first model call
      // Currently fails because turn counter doesn't advance after first call
      await expect(run(agent, 'x', { maxTurns: 1 })).rejects.toBeInstanceOf(
        MaxTurnsExceededError,
      );
    });

    it('enforces maxTurns across resumed interruptions', async () => {
      // Bug: After resuming from interruption, ALL subsequent calls are treated as same turn
      // because _lastTurnResponse is still set. The first post-interruption call should NOT
      // advance the turn, but the second call SHOULD advance the turn.
      const testTool = tool({
        name: 'test_tool',
        description: 'A test tool',
        parameters: z.object({}),
        execute: async () => 'result',
      });

      const agent = new Agent({
        name: 'ResumeTurnCounter',
        model: new ScriptedModel([
          modelResponse({
            output: [
              {
                type: 'function_call',
                id: 'fc_1',
                callId: 'call_1',
                name: 'test_tool',
                status: 'completed',
                arguments: '{}',
                providerData: {},
              } as protocol.FunctionCallItem,
            ],
            usage: new Usage(),
          }),
          modelResponse({
            output: [fakeModelMessage('second')],
            usage: new Usage(),
          }),
        ]),
        tools: [testTool],
        toolUseBehavior: 'run_llm_again',
      });

      // Simulate a resumed state after an interruption
      const resumedState = new RunState(new RunContext(), 'x', agent, 1);
      resumedState._currentTurn = 1;
      resumedState._currentTurnPersistedItemCount = 0;
      resumedState._currentStep = { type: 'next_step_run_again' };
      // Set these to simulate a state that was resumed from interruption
      resumedState._lastTurnResponse = {
        output: [fakeModelMessage('previous')],
        usage: new Usage(),
      };
      resumedState._lastProcessedResponse = {
        newItems: [],
        functions: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        handoffs: [],
        mcpApprovalRequests: [],
        toolsUsed: [],
      } as any;

      // With maxTurns=1, after the first post-interruption call completes and tries to make
      // a second call, the turn should advance to 2 and then throw MaxTurnsExceededError.
      // Currently fails because turn counter doesn't advance after first post-interruption call.
      await expect(
        run(agent, resumedState, { maxTurns: 1 }),
      ).rejects.toBeInstanceOf(MaxTurnsExceededError);
    });

    it('does not advance the turn when resuming an interruption without persisted items', async () => {
      const approvalTool = tool({
        name: 'get_weather',
        description: 'Gets weather for a city.',
        parameters: z.object({ city: z.string() }),
        needsApproval: async () => true,
        execute: async ({ city }) => `Weather in ${city}`,
      });

      const model = new ScriptedModel([
        modelResponse({
          output: [
            {
              type: 'function_call',
              id: 'fc_1',
              callId: 'call_weather_1',
              name: 'get_weather',
              status: 'completed',
              arguments: JSON.stringify({ city: 'Seattle' }),
              providerData: {},
            } as protocol.FunctionCallItem,
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [fakeModelMessage('All set.')],
          usage: new Usage(),
        }),
      ]);

      const agent = new Agent({
        name: 'ApprovalResume',
        model,
        tools: [approvalTool],
        toolUseBehavior: 'run_llm_again',
      });

      let result = await run(agent, 'How is the weather?', { maxTurns: 1 });
      expect(result.interruptions).toHaveLength(1);
      expect(result.state._currentTurn).toBe(1);
      expect(result.state._currentTurnPersistedItemCount).toBe(0);

      result.state.approve(result.interruptions[0]);

      result = await run(agent, result.state, { maxTurns: 1 });
      expect(result.finalOutput).toBe('All set.');
      expect(result.state._currentTurn).toBe(1);
    });

    it('does nothing when no input guardrails are configured', async () => {
      setTracingDisabled(false);
      setTraceProcessors([new BatchTraceProcessor(new FakeTracingExporter())]);
      const agent = new Agent({
        name: 'NoIG',
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('ok')],
            usage: new Usage(),
          }),
        ]),
      });
      const result = await run(agent, 'hi');
      expect(result.inputGuardrailResults).toEqual([]);
      expect(result.state._currentAgentSpan?.error).toBeNull();
      setTracingDisabled(true);
    });

    it('does nothing when no output guardrails are configured', async () => {
      setTracingDisabled(false);
      const agent = new Agent({
        name: 'NoOG',
        model: new ScriptedModel([
          modelResponse({
            output: [fakeModelMessage('ok')],
            usage: new Usage(),
          }),
        ]),
      });
      const spy = vi.spyOn(agent, 'processFinalOutput');
      const result = await run(agent, 'input');
      expect(result.outputGuardrailResults).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
      expect(result.state._currentAgentSpan?.error).toBeNull();
      setTracingDisabled(true);
    });

    it('getTurnInput assembles history correctly', () => {
      const msgItem = new MessageOutputItem(
        TEST_MODEL_MESSAGE,
        new Agent({ name: 'X' }),
      );
      const result1 = getTurnInput('hello', [msgItem]);
      expect(result1[0]).toEqual({
        type: 'message',
        role: 'user',
        content: 'hello',
      });
      expect(result1[1]).toEqual(msgItem.rawItem);
      const result2 = getTurnInput(
        [{ type: 'message', role: 'user', content: 'a' }],
        [msgItem],
      );
      expect(result2[0]).toEqual({
        type: 'message',
        role: 'user',
        content: 'a',
      });
      expect(result2[1]).toEqual(msgItem.rawItem);
    });

    it('uses runner-level reasoningItemIdPolicy when building follow-up turn input', async () => {
      const model = createReasoningPolicyModel({
        reasoningId: 'rs_first',
        functionId: 'fc_first',
        callId: 'call_first',
        toolName: 'echo_tool',
      });
      const echoTool = tool({
        name: 'echo_tool',
        description: 'Echoes a static payload.',
        parameters: z.object({}),
        execute: async () => 'ok',
      });
      const agent = new Agent({
        name: 'ReasoningPolicyAgent',
        model,
        tools: [echoTool],
      });
      const runner = new Runner({
        reasoningItemIdPolicy: 'omit',
      });

      const result = await runner.run(agent, 'hello');
      expect(result.finalOutput).toBe('done');
      expect(model.calls).toHaveLength(2);

      const secondRequestReasoning = getRequestInputItems(
        model.calls[1].request,
      ).find(
        (item): item is protocol.ReasoningItem => item.type === 'reasoning',
      );
      expect(secondRequestReasoning).toBeDefined();
      expect(secondRequestReasoning).not.toHaveProperty('id');

      const historyReasoning = result.history.find(
        (item): item is protocol.ReasoningItem => item.type === 'reasoning',
      );
      expect(historyReasoning).toBeDefined();
      expect(historyReasoning).not.toHaveProperty('id');
    });

    it('allows per-run reasoningItemIdPolicy to override runner defaults', async () => {
      const model = createReasoningPolicyModel({
        reasoningId: 'rs_override',
        functionId: 'fc_override',
        callId: 'call_override',
        toolName: 'echo_tool',
      });
      const echoTool = tool({
        name: 'echo_tool',
        description: 'Echoes a static payload.',
        parameters: z.object({}),
        execute: async () => 'ok',
      });
      const agent = new Agent({
        name: 'ReasoningPolicyOverrideAgent',
        model,
        tools: [echoTool],
      });
      const runner = new Runner({
        reasoningItemIdPolicy: 'preserve',
      });

      await runner.run(agent, 'hello', {
        reasoningItemIdPolicy: 'omit',
      });

      const secondRequestReasoning = getRequestInputItems(
        model.calls[1].request,
      ).find(
        (item): item is protocol.ReasoningItem => item.type === 'reasoning',
      );
      expect(secondRequestReasoning).toBeDefined();
      expect(secondRequestReasoning).not.toHaveProperty('id');
    });

    it('passes reasoningItemIdPolicy through the run() helper', async () => {
      const model = createReasoningPolicyModel({
        reasoningId: 'rs_helper',
        functionId: 'fc_helper',
        callId: 'call_helper',
        toolName: 'echo_tool',
      });
      const echoTool = tool({
        name: 'echo_tool',
        description: 'Echoes a static payload.',
        parameters: z.object({}),
        execute: async () => 'ok',
      });
      const agent = new Agent({
        name: 'ReasoningPolicyHelperAgent',
        model,
        tools: [echoTool],
      });

      await run(agent, 'hello', {
        reasoningItemIdPolicy: 'omit',
      });

      const secondRequestReasoning = getRequestInputItems(
        model.calls[1].request,
      ).find(
        (item): item is protocol.ReasoningItem => item.type === 'reasoning',
      );
      expect(secondRequestReasoning).toBeDefined();
      expect(secondRequestReasoning).not.toHaveProperty('id');
    });

    it('uses serialized reasoningItemIdPolicy when resuming without override', async () => {
      const model = createReasoningPolicyModel({
        reasoningId: 'rs_resume',
        functionId: 'fc_resume',
        callId: 'call_resume',
        toolName: 'approval_tool',
      });
      const approvalTool = tool({
        name: 'approval_tool',
        description: 'Requires approval before execution.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'ok',
      });
      const agent = new Agent({
        name: 'ReasoningPolicyResumeAgent',
        model,
        tools: [approvalTool],
        toolUseBehavior: 'run_llm_again',
      });

      const firstRun = await run(agent, 'hello', {
        reasoningItemIdPolicy: 'omit',
        maxTurns: 1,
      });
      expect(firstRun.interruptions).toHaveLength(1);
      firstRun.state.approve(firstRun.interruptions[0]);

      const restoredState = await RunState.fromString(
        agent,
        firstRun.state.toString(),
      );
      const resumedRun = await run(agent, restoredState, { maxTurns: 1 });

      expect(resumedRun.finalOutput).toBe('done');
      expect(model.calls).toHaveLength(2);
      const secondRequestReasoning = getRequestInputItems(
        model.calls[1].request,
      ).find(
        (item): item is protocol.ReasoningItem => item.type === 'reasoning',
      );
      expect(secondRequestReasoning).toBeDefined();
      expect(secondRequestReasoning).not.toHaveProperty('id');
    });

    it('run() helper reuses underlying runner', async () => {
      const spy = vi.spyOn(Runner.prototype, 'run');
      const agentA = new Agent({ name: 'AA' });
      const agentB = new Agent({ name: 'BB' });
      await run(agentA, '1');
      await run(agentB, '2');
      expect(spy.mock.instances[0]).toBe(spy.mock.instances[1]);
      spy.mockRestore();
    });

    describe('sessions', () => {
      class MemorySession implements Session {
        #history: AgentInputItem[];
        #added: AgentInputItem[][] = [];
        sessionId?: string;

        constructor(history: AgentInputItem[] = []) {
          this.#history = [...history];
        }

        get added(): AgentInputItem[][] {
          return this.#added;
        }

        async getSessionId(): Promise<string> {
          if (!this.sessionId) {
            this.sessionId = 'conv_test';
          }
          return this.sessionId;
        }

        async getItems(limit?: number): Promise<AgentInputItem[]> {
          if (limit == null) {
            return [...this.#history];
          }
          return this.#history.slice(-limit);
        }

        async addItems(items: AgentInputItem[]): Promise<void> {
          this.#added.push(items);
          this.#history.push(...items);
        }

        async popItem(): Promise<AgentInputItem | undefined> {
          return this.#history.pop();
        }

        async clearSession(): Promise<void> {
          this.#history = [];
          this.sessionId = undefined;
        }
      }

      class RecordingModel extends ScriptedModel {
        get lastRequest(): Readonly<ModelRequest> | undefined {
          return this.lastCall?.request;
        }
      }

      it('uses session history and stores run results', async () => {
        const model = new RecordingModel([
          modelResponse({
            ...TEST_MODEL_RESPONSE_BASIC,
            output: [fakeModelMessage('response')],
          }),
        ]);
        const agent = new Agent({ name: 'SessionAgent', model });
        const historyItem = fakeModelMessage(
          'earlier message',
        ) as AgentInputItem;
        const session = new MemorySession([historyItem]);
        const runner = new Runner();

        await runner.run(agent, 'How are you?', { session });

        const recordedInput = model.lastRequest?.input as AgentInputItem[];
        expect(Array.isArray(recordedInput)).toBe(true);
        expect(recordedInput[0]).toEqual(historyItem);
        expect(recordedInput[1]).toMatchObject({
          role: 'user',
          content: 'How are you?',
        });

        expect(session.added).toHaveLength(1);
        expect(session.added[0][0]).toMatchObject({
          role: 'user',
          content: 'How are you?',
        });
        expect(session.added[0][1]).toMatchObject({ role: 'assistant' });
        const savedAssistant = session
          .added[0][1] as protocol.AssistantMessageItem;
        const firstPart = Array.isArray(savedAssistant.content)
          ? (savedAssistant.content[0] as { providerData?: unknown })
          : undefined;
        expect(firstPart?.providerData).toBeUndefined();
      });

      it('persists accepted tool results before surfacing cancellation', async () => {
        const controller = new AbortController();
        const abortReason = new Error('stop after tool result');
        let markToolStarted: (() => void) | undefined;
        const toolStarted = new Promise<void>((resolve) => {
          markToolStarted = resolve;
        });
        let releaseTool: (() => void) | undefined;
        const toolCanFinish = new Promise<void>((resolve) => {
          releaseTool = resolve;
        });
        const abortableTool = tool({
          name: 'test',
          description: 'finishes after cancellation',
          parameters: z.object({ test: z.string() }),
          execute: async () => {
            markToolStarted?.();
            await toolCanFinish;
            return 'completed tool result';
          },
        });
        const model = new ScriptedModel([
          modelResponse({
            output: [{ ...TEST_MODEL_FUNCTION_CALL }],
            usage: new Usage(),
          }),
        ]);
        const agent = new Agent({
          name: 'SessionCancellationAgent',
          model,
          tools: [abortableTool],
        });
        const session = new MemorySession();

        const runPromise = run(agent, 'start', {
          session,
          signal: controller.signal,
        });
        const rejection = expect(runPromise).rejects.toBe(abortReason);
        await toolStarted;

        controller.abort(abortReason);
        releaseTool?.();

        await rejection;
        expect(session.added).toHaveLength(1);
        expect(session.added[0].map((item) => item.type)).toEqual([
          'message',
          'function_call',
          'function_call_result',
        ]);
      });

      it('does not persist a cancelled tool turn again when its state resumes', async () => {
        const controller = new AbortController();
        const abortReason = new Error('stop before the next model turn');
        let markToolStarted: (() => void) | undefined;
        const toolStarted = new Promise<void>((resolve) => {
          markToolStarted = resolve;
        });
        let releaseTool: (() => void) | undefined;
        const toolCanFinish = new Promise<void>((resolve) => {
          releaseTool = resolve;
        });
        const abortableTool = tool({
          name: 'test',
          description: 'finishes after cancellation',
          parameters: z.object({ test: z.string() }),
          execute: async () => {
            markToolStarted?.();
            await toolCanFinish;
            return 'completed tool result';
          },
        });
        const model = new ScriptedModel([
          modelResponse({
            output: [{ ...TEST_MODEL_FUNCTION_CALL }],
            usage: new Usage(),
          }),
          modelResponse({
            output: [fakeModelMessage('resumed response')],
            usage: new Usage(),
          }),
        ]);
        const agent = new Agent({
          name: 'SessionCancellationResumeAgent',
          model,
          tools: [abortableTool],
        });
        const state = new RunState(new RunContext(), 'start', agent, 10);
        const session = new MemorySession([user('start')]);

        const runPromise = run(agent, state, {
          session,
          signal: controller.signal,
        });
        const rejection = expect(runPromise).rejects.toBe(abortReason);
        await toolStarted;

        controller.abort(abortReason);
        releaseTool?.();

        await rejection;
        expect(session.added).toHaveLength(1);
        expect(session.added[0].map((item) => item.type)).toEqual([
          'function_call',
          'function_call_result',
        ]);

        await run(agent, state, { session });

        expect(session.added).toHaveLength(2);
        expect(session.added[1].map((item) => item.type)).toEqual(['message']);
        expect(
          session.added
            .flat()
            .filter(
              (item) =>
                item.type === 'function_call' &&
                item.callId === TEST_MODEL_FUNCTION_CALL.callId,
            ),
        ).toHaveLength(1);
      });

      it('does not execute or repersist a handoff skipped by cancellation', async () => {
        const controller = new AbortController();
        const abortReason = new Error('stop before the handoff');
        let markToolStarted: (() => void) | undefined;
        const toolStarted = new Promise<void>((resolve) => {
          markToolStarted = resolve;
        });
        let releaseTool: (() => void) | undefined;
        const toolCanFinish = new Promise<void>((resolve) => {
          releaseTool = resolve;
        });
        const abortableTool = tool({
          name: 'test',
          description: 'finishes after cancellation',
          parameters: z.object({ test: z.string() }),
          execute: async () => {
            markToolStarted?.();
            await toolCanFinish;
            return 'completed tool result';
          },
        });
        const agentB = new Agent({
          name: 'SessionCancellationHandoffTarget',
          model: new ScriptedModel([
            modelResponse({
              output: [fakeModelMessage('handoff response')],
              usage: new Usage(),
            }),
          ]),
        });
        const onHandoff = vi.fn();
        const handoffToB = handoff(agentB, { onHandoff });
        const handoffCall: protocol.FunctionCallItem = {
          id: 'handoff-call',
          type: 'function_call',
          name: handoffToB.toolName,
          callId: 'handoff-call',
          status: 'completed',
          arguments: '{}',
        };
        const agentA = new Agent({
          name: 'SessionCancellationHandoffSource',
          model: new ScriptedModel([
            modelResponse({
              output: [{ ...TEST_MODEL_FUNCTION_CALL }, handoffCall],
              usage: new Usage(),
            }),
            modelResponse({
              output: [fakeModelMessage('resumed source response')],
              usage: new Usage(),
            }),
          ]),
          tools: [abortableTool],
          handoffs: [handoffToB],
        });
        const state = new RunState(new RunContext(), 'start', agentA, 10);
        const session = new MemorySession([user('start')]);

        const runPromise = run(agentA, state, {
          session,
          signal: controller.signal,
        });
        const rejection = expect(runPromise).rejects.toBe(abortReason);
        await toolStarted;

        controller.abort(abortReason);
        releaseTool?.();

        await rejection;
        expect(state._currentStep?.type).toBe('next_step_run_again');
        expect(onHandoff).not.toHaveBeenCalled();
        expect(session.added).toHaveLength(1);

        const result = await run(agentA, state, { session });

        expect(result.finalOutput).toBe('resumed source response');
        expect(onHandoff).not.toHaveBeenCalled();
        expect(session.added).toHaveLength(2);
        expect(session.added[1].map((item) => item.type)).toEqual(['message']);
        expect(
          session.added
            .flat()
            .filter(
              (item) =>
                item.type === 'function_call' &&
                item.callId === TEST_MODEL_FUNCTION_CALL.callId,
            ),
        ).toHaveLength(1);
        expect(
          session.added
            .flat()
            .filter(
              (item) =>
                item.type === 'function_call_result' &&
                item.callId === handoffCall.callId &&
                item.status === 'incomplete',
            ),
        ).toHaveLength(1);
      });

      it('applies runner-level reasoningItemIdPolicy to replayed session history', async () => {
        class ReasoningPreservingSession extends MemorySession {
          preserveReasoningItemIdsForPersistence(): boolean {
            return true;
          }
        }

        const model = new RecordingModel([
          modelResponse({
            ...TEST_MODEL_RESPONSE_BASIC,
            output: [fakeModelMessage('response')],
          }),
        ]);
        const agent = new Agent({ name: 'SessionReasoningAgent', model });
        const session = new ReasoningPreservingSession([
          {
            id: 'rs_persisted',
            type: 'reasoning',
            content: [{ type: 'input_text', text: 'stored reasoning' }],
          },
        ]);
        const runner = new Runner({ reasoningItemIdPolicy: 'omit' });

        await runner.run(agent, 'new input', { session });

        expect(model.lastRequest).toBeDefined();
        const reasoningItem = getRequestInputItems(model.lastRequest!).find(
          (item): item is protocol.ReasoningItem => item.type === 'reasoning',
        );
        expect(reasoningItem).toEqual({
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'stored reasoning' }],
        });
      });

      it('allows list inputs with session history and no session input callback', async () => {
        const model = new RecordingModel([
          modelResponse({
            ...TEST_MODEL_RESPONSE_BASIC,
            output: [fakeModelMessage('list response')],
          }),
        ]);
        const agent = new Agent({ name: 'ListSession', model });
        const historyItem = user('History stays');
        const session = new MemorySession([historyItem]);
        const runner = new Runner();

        await runner.run(agent, [user('Hello')], { session });

        const recordedInput = model.lastRequest?.input as AgentInputItem[];
        expect(Array.isArray(recordedInput)).toBe(true);
        expect(recordedInput).toHaveLength(2);
        expect(getFirstTextContent(recordedInput[0])).toBe('History stays');
        expect(getFirstTextContent(recordedInput[1])).toBe('Hello');

        expect(session.added).toHaveLength(1);
        expect(getFirstTextContent(session.added[0][0])).toBe('Hello');
        expect(
          session.added[0][1] &&
            typeof session.added[0][1] === 'object' &&
            'type' in session.added[0][1],
        ).toBe(true);
      });

      it('allows list inputs when session input callback is provided', async () => {
        const model = new RecordingModel([
          modelResponse({
            ...TEST_MODEL_RESPONSE_BASIC,
            output: [fakeModelMessage('response')],
          }),
        ]);
        const agent = new Agent({ name: 'SessionCallbackAgent', model });
        const sessionHistory: AgentInputItem[] = [
          user('Keep this history item'),
          assistant('Drop this assistant reply'),
        ];
        const session = new MemorySession([...sessionHistory]);
        const runner = new Runner({
          sessionInputCallback: (history, newItems) => {
            return history
              .filter(
                (item) =>
                  item.type === 'message' &&
                  'role' in item &&
                  item.role === 'user',
              )
              .concat(newItems);
          },
        });

        await runner.run(agent, [user('New message')], { session });

        const recordedInput = model.lastRequest?.input as AgentInputItem[];
        expect(Array.isArray(recordedInput)).toBe(true);
        expect(recordedInput).toHaveLength(2);
        expect(
          recordedInput[0].type === 'message' &&
            'role' in recordedInput[0] &&
            recordedInput[0].role,
        ).toBe('user');
        expect(getFirstTextContent(recordedInput[0])).toBe(
          'Keep this history item',
        );
        expect(
          recordedInput[1].type === 'message' &&
            'role' in recordedInput[1] &&
            recordedInput[1].role,
        ).toBe('user');
        expect(getFirstTextContent(recordedInput[1])).toBe('New message');
      });

      it('supports async session input callback', async () => {
        const model = new RecordingModel([
          modelResponse({
            ...TEST_MODEL_RESPONSE_BASIC,
            output: [fakeModelMessage('response')],
          }),
        ]);
        const agent = new Agent({ name: 'AsyncSessionCallback', model });
        const session = new MemorySession([
          user('Older message'),
          user('Newest history'),
        ]);
        const runner = new Runner();

        await runner.run(agent, [user('Fresh input')], {
          session,
          sessionInputCallback: async (history, newItems) => {
            await Promise.resolve();
            return history.slice(-1).concat(newItems);
          },
        });

        const recordedInput = model.lastRequest?.input as AgentInputItem[];
        expect(Array.isArray(recordedInput)).toBe(true);
        expect(recordedInput).toHaveLength(2);
        expect(getFirstTextContent(recordedInput[0])).toBe('Newest history');
        expect(getFirstTextContent(recordedInput[1])).toBe('Fresh input');
      });

      it('persists transformed session input from callback', async () => {
        const model = new RecordingModel([
          modelResponse({
            ...TEST_MODEL_RESPONSE_BASIC,
            output: [fakeModelMessage('session response')],
          }),
        ]);
        const agent = new Agent({ name: 'SessionTransform', model });
        const session = new MemorySession();
        const runner = new Runner();
        const original = 'Sensitive payload';
        const redacted = '[redacted]';

        await runner.run(agent, original, {
          session,
          sessionInputCallback: (history, newItems) => {
            expect(history).toHaveLength(0);
            if (newItems[0] && typeof newItems[0] === 'object') {
              (newItems[0] as protocol.UserMessageItem).content = redacted;
            }
            return history.concat(newItems);
          },
        });

        const recordedInput = model.lastRequest?.input as AgentInputItem[];
        expect(recordedInput[recordedInput.length - 1]).toMatchObject({
          role: 'user',
          content: redacted,
        });

        expect(session.added).toHaveLength(1);
        const persistedTurn = session.added[0];
        expect(persistedTurn[0]).toMatchObject({
          role: 'user',
          content: redacted,
        });
      });

      it('does not persist duplicate user input when a model retry succeeds in the same run', async () => {
        class RetryRecordingModel extends ScriptedModel {
          readonly requests: ModelRequest[];

          constructor(response: ModelResponse) {
            const requests: ModelRequest[] = [];
            const record = (request: Readonly<ModelRequest>) => {
              requests.push(cloneModelRequest(request));
            };
            super([
              modelResponder((call) => {
                record(call.request);
                const error = new Error('temporary failure') as Error & {
                  statusCode?: number;
                };
                error.statusCode = 503;
                throw error;
              }),
              modelResponder((call) => {
                record(call.request);
                return response;
              }),
            ]);
            this.requests = requests;
          }

          get attempts(): number {
            return this.calls.length;
          }
        }

        const model = new RetryRecordingModel({
          ...TEST_MODEL_RESPONSE_BASIC,
          output: [fakeModelMessage('retry response')],
          usage: new Usage({ requests: 1 }),
        });
        const agent = new Agent({
          name: 'RetrySessionAgent',
          model,
          modelSettings: {
            retry: {
              maxRetries: 1,
              backoff: { initialDelayMs: 0, jitter: false },
              policy: ({ normalized }) => normalized.statusCode === 503,
            },
          },
        });
        const session = new MemorySession();
        const runner = new Runner();

        const result = await runner.run(agent, 'Retry me once', { session });

        expect(result.finalOutput).toBe('retry response');
        expect(model.attempts).toBe(2);
        expect(model.requests).toHaveLength(2);
        expect(
          getFirstTextContent(getRequestInputItems(model.requests[0])[0]!),
        ).toBe('Retry me once');
        expect(
          getFirstTextContent(getRequestInputItems(model.requests[1])[0]!),
        ).toBe('Retry me once');

        expect(session.added).toHaveLength(1);
        const persistedTexts = session.added[0]
          .map((item) => getFirstTextContent(item))
          .filter((text): text is string => typeof text === 'string');
        expect(
          persistedTexts.filter((text) => text === 'Retry me once'),
        ).toHaveLength(1);
        expect(result.state.usage.requests).toBe(2);
      });

      it('does not duplicate history when callback clones entries', async () => {
        const model = new RecordingModel([
          modelResponse({
            ...TEST_MODEL_RESPONSE_BASIC,
            output: [fakeModelMessage('clone response')],
          }),
        ]);
        const history = [user('Existing history item')];
        const session = new MemorySession(history);
        const agent = new Agent({ name: 'CloneSession', model });
        const runner = new Runner();

        await runner.run(agent, [user('Fresh input')], {
          session,
          sessionInputCallback: (incomingHistory, newItems) => {
            const clonedHistory = incomingHistory.map((item) =>
              structuredClone(item),
            );
            const clonedNewItems = newItems.map((item) =>
              structuredClone(item),
            );
            return clonedHistory.concat(clonedNewItems);
          },
        });

        expect(session.added).toHaveLength(1);
        const [persistedItems] = session.added;
        const persistedUsers = persistedItems.filter(
          (item): item is protocol.UserMessageItem =>
            item.type === 'message' && 'role' in item && item.role === 'user',
        );
        expect(persistedUsers).toHaveLength(1);
        expect(getFirstTextContent(persistedUsers[0])).toBe('Fresh input');
      });

      it.each([
        { name: 'run', stream: false },
        { name: 'stream', stream: true },
      ])(
        'does not grow session history from repeated references across $name turns',
        async ({ stream }) => {
          const model = stream
            ? new StreamingModel(fakeModelMessage('assistant'))
            : new ScriptedModel(
                Array.from(
                  Array.from({ length: 3 }, (_, turn) => ({
                    ...TEST_MODEL_RESPONSE_BASIC,
                    output: [fakeModelMessage(`assistant ${turn}`)],
                  })),
                  modelResponse,
                ),
              );
          const agent = new Agent({ name: 'RepeatedHistorySession', model });
          const session = new MemorySession();
          const sessionInputCallback = (
            history: AgentInputItem[],
            newItems: AgentInputItem[],
          ) => {
            if (history.length === 0) {
              return newItems;
            }
            return history.concat(history[0], newItems);
          };

          for (let turn = 0; turn < 3; turn += 1) {
            if (stream) {
              const result = await run(agent, `user ${turn}`, {
                session,
                sessionInputCallback,
                stream: true,
              });
              await result.completed;
            } else {
              await run(agent, `user ${turn}`, {
                session,
                sessionInputCallback,
              });
            }
          }

          const storedItems = await session.getItems();
          const storedUserMessages = storedItems.filter(
            (item): item is protocol.UserMessageItem =>
              item.type === 'message' && 'role' in item && item.role === 'user',
          );
          expect(
            storedUserMessages.map((item) => getFirstTextContent(item)),
          ).toEqual(['user 0', 'user 1', 'user 2']);
          expect(storedItems).toHaveLength(6);
        },
      );

      it('persists reordered new items ahead of matching history', async () => {
        const model = new RecordingModel([
          modelResponse({
            ...TEST_MODEL_RESPONSE_BASIC,
            output: [fakeModelMessage('reordered response')],
          }),
        ]);
        const historyMessage = user('Repeatable message');
        const newMessage = user('Repeatable message');
        const session = new MemorySession([historyMessage]);
        const agent = new Agent({ name: 'ReorderedSession', model });
        const runner = new Runner({
          sessionInputCallback: (history, newItems) => newItems.concat(history),
        });

        await runner.run(agent, [newMessage], { session });

        expect(session.added).toHaveLength(1);
        const [persisted] = session.added;
        const persistedUsers = persisted.filter(
          (item): item is protocol.UserMessageItem =>
            item.type === 'message' && 'role' in item && item.role === 'user',
        );
        expect(persistedUsers).toHaveLength(1);
        expect(getFirstTextContent(persistedUsers[0])).toBe(
          'Repeatable message',
        );
      });

      it('persists binary payloads that share prefixes with history', async () => {
        const model = new RecordingModel([
          modelResponse({
            ...TEST_MODEL_RESPONSE_BASIC,
            output: [fakeModelMessage('binary response')],
          }),
        ]);
        const historyPayload = new Uint8Array(32);
        const newPayload = new Uint8Array(32);
        for (let i = 0; i < 32; i++) {
          const value = i < 20 ? 0xaa : i;
          historyPayload[i] = value;
          newPayload[i] = value;
        }
        historyPayload[31] = 0xbb;
        newPayload[31] = 0xcc;

        const session = new MemorySession([
          user('History with binary', { payload: historyPayload }),
        ]);
        const agent = new Agent({ name: 'BinarySession', model });
        const runner = new Runner();

        await runner.run(agent, [user('Binary input')], {
          session,
          sessionInputCallback: (history, newItems) => {
            const clonedHistory = history.map((item) => structuredClone(item));
            const updatedNewItems = newItems.map((item) => {
              const cloned = structuredClone(item);
              cloned.providerData = { payload: newPayload };
              return cloned;
            });
            return clonedHistory.concat(updatedNewItems);
          },
        });

        expect(session.added).toHaveLength(1);
        const [persistedItems] = session.added;
        const persistedPayloads = persistedItems
          .filter(
            (item): item is protocol.UserMessageItem =>
              item.type === 'message' &&
              'role' in item &&
              item.role === 'user' &&
              item.providerData?.payload,
          )
          .map((item) => item.providerData?.payload);
        const expectedNewPayload = `data:text/plain;base64,${Buffer.from(newPayload).toString('base64')}`;
        const expectedHistoryPayload = `data:text/plain;base64,${Buffer.from(historyPayload).toString('base64')}`;
        expect(persistedPayloads).toContain(expectedNewPayload);
        expect(persistedPayloads).not.toContain(expectedHistoryPayload);
      });

      it('throws when session input callback returns invalid data', async () => {
        const model = new RecordingModel([
          modelResponse({
            ...TEST_MODEL_RESPONSE_BASIC,
            output: [fakeModelMessage('response')],
          }),
        ]);
        const agent = new Agent({ name: 'InvalidCallback', model });
        const session = new MemorySession([user('history')]);
        const runner = new Runner();

        await expect(
          runner.run(agent, 'Hello', {
            session,
            sessionInputCallback: () =>
              'not-an-array' as unknown as AgentInputItem[],
          }),
        ).rejects.toThrow(
          'Session input callback must return an array of AgentInputItem objects.',
        );
      });

      it('stores function tool call and structured output in session', async () => {
        const functionCall: protocol.FunctionCallItem = {
          type: 'function_call',
          callId: 'call-weather',
          name: 'weather_lookup',
          status: 'completed',
          arguments: JSON.stringify({ city: 'San Francisco' }),
          providerData: { source: 'openai' },
        } as protocol.FunctionCallItem;

        const model = new ScriptedModel([
          modelResponse({
            output: [functionCall],
            usage: new Usage(),
          }),
          modelResponse({
            output: [fakeModelMessage('Weather retrieved.')],
            usage: new Usage(),
          }),
        ]);

        const weatherTool = tool({
          name: 'weather_lookup',
          description: 'Looks up weather information',
          parameters: z.object({ city: z.string() }),
          execute: async ({ city }) => [
            {
              type: 'text',
              text: `Weather for ${city}`,
            },
          ],
        });

        const agent = new Agent({
          name: 'FunctionToolAgent',
          model,
          tools: [weatherTool],
        });

        const session = new MemorySession();
        const runner = new Runner();

        await runner.run(agent, 'What is the weather in San Francisco?', {
          session,
        });

        expect(session.added).toHaveLength(1);
        const savedItems = session.added[0];
        expect(savedItems).toHaveLength(4);
        const savedFunctionCall = savedItems[1] as protocol.FunctionCallItem;
        expect(savedFunctionCall.providerData).toEqual({ source: 'openai' });
        expect(savedFunctionCall.arguments).toBe(
          JSON.stringify({ city: 'San Francisco' }),
        );
        const savedResult = savedItems[2] as protocol.FunctionCallResultItem & {
          output: protocol.ToolCallStructuredOutput[];
        };
        expect(Array.isArray(savedResult.output)).toBe(true);
        expect(savedResult.output[0]).toMatchObject({
          type: 'input_text',
          text: 'Weather for San Francisco',
        });
      });

      it('stores hosted tool call metadata when approval is required', async () => {
        const hostedCall: protocol.HostedToolCallItem = {
          type: 'hosted_tool_call',
          id: 'approval-1',
          name: 'mcp_approval_request',
          status: 'completed',
          providerData: {
            type: 'mcp_approval_request',
            server_label: 'demo_server',
            name: 'file_search',
            id: 'approval-1',
            arguments: '{"query":"invoices"}',
          },
        } as protocol.HostedToolCallItem;

        const model = new ScriptedModel([
          modelResponse({
            output: [hostedCall],
            usage: new Usage(),
          }),
        ]);

        const hostedTool = hostedMcpTool({
          serverLabel: 'demo_server',
          serverUrl: 'https://example.com',
          requireApproval: {
            always: { toolNames: ['file_search'] },
          },
        });

        const agent = new Agent({
          name: 'HostedToolAgent',
          model,
          tools: [hostedTool],
        });

        const session = new MemorySession();
        const runner = new Runner();

        const result = await runner.run(agent, 'Find latest invoices', {
          session,
        });

        expect(result.interruptions).toHaveLength(1);
        expect(session.added).toHaveLength(1);
        const savedItems = session.added[0];
        expect(savedItems).toHaveLength(2);
        const savedHostedCall = savedItems[1] as protocol.HostedToolCallItem & {
          providerData: Record<string, unknown>;
        };
        expect(savedHostedCall.providerData).toEqual(hostedCall.providerData);
        expect(savedHostedCall.id).toBe('approval-1');
      });

      it('prevents duplicate function_call items when resuming from interruption after tool approval', async () => {
        // Regression test for issue #701
        //
        // Bug: When resuming a turn after approving a tool call, duplicate function_call items
        // were saved to the session. The bug occurred because _currentTurnPersistedItemCount
        // was incorrectly reset to 0 after resolveInterruptedTurn returned next_step_run_again,
        // causing saveToSession to save all items from the beginning of the turn, including
        // the already-persisted function_call item.
        //
        // Expected behavior: Only 1 function_call item should be saved to the session.
        // Buggy behavior: 2 function_call items (duplicate) were saved.
        //
        // Test scenario:
        // 1. Initial run with tool requiring approval creates an interruption
        // 2. Tool call is approved
        // 3. Run is resumed with the approved state
        // 4. Session should contain exactly 1 function_call item (not 2)

        const getWeatherTool = tool({
          name: 'get_weather',
          description: 'Get weather for a city',
          parameters: z.object({ city: z.string() }),
          needsApproval: async () => true, // Require approval for all calls
          execute: async ({ city }) => `Sunny, 72°F in ${city}`,
        });

        const model = new ScriptedModel([
          modelResponse({
            output: [
              {
                type: 'function_call',
                id: 'fc_1',
                callId: 'call_weather_1',
                name: 'get_weather',
                status: 'completed',
                arguments: JSON.stringify({ city: 'Oakland' }),
                providerData: {},
              } as protocol.FunctionCallItem,
            ],
            usage: new Usage(),
          }),
          modelResponse({
            output: [fakeModelMessage('The weather is sunny in Oakland.')],
            usage: new Usage(),
          }),
        ]);

        const agent = new Agent({
          name: 'Assistant',
          instructions: 'Use get_weather tool to answer weather questions.',
          model,
          tools: [getWeatherTool],
          toolUseBehavior: 'run_llm_again', // Must use 'run_llm_again' so resolveInterruptedTurn returns next_step_run_again
        });

        const session = new MemorySession();

        // Use sessionInputCallback to match the scenario from issue #701
        const sessionInputCallback = async (
          historyItems: AgentInputItem[],
          newItems: AgentInputItem[],
        ) => {
          return [...historyItems, ...newItems];
        };

        // Step 1: Initial run creates an interruption for tool approval
        let result = await run(
          agent,
          [{ role: 'user', content: "What's the weather in Oakland?" }],
          { session, sessionInputCallback },
        );

        // Step 2: Approve the tool call
        for (const interruption of result.interruptions || []) {
          result.state.approve(interruption);
        }

        // Step 3: Resume the run with the approved state
        // Note: No sessionInputCallback on resume - this is part of the bug scenario
        result = await run(agent, result.state, { session });

        // Step 4: Verify only one function_call item exists in the session
        const allItems = await session.getItems();
        const functionCalls = allItems.filter(
          (item): item is protocol.FunctionCallItem =>
            item.type === 'function_call' && item.callId === 'call_weather_1',
        );

        // The bug would cause 2 function_call items to be saved (duplicate)
        // The fix ensures only 1 function_call item is saved
        expect(functionCalls).toHaveLength(1);
      });

      it('does not duplicate already persisted items when the resumed run continues into additional turns', async () => {
        // Regression test for session persistence across resumed runs that execute additional turns.
        //
        // Scenario:
        // 1. First run is interrupted for tool approval, persisting the initial function_call.
        // 2. The run is resumed and continues into another tool call (additional turn).
        //
        // Expected behavior: Session history must not contain duplicate function_call items from the
        // already-persisted portion of the run.

        const getWeatherTool = tool({
          name: 'get_weather',
          description: 'Get weather for a city',
          parameters: z.object({ city: z.string() }),
          needsApproval: async () => true,
          execute: async ({ city }) => `Sunny, 72°F in ${city}`,
        });

        const getTimeTool = tool({
          name: 'get_time',
          description: 'Get the current time for a city',
          parameters: z.object({ city: z.string() }),
          execute: async ({ city }) => `12:00PM in ${city}`,
        });

        const model = new ScriptedModel([
          modelResponse({
            output: [
              {
                type: 'function_call',
                id: 'fc_1',
                callId: 'call_weather_1',
                name: 'get_weather',
                status: 'completed',
                arguments: JSON.stringify({ city: 'Oakland' }),
                providerData: {},
              } as protocol.FunctionCallItem,
            ],
            usage: new Usage(),
          }),
          modelResponse({
            output: [
              {
                type: 'function_call',
                id: 'fc_2',
                callId: 'call_time_1',
                name: 'get_time',
                status: 'completed',
                arguments: JSON.stringify({ city: 'Oakland' }),
                providerData: {},
              } as protocol.FunctionCallItem,
            ],
            usage: new Usage(),
          }),
          modelResponse({
            output: [
              fakeModelMessage('It is sunny in Oakland and it is noon.'),
            ],
            usage: new Usage(),
          }),
        ]);

        const agent = new Agent({
          name: 'Assistant',
          instructions:
            'Use get_weather and get_time tools to answer questions about Oakland.',
          model,
          tools: [getWeatherTool, getTimeTool],
          toolUseBehavior: 'run_llm_again',
        });

        const session = new MemorySession();

        const sessionInputCallback = async (
          historyItems: AgentInputItem[],
          newItems: AgentInputItem[],
        ) => {
          return [...historyItems, ...newItems];
        };

        // Step 1: Initial run creates an interruption for tool approval.
        let result = await run(
          agent,
          [
            {
              role: 'user',
              content: "What's the weather and time in Oakland?",
            },
          ],
          { session, sessionInputCallback },
        );

        for (const interruption of result.interruptions || []) {
          result.state.approve(interruption);
        }

        // Step 2: Resume the run; it continues into another turn due to a second tool call.
        result = await run(agent, result.state, { session });

        const allItems = await session.getItems();
        const weatherCalls = allItems.filter(
          (item): item is protocol.FunctionCallItem =>
            item.type === 'function_call' && item.callId === 'call_weather_1',
        );

        expect(weatherCalls).toHaveLength(1);
      });
    });
  });

  describe('callModelInputFilter', () => {
    class FilterTrackingModel extends ScriptedModel {
      get lastRequest(): Readonly<ModelRequest> | undefined {
        return this.lastCall?.request;
      }
    }

    class FilterStreamingModel extends ScriptedModel {
      constructor(response: ModelResponse) {
        super([modelResponse({ ...response, responseId: 'stream-filter' })]);
      }

      get lastRequest(): Readonly<ModelRequest> | undefined {
        return this.lastCall?.request;
      }
    }

    it('modifies model input for non-streaming runs', async () => {
      const model = new FilterTrackingModel([
        modelResponse({
          ...TEST_MODEL_RESPONSE_BASIC,
          output: [fakeModelMessage('filtered result')],
        }),
      ]);
      const agent = new Agent({
        name: 'FilterAgent',
        instructions: 'Base instructions',
        model,
      });

      const runner = new Runner({
        callModelInputFilter: ({ modelData }) => {
          return {
            instructions: `${modelData.instructions ?? ''} ::filtered`,
            input: modelData.input.slice(-1),
          };
        },
      });

      await runner.run(agent, [user('First input'), user('Second input')]);

      expect(model.lastRequest?.systemInstructions).toBe(
        'Base instructions ::filtered',
      );
      const sentInput = model.lastRequest?.input as AgentInputItem[];
      expect(Array.isArray(sentInput)).toBe(true);
      expect(sentInput).toHaveLength(1);
      expect(
        sentInput[0].type === 'message' &&
          'role' in sentInput[0] &&
          sentInput[0].role,
      ).toBe('user');
      expect(getFirstTextContent(sentInput[0])).toBe('Second input');
    });

    it('keeps duplicate calls before their outputs in non-streaming runs', async () => {
      const model = new FilterTrackingModel([
        modelResponse({
          ...TEST_MODEL_RESPONSE_BASIC,
          output: [fakeModelMessage('deduplicated result')],
        }),
      ]);
      const agent = new Agent({ name: 'DeduplicateCallAgent', model });
      const oldCall: protocol.FunctionCallItem = {
        type: 'function_call',
        callId: 'call_deduplicated',
        name: 'lookup',
        arguments: '{"value":"old"}',
      };
      const output: protocol.FunctionCallResultItem = {
        type: 'function_call_result',
        callId: 'call_deduplicated',
        name: 'lookup',
        status: 'completed',
        output: 'done',
      };
      const newCall: protocol.FunctionCallItem = {
        ...oldCall,
        arguments: '{"value":"new"}',
      };
      const runner = new Runner({
        callModelInputFilter: () => ({
          input: [oldCall, output, newCall],
        }),
      });

      await runner.run(agent, 'start');

      expect(model.lastRequest?.input).toEqual([newCall, output]);
    });

    it('persists normalized input plus items injected by a later model call', async () => {
      const executeTool = tool({
        name: 'execute_later_injection',
        description: 'Executes a test call.',
        parameters: z.object({}),
        execute: async () => 'done',
      });
      const model = new FilterTrackingModel([
        modelResponse({
          output: [
            {
              type: 'function_call',
              callId: 'call_execute_later_injection',
              name: executeTool.name,
              arguments: '{}',
            },
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [fakeModelMessage('done')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'LaterInjectionAgent',
        model,
        tools: [executeTool],
      });
      const oldCall: protocol.FunctionCallItem = {
        type: 'function_call',
        callId: 'call_input_duplicate',
        name: 'lookup',
        arguments: '{"value":"old"}',
      };
      const newCall: protocol.FunctionCallItem = {
        ...oldCall,
        arguments: '{"value":"new"}',
      };
      const injected = user('injected later');
      const persisted: AgentInputItem[] = [];
      const session: Session = {
        getSessionId: async () => 'later-injection',
        getItems: async () => [...persisted],
        addItems: async (items) => {
          persisted.push(...items);
        },
        popItem: async () => persisted.pop(),
        clearSession: async () => {
          persisted.length = 0;
        },
      };
      let filterCalls = 0;
      const runner = new Runner({
        callModelInputFilter: ({ modelData }) => {
          filterCalls++;
          return {
            ...modelData,
            input:
              filterCalls === 1
                ? modelData.input
                : [injected, ...modelData.input],
          };
        },
      });

      await runner.run(agent, [oldCall, newCall], { session });

      expect(persisted.slice(0, 2)).toEqual([injected, newCall]);
      expect(
        persisted.filter(
          (item) =>
            item.type === 'function_call' && item.callId === oldCall.callId,
        ),
      ).toHaveLength(1);
    });

    it('persists an earlier duplicate explicitly selected by the filter', async () => {
      const model = new FilterTrackingModel([
        modelResponse({
          output: [fakeModelMessage('done')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({ name: 'EarlierDuplicateAgent', model });
      const oldCall: protocol.FunctionCallItem = {
        type: 'function_call',
        callId: 'call_earlier_duplicate',
        name: 'lookup',
        arguments: '{"value":"old"}',
      };
      const newCall: protocol.FunctionCallItem = {
        ...oldCall,
        arguments: '{"value":"new"}',
      };
      const persisted: AgentInputItem[] = [];
      const session: Session = {
        getSessionId: async () => 'earlier-duplicate',
        getItems: async () => [...persisted],
        addItems: async (items) => {
          persisted.push(...items);
        },
        popItem: async () => persisted.pop(),
        clearSession: async () => {
          persisted.length = 0;
        },
      };
      const runner = new Runner({
        callModelInputFilter: ({ modelData }) => ({
          ...modelData,
          input: modelData.input.slice(0, 1),
        }),
      });

      await runner.run(agent, [oldCall, newCall], { session });

      expect(model.lastRequest?.input).toEqual([oldCall]);
      expect(persisted[0]).toEqual(oldCall);
    });

    it('persists a repeated current clone separately from equal-content history', async () => {
      const model = new FilterTrackingModel([
        modelResponse({
          output: [fakeModelMessage('done')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({ name: 'RepeatedCurrentCloneAgent', model });
      const sameMessage = user('same');
      const persisted: AgentInputItem[] = [structuredClone(sameMessage)];
      const session: Session = {
        getSessionId: async () => 'repeated-current-clone',
        getItems: async () => structuredClone(persisted),
        addItems: async (items) => {
          persisted.push(...structuredClone(items));
        },
        popItem: async () => persisted.pop(),
        clearSession: async () => {
          persisted.length = 0;
        },
      };
      const runner = new Runner({
        callModelInputFilter: ({ modelData }) => {
          const current = modelData.input.at(-1);
          if (!current) {
            throw new Error('Expected current input.');
          }
          return { ...modelData, input: [current, current] };
        },
      });

      await runner.run(agent, [sameMessage], { session });

      expect(model.lastRequest?.input).toHaveLength(2);
      expect(
        persisted.filter(
          (item) =>
            item.type === 'message' &&
            item.role === 'user' &&
            getFirstTextContent(item) === 'same',
        ),
      ).toHaveLength(3);
    });

    it('supports async filters for streaming runs', async () => {
      const streamingModel = new FilterStreamingModel({
        output: [fakeModelMessage('stream response')],
        usage: new Usage(),
      });
      const agent = new Agent({
        name: 'StreamFilterAgent',
        instructions: 'Stream instructions',
        model: streamingModel,
      });

      const runner = new Runner({
        callModelInputFilter: async ({ modelData }) => {
          await Promise.resolve();
          return {
            instructions: `${modelData.instructions ?? ''} ::stream`,
            input: modelData.input.slice(0, 1),
          };
        },
      });

      const result = await runner.run(agent, [user('Alpha'), user('Beta')], {
        stream: true,
      });

      const events: RunStreamEvent[] = [];
      for await (const e of result.toStream()) {
        events.push(e);
      }
      await result.completed;

      expect(streamingModel.lastRequest?.systemInstructions).toBe(
        'Stream instructions ::stream',
      );
      const streamInput = streamingModel.lastRequest?.input as AgentInputItem[];
      expect(Array.isArray(streamInput)).toBe(true);
      expect(streamInput).toHaveLength(1);
      expect(
        streamInput[0].type === 'message' &&
          'role' in streamInput[0] &&
          streamInput[0].role,
      ).toBe('user');
      expect(getFirstTextContent(streamInput[0])).toBe('Alpha');
    });

    it('keeps duplicate outputs at their latest position in streaming runs', async () => {
      const model = new FilterStreamingModel({
        output: [fakeModelMessage('stream response')],
        usage: new Usage(),
      });
      const agent = new Agent({ name: 'StreamDeduplicateOutputAgent', model });
      const oldOutput: protocol.FunctionCallResultItem = {
        type: 'function_call_result',
        callId: 'call_stream_output',
        name: 'lookup',
        status: 'completed',
        output: 'old',
      };
      const call: protocol.FunctionCallItem = {
        type: 'function_call',
        callId: 'call_stream_output',
        name: 'lookup',
        arguments: '{}',
      };
      const newOutput: protocol.FunctionCallResultItem = {
        ...oldOutput,
        output: 'new',
      };
      const runner = new Runner({
        callModelInputFilter: async () => ({
          input: [oldOutput, call, newOutput],
        }),
      });

      const result = await runner.run(agent, 'start', { stream: true });
      for await (const _event of result.toStream()) {
        // Drain the stream.
      }
      await result.completed;

      expect(model.lastRequest?.input).toEqual([call, newOutput]);
    });

    it('does not mutate run history when filter mutates input items', async () => {
      const model = new FilterTrackingModel([
        modelResponse({
          ...TEST_MODEL_RESPONSE_BASIC,
        }),
      ]);
      const agent = new Agent({
        name: 'HistoryFilterAgent',
        model,
      });

      const originalText = 'Top secret message';
      const redactedText = '[redacted]';

      const runner = new Runner({
        callModelInputFilter: ({ modelData }) => {
          const first = modelData.input[0];
          if (
            first?.type === 'message' &&
            Array.isArray(first.content) &&
            first.content.length > 0
          ) {
            const firstChunk = first.content[0] as { text?: string };
            if (firstChunk) {
              firstChunk.text = redactedText;
            }
          }
          return modelData;
        },
      });

      const result = await runner.run(agent, [user(originalText)]);

      const sentInput = model.lastRequest?.input as AgentInputItem[];
      expect(Array.isArray(sentInput)).toBe(true);
      expect(getFirstTextContent(sentInput[0])).toBe(redactedText);

      const history = result.history;
      expect(getFirstTextContent(history[0])).toBe(originalText);
    });

    it('does not duplicate existing session history when filters run', async () => {
      class TrackingSession implements Session {
        #history: AgentInputItem[];
        added: AgentInputItem[][] = [];
        sessionId?: string;

        constructor(history: AgentInputItem[]) {
          this.#history = [...history];
          this.sessionId = 'filter-session';
        }

        async getSessionId(): Promise<string> {
          if (!this.sessionId) {
            this.sessionId = 'filter-session';
          }
          return this.sessionId;
        }

        async getItems(): Promise<AgentInputItem[]> {
          return [...this.#history];
        }

        async addItems(items: AgentInputItem[]): Promise<void> {
          this.added.push(items);
          this.#history.push(...items);
        }

        async popItem(): Promise<AgentInputItem | undefined> {
          return this.#history.pop();
        }

        async clearSession(): Promise<void> {
          this.#history = [];
          this.sessionId = undefined;
        }
      }

      const model = new FilterTrackingModel([
        modelResponse({
          ...TEST_MODEL_RESPONSE_BASIC,
        }),
      ]);
      const agent = new Agent({
        name: 'FilterSessionAgent',
        model,
      });
      const historyMessage = user('Persisted history');
      const session = new TrackingSession([historyMessage]);
      const runner = new Runner({
        callModelInputFilter: ({ modelData }) => ({
          instructions: modelData.instructions,
          input: modelData.input,
        }),
      });

      await runner.run(agent, 'Fresh input', { session });

      expect(session.added).toHaveLength(1);
      const [persisted] = session.added;
      const persistedUsers = persisted.filter(
        (item) => 'role' in item && item.role === 'user',
      );
      expect(persistedUsers).toHaveLength(1);
      const persistedTexts = persistedUsers
        .map((item) => {
          if ('content' in item && typeof item.content === 'string') {
            return item.content;
          }
          return getFirstTextContent(item);
        })
        .filter((text): text is string => typeof text === 'string');
      expect(persistedTexts).toContain('Fresh input');
      expect(persistedTexts).not.toContain('Persisted history');
    });

    it('does not persist raw inputs when filters drop every item', async () => {
      class RecordingSession implements Session {
        #history: AgentInputItem[] = [];
        added: AgentInputItem[][] = [];
        #sessionId: string | undefined = 'empty-filter-session';

        async getSessionId(): Promise<string> {
          if (!this.#sessionId) {
            this.#sessionId = 'empty-filter-session';
          }
          return this.#sessionId;
        }

        async getItems(): Promise<AgentInputItem[]> {
          return [...this.#history];
        }

        async addItems(items: AgentInputItem[]): Promise<void> {
          this.added.push(items);
          this.#history.push(...items);
        }

        async popItem(): Promise<AgentInputItem | undefined> {
          return this.#history.pop();
        }

        async clearSession(): Promise<void> {
          this.#history = [];
          this.#sessionId = undefined;
        }
      }

      const model = new FilterTrackingModel([
        modelResponse({
          ...TEST_MODEL_RESPONSE_BASIC,
        }),
      ]);
      const agent = new Agent({
        name: 'EmptyFilterAgent',
        model,
      });
      const session = new RecordingSession();

      const runner = new Runner({
        callModelInputFilter: ({ modelData }) => ({
          instructions: modelData.instructions,
          input: [],
        }),
      });

      const secret = 'sensitive payload';
      const result = await runner.run(agent, secret, { session });

      expect(result.finalOutput).toBe('Hello World');
      expect(model.lastRequest?.input).toEqual([]);

      expect(session.added).toHaveLength(1);
      const persisted = session.added[0];
      const persistedTexts = persisted
        .map((item) => getFirstTextContent(item))
        .filter((text): text is string => typeof text === 'string');
      expect(persistedTexts).not.toContain(secret);
      const userItems = persisted.filter(
        (item) => 'role' in item && item.role === 'user',
      );
      expect(userItems).toHaveLength(0);
    });

    it('resets per-turn persistence when resuming from a prior run state', async () => {
      class RecordingSession implements Session {
        #history: AgentInputItem[] = [];
        added: AgentInputItem[][] = [];

        async getSessionId(): Promise<string> {
          return 'persist-reset-session';
        }

        async getItems(): Promise<AgentInputItem[]> {
          return [...this.#history];
        }

        async addItems(items: AgentInputItem[]): Promise<void> {
          this.added.push(items);
          this.#history.push(...items);
        }

        async popItem(): Promise<AgentInputItem | undefined> {
          return this.#history.pop();
        }

        async clearSession(): Promise<void> {
          this.#history = [];
        }
      }

      const model = new ScriptedModel([
        modelResponse({
          output: [fakeModelMessage('first turn')],
          usage: new Usage(),
        }),
        modelResponse({
          output: [fakeModelMessage('second turn')],
          usage: new Usage(),
        }),
      ]);

      const agent = new Agent({ name: 'PersistCounterAgent', model });
      const session = new RecordingSession();
      const runner = new Runner();

      const firstRun = await runner.run(agent, 'hello', { session });

      expect(firstRun.state._currentTurnPersistedItemCount).toBe(1);

      const resumedState = firstRun.state;
      resumedState._originalInput = 'follow-up';
      resumedState._currentStep = { type: 'next_step_run_again' } as const;
      resumedState._lastTurnResponse = undefined;
      resumedState._lastProcessedResponse = undefined;
      resumedState._noActiveAgentRun = true;
      resumedState._currentTurnPersistedItemCount = 5;

      const secondRun = await runner.run(agent, resumedState, { session });

      expect(secondRun.finalOutput).toBe('second turn');
      expect(session.added.length).toBeGreaterThanOrEqual(2);
      const newlyPersisted = session.added[session.added.length - 1];
      const texts = newlyPersisted
        .map((item) => getFirstTextContent(item))
        .filter((text): text is string => typeof text === 'string');
      expect(texts).toContain('second turn');
    });

    it('does not double-count turns when resuming an in-progress turn', async () => {
      const model = new ScriptedModel([
        modelResponse({
          output: [fakeModelMessage('done')],
          usage: new Usage(),
        }),
      ]);

      const agent = new Agent({ name: 'TurnResumeAgent', model });
      const runner = new Runner();

      const state = new RunState(new RunContext(), 'hi', agent, 1);
      state._currentTurn = 1;
      (state as any)._currentTurnInProgress = true;
      state._currentStep = { type: 'next_step_run_again' } as const;

      const result = await runner.run(agent, state);

      expect(result.state._currentTurn).toBe(1);
      expect(result.finalOutput).toBe('done');
    });

    it('advances turns after resuming an in-progress turn that continues', async () => {
      class RecordingSession implements Session {
        #history: AgentInputItem[] = [];
        added: AgentInputItem[][] = [];

        async getSessionId(): Promise<string> {
          return 'resume-in-progress-session';
        }

        async getItems(): Promise<AgentInputItem[]> {
          return [...this.#history];
        }

        async addItems(items: AgentInputItem[]): Promise<void> {
          this.added.push(items);
          this.#history.push(...items);
        }

        async popItem(): Promise<AgentInputItem | undefined> {
          return this.#history.pop();
        }

        async clearSession(): Promise<void> {
          this.#history = [];
        }
      }

      const model = new ScriptedModel([
        modelResponse({
          output: [{ ...TEST_MODEL_FUNCTION_CALL }],
          usage: new Usage(),
        }),
        modelResponse({
          output: [fakeModelMessage('second turn')],
          usage: new Usage(),
        }),
      ]);

      const agent = new Agent({
        name: 'ResumeInProgressContinueAgent',
        model,
        tools: [TEST_TOOL],
      });
      const runner = new Runner();
      const session = new RecordingSession();

      const state = new RunState(new RunContext(), 'hi', agent, 2);
      state._currentTurn = 1;
      (state as any)._currentTurnInProgress = true;
      state._currentStep = { type: 'next_step_run_again' } as const;
      state._noActiveAgentRun = true;

      const result = await runner.run(agent, state, { session });

      expect(result.finalOutput).toBe('second turn');
      expect(result.state._currentTurn).toBe(2);
      expect(session.added.length).toBeGreaterThan(0);
      const newlyPersisted = session.added[session.added.length - 1];
      const texts = newlyPersisted
        .map((item) => getFirstTextContent(item))
        .filter((text): text is string => typeof text === 'string');
      expect(texts).toContain('second turn');
    });

    it('clears stale per-turn persistence when a resumed run advances to a new turn', async () => {
      class RecordingSession implements Session {
        #history: AgentInputItem[] = [];
        added: AgentInputItem[][] = [];

        async getSessionId(): Promise<string> {
          return 'resume-in-progress-reset-session';
        }

        async getItems(): Promise<AgentInputItem[]> {
          return [...this.#history];
        }

        async addItems(items: AgentInputItem[]): Promise<void> {
          this.added.push(items);
          this.#history.push(...items);
        }

        async popItem(): Promise<AgentInputItem | undefined> {
          return this.#history.pop();
        }

        async clearSession(): Promise<void> {
          this.#history = [];
        }
      }

      const model = new ScriptedModel([
        modelResponse({
          output: [{ ...TEST_MODEL_FUNCTION_CALL }],
          usage: new Usage(),
        }),
        modelResponse({
          output: [fakeModelMessage('second turn')],
          usage: new Usage(),
        }),
      ]);

      const agent = new Agent({
        name: 'ResumeInProgressResetAgent',
        model,
        tools: [TEST_TOOL],
      });
      const runner = new Runner();
      const session = new RecordingSession();

      const state = new RunState(new RunContext(), 'hi', agent, 2);
      state._currentTurn = 1;
      (state as any)._currentTurnInProgress = true;
      state._currentStep = { type: 'next_step_run_again' } as const;
      state._noActiveAgentRun = true;
      // Simulate a stale persisted count from the resumed turn so new turns reset it.
      state._currentTurnPersistedItemCount = 5;

      const result = await runner.run(agent, state, { session });

      expect(result.finalOutput).toBe('second turn');
      expect(result.state._currentTurn).toBe(2);
      const newlyPersisted = session.added[session.added.length - 1];
      const texts = newlyPersisted
        .map((item) => getFirstTextContent(item))
        .filter((text): text is string => typeof text === 'string');
      expect(texts).toContain('second turn');
    });

    it('keeps equal-content injected and original inputs', async () => {
      class RecordingSession implements Session {
        #history: AgentInputItem[] = [];
        added: AgentInputItem[][] = [];
        #sessionId: string | undefined = 'prepended-filter-session';

        async getSessionId(): Promise<string> {
          if (!this.#sessionId) {
            this.#sessionId = 'prepended-filter-session';
          }
          return this.#sessionId;
        }

        async getItems(): Promise<AgentInputItem[]> {
          return [...this.#history];
        }

        async addItems(items: AgentInputItem[]): Promise<void> {
          this.added.push(items);
          this.#history.push(...items);
        }

        async popItem(): Promise<AgentInputItem | undefined> {
          return this.#history.pop();
        }

        async clearSession(): Promise<void> {
          this.#history = [];
          this.#sessionId = undefined;
        }
      }

      const model = new FilterTrackingModel([
        modelResponse({
          ...TEST_MODEL_RESPONSE_BASIC,
        }),
      ]);
      const agent = new Agent({
        name: 'PrependedFilterAgent',
        model,
      });
      const session = new RecordingSession();

      const runner = new Runner({
        callModelInputFilter: ({ modelData }) => ({
          instructions: modelData.instructions,
          input: [structuredClone(modelData.input[0]), ...modelData.input],
        }),
      });

      await runner.run(agent, 'Persist me', { session });

      expect(session.added).toHaveLength(1);
      const [persisted] = session.added;
      const persistedTexts = persisted
        .map((item) => getFirstTextContent(item))
        .filter((text): text is string => typeof text === 'string');
      expect(
        persistedTexts.filter((text) => text === 'Persist me'),
      ).toHaveLength(2);
    });

    it('throws when filter returns invalid data', async () => {
      const model = new FilterTrackingModel([
        modelResponse({
          ...TEST_MODEL_RESPONSE_BASIC,
        }),
      ]);
      const agent = new Agent({
        name: 'InvalidFilterAgent',
        model,
      });
      const runner = new Runner({
        callModelInputFilter: () =>
          ({
            instructions: 'invalid',
          }) as unknown as ModelInputData,
      });

      await expect(runner.run(agent, 'Hello')).rejects.toThrow(
        'ModelInputData',
      );
    });

    it('prefers per-run callModelInputFilter over runner config', async () => {
      const model = new FilterTrackingModel([
        modelResponse({
          ...TEST_MODEL_RESPONSE_BASIC,
        }),
      ]);
      const agent = new Agent({
        name: 'OverrideFilterAgent',
        model,
      });

      const defaultFilter = vi.fn(({ modelData }) => ({
        instructions: `${modelData.instructions ?? ''} default`,
        input: modelData.input,
      }));
      const overrideFilter = vi.fn((payload) => ({
        instructions: 'override instructions',
        input: payload.modelData.input,
      }));

      const runner = new Runner({
        callModelInputFilter: defaultFilter,
      });

      const context = { tenant: 'acme' };

      await runner.run(agent, 'Hello override', {
        callModelInputFilter: overrideFilter,
        context,
      });

      expect(defaultFilter).not.toHaveBeenCalled();
      expect(overrideFilter).toHaveBeenCalledTimes(1);
      const args = overrideFilter.mock.calls[0][0];
      expect(args.context).toEqual(context);

      expect(model.lastRequest?.systemInstructions).toBe(
        'override instructions',
      );
      const sentInput = model.lastRequest?.input as AgentInputItem[];
      expect(Array.isArray(sentInput)).toBe(true);
      expect(sentInput).toHaveLength(1);
      expect(getFirstTextContent(sentInput[0])).toBe('Hello override');
    });

    it('allows callModelInputFilter to override omitted reasoning IDs', async () => {
      class ReasoningTrackingModel extends ScriptedModel {
        readonly requests: ModelRequest[];

        constructor(responses: ModelResponse[]) {
          const requests: ModelRequest[] = [];
          super(
            responses.map((response) =>
              modelResponder((call) => {
                requests.push(cloneModelRequest(call.request));
                return response;
              }),
            ),
          );
          this.requests = requests;
        }
      }

      const model = new ReasoningTrackingModel([
        {
          output: [
            {
              type: 'reasoning',
              id: 'rs_filter',
              content: [{ type: 'input_text', text: 'thinking...' }],
            } as protocol.ReasoningItem,
            {
              type: 'function_call',
              id: 'fc_filter',
              callId: 'call_filter',
              name: 'echo_tool',
              status: 'completed',
              arguments: '{}',
            } as protocol.FunctionCallItem,
          ],
          usage: new Usage(),
        },
        {
          output: [fakeModelMessage('done')],
          usage: new Usage(),
        },
      ]);

      const echoTool = tool({
        name: 'echo_tool',
        description: 'Echoes a static payload.',
        parameters: z.object({}),
        execute: async () => 'ok',
      });
      const agent = new Agent({
        name: 'ReasoningFilterOverrideAgent',
        model,
        tools: [echoTool],
      });

      const runner = new Runner({
        reasoningItemIdPolicy: 'omit',
        callModelInputFilter: ({ modelData }) => ({
          instructions: modelData.instructions,
          input: modelData.input.map((item) => {
            if (item.type !== 'reasoning' || 'id' in item) {
              return item;
            }
            return { ...item, id: 'rs_reintroduced' } as protocol.ReasoningItem;
          }),
        }),
      });

      const result = await runner.run(agent, 'hello');

      expect(result.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);

      const secondInput = model.requests[1].input as AgentInputItem[];
      expect(Array.isArray(secondInput)).toBe(true);
      const secondReasoning = secondInput.find(
        (item): item is protocol.ReasoningItem => item.type === 'reasoning',
      );
      expect(secondReasoning).toBeDefined();
      expect(secondReasoning?.id).toBe('rs_reintroduced');

      const historyReasoning = result.history.find(
        (item): item is protocol.ReasoningItem => item.type === 'reasoning',
      );
      expect(historyReasoning).toBeDefined();
      expect(historyReasoning).not.toHaveProperty('id');
    });

    it('keeps server conversation tracking aligned with filtered inputs', async () => {
      class ConversationTrackingModel extends ScriptedModel {
        readonly requests: ModelRequest[];

        constructor(responses: ModelResponse[]) {
          const requests: ModelRequest[] = [];
          super(
            responses.map((response) =>
              modelResponder((call) => {
                requests.push(cloneModelRequest(call.request));
                return response;
              }),
            ),
          );
          this.requests = requests;
        }
      }

      const model = new ConversationTrackingModel([
        {
          output: [
            fakeModelMessage('call the tool'),
            {
              id: 'call-1',
              type: 'function_call',
              name: 'filterTool',
              callId: 'call-1',
              status: 'completed',
              arguments: JSON.stringify({ test: 'value' }),
            } as protocol.FunctionCallItem,
          ],
          usage: new Usage(),
          responseId: 'resp-1',
        },
        {
          output: [fakeModelMessage('all done')],
          usage: new Usage(),
          responseId: 'resp-2',
        },
      ]);

      const filterTool = tool({
        name: 'filterTool',
        description: 'test tool',
        parameters: z.object({ test: z.string() }),
        execute: async ({ test }) => `result:${test}`,
      });

      let filterCalls = 0;
      const runner = new Runner({
        callModelInputFilter: ({ modelData }) => {
          filterCalls += 1;
          if (filterCalls === 1) {
            return {
              instructions: modelData.instructions,
              input: modelData.input
                .slice(1)
                .map((item) => structuredClone(item)),
            };
          }
          return modelData;
        },
      });

      const agent = new Agent({
        name: 'TrackerFilterAgent',
        model,
        tools: [filterTool],
      });

      const result = await runner.run(
        agent,
        [user('First input'), user('Second input')],
        { conversationId: 'conv-filter-tracker' },
      );

      expect(result.finalOutput).toBe('all done');
      expect(filterCalls).toBe(2);
      expect(model.requests).toHaveLength(2);

      const firstInput = model.requests[0].input as AgentInputItem[];
      expect(Array.isArray(firstInput)).toBe(true);
      expect(firstInput).toHaveLength(1);
      expect(getFirstTextContent(firstInput[0])).toBe('Second input');

      const secondInput = model.requests[1].input as AgentInputItem[];
      expect(Array.isArray(secondInput)).toBe(true);
      const secondMessages = secondInput.filter(
        (item) => item.type === 'message',
      );
      expect(secondMessages).toHaveLength(0);

      expect(
        secondInput.some(
          (item) =>
            item.type === 'function_call_result' &&
            (item as protocol.FunctionCallResultItem).callId === 'call-1',
        ),
      ).toBe(true);
    });

    it('stops requeuing sanitized inputs when filters replace them', async () => {
      class RedactionTrackingModel extends ScriptedModel {
        readonly requests: ModelRequest[];

        constructor(responses: ModelResponse[]) {
          const requests: ModelRequest[] = [];
          super(
            responses.map((response) =>
              modelResponder((call) => {
                requests.push(cloneModelRequest(call.request));
                return response;
              }),
            ),
          );
          this.requests = requests;
        }
      }

      const model = new RedactionTrackingModel([
        {
          output: [
            fakeModelMessage('call the tool'),
            {
              id: 'call-1',
              type: 'function_call',
              name: 'filterTool',
              callId: 'call-1',
              status: 'completed',
              arguments: JSON.stringify({ test: 'value' }),
            } as protocol.FunctionCallItem,
          ],
          usage: new Usage(),
          responseId: 'resp-redact-1',
        },
        {
          output: [fakeModelMessage('all done')],
          usage: new Usage(),
          responseId: 'resp-redact-2',
        },
      ]);

      const filterTool = tool({
        name: 'filterTool',
        description: 'test tool',
        parameters: z.object({ test: z.string() }),
        execute: async ({ test }) => `result:${test}`,
      });

      let filterCalls = 0;
      const runner = new Runner({
        callModelInputFilter: ({ modelData }) => {
          filterCalls += 1;
          if (filterCalls === 1) {
            return {
              instructions: modelData.instructions,
              input: modelData.input.map((item) => {
                if (
                  item?.type === 'message' &&
                  'role' in item &&
                  item.role === 'user'
                ) {
                  const clone = structuredClone(item);
                  if (typeof clone.content === 'string') {
                    clone.content = '[redacted]';
                  } else if (Array.isArray(clone.content)) {
                    const firstChunk = clone.content[0] as { text?: string };
                    if (firstChunk) {
                      firstChunk.text = '[redacted]';
                    }
                  }
                  return clone;
                }
                return structuredClone(item);
              }),
            };
          }
          return modelData;
        },
      });

      const agent = new Agent({
        name: 'RedactionFilterAgent',
        model,
        tools: [filterTool],
      });

      const result = await runner.run(agent, [user('Sensitive payload')], {
        conversationId: 'conv-filter-redact',
      });

      expect(result.finalOutput).toBe('all done');
      expect(filterCalls).toBe(2);
      expect(model.requests).toHaveLength(2);

      const firstInput = model.requests[0].input as AgentInputItem[];
      expect(Array.isArray(firstInput)).toBe(true);
      expect(getFirstTextContent(firstInput[0])).toBe('[redacted]');

      const secondInput = model.requests[1].input as AgentInputItem[];
      const secondTexts = secondInput
        .map((item) => getFirstTextContent(item))
        .filter((text): text is string => typeof text === 'string');
      expect(secondTexts).not.toContain('[redacted]');
      expect(secondTexts).not.toContain('Sensitive payload');
    });

    it('does not requeue filtered tool outputs in server-managed conversations', async () => {
      class ConversationTrackingModel extends ScriptedModel {
        readonly requests: ModelRequest[];

        constructor(responses: ModelResponse[]) {
          const requests: ModelRequest[] = [];
          super(
            responses.map((response) =>
              modelResponder((call) => {
                requests.push(cloneModelRequest(call.request));
                return response;
              }),
            ),
          );
          this.requests = requests;
        }
      }

      const model = new ConversationTrackingModel([
        {
          output: [
            {
              id: 'call-1',
              type: 'function_call',
              name: 'filterTool',
              callId: 'call-1',
              status: 'completed',
              arguments: JSON.stringify({ test: 'first' }),
            } as protocol.FunctionCallItem,
          ],
          usage: new Usage(),
          responseId: 'resp-1',
        },
        {
          output: [
            {
              id: 'call-2',
              type: 'function_call',
              name: 'filterTool',
              callId: 'call-2',
              status: 'completed',
              arguments: JSON.stringify({ test: 'second' }),
            } as protocol.FunctionCallItem,
          ],
          usage: new Usage(),
          responseId: 'resp-2',
        },
        {
          output: [fakeModelMessage('all done')],
          usage: new Usage(),
          responseId: 'resp-3',
        },
      ]);

      const filterTool = tool({
        name: 'filterTool',
        description: 'test tool',
        parameters: z.object({ test: z.string() }),
        execute: async ({ test }) => `result:${test}`,
      });

      let filterCalls = 0;
      const runner = new Runner({
        callModelInputFilter: ({ modelData }) => {
          filterCalls += 1;
          if (filterCalls === 2) {
            return {
              instructions: modelData.instructions,
              input: modelData.input.filter(
                (item) => item.type !== 'function_call_result',
              ),
            };
          }
          return modelData;
        },
      });

      const agent = new Agent({
        name: 'ToolOutputFilterAgent',
        model,
        tools: [filterTool],
        toolUseBehavior: 'run_llm_again',
      });

      const result = await runner.run(agent, [user('Run it')], {
        conversationId: 'conv-filter-tool-output',
      });

      expect(result.finalOutput).toBe('all done');
      expect(filterCalls).toBe(3);
      expect(model.requests).toHaveLength(3);

      const secondInput = model.requests[1].input as AgentInputItem[];
      expect(Array.isArray(secondInput)).toBe(true);
      expect(
        secondInput.some(
          (item) =>
            item.type === 'function_call_result' &&
            (item as protocol.FunctionCallResultItem).callId === 'call-1',
        ),
      ).toBe(false);

      const thirdInput = model.requests[2].input as AgentInputItem[];
      expect(Array.isArray(thirdInput)).toBe(true);
      const toolResults = thirdInput.filter(
        (item): item is protocol.FunctionCallResultItem =>
          item.type === 'function_call_result',
      );
      const callIds = toolResults.map((item) => item.callId);
      expect(callIds).toContain('call-2');
      expect(callIds).not.toContain('call-1');
    });

    it('preserves providerData when saving streaming session items', async () => {
      class MetadataStreamingModel extends ScriptedModel {
        constructor(response: ModelResponse) {
          super([modelResponse({ ...response, responseId: 'meta-stream' })]);
        }
      }

      const assistantMessage: protocol.AssistantMessageItem = {
        ...fakeModelMessage('assistant with metadata'),
        providerData: { annotations: ['keep-me'] },
      };
      const model = new MetadataStreamingModel({
        output: [assistantMessage],
        usage: new Usage(),
      });

      const agent = new Agent({
        name: 'StreamSessionMetadata',
        model,
      });

      class RecordingSession implements Session {
        #history: AgentInputItem[] = [];
        added: AgentInputItem[][] = [];
        sessionId = 'stream-session';

        async getSessionId(): Promise<string> {
          return this.sessionId;
        }

        async getItems(): Promise<AgentInputItem[]> {
          return [...this.#history];
        }

        async addItems(items: AgentInputItem[]): Promise<void> {
          this.added.push(items);
          this.#history.push(...items);
        }

        async popItem(): Promise<AgentInputItem | undefined> {
          return this.#history.pop();
        }

        async clearSession(): Promise<void> {
          this.#history = [];
        }
      }

      const session = new RecordingSession();
      const runner = new Runner();

      const result = await runner.run(agent, 'Hi stream', {
        stream: true,
        session,
      });

      for await (const _event of result.toStream()) {
        // exhaust stream so the run finishes
      }
      await result.completed;

      expect(session.added).toHaveLength(1);
      const streamedItems = session.added[0];
      expect(streamedItems).toHaveLength(2);
      const savedAssistant = streamedItems[1] as protocol.AssistantMessageItem;
      expect(savedAssistant.providerData).toEqual({ annotations: ['keep-me'] });
      expect(getFirstTextContent(savedAssistant)).toBe(
        'assistant with metadata',
      );
    });
  });

  describe('gpt-5 default model adjustments', () => {
    class InspectableModel extends ScriptedModel {
      constructor(response: ModelResponse) {
        super([modelResponse(response)]);
      }

      get lastRequest(): Readonly<ModelRequest> | undefined {
        return this.lastCall?.request;
      }
    }

    class InspectableModelProvider implements ModelProvider {
      constructor(private readonly model: Model) {}

      async getModel(_name: string): Promise<Model> {
        return this.model;
      }
    }

    let originalDefaultModel: string | undefined;

    beforeEach(() => {
      originalDefaultModel = process.env.OPENAI_DEFAULT_MODEL;
      process.env.OPENAI_DEFAULT_MODEL = 'gpt-5o';
    });

    afterEach(() => {
      if (originalDefaultModel === undefined) {
        delete process.env.OPENAI_DEFAULT_MODEL;
      } else {
        process.env.OPENAI_DEFAULT_MODEL = originalDefaultModel;
      }
    });

    function createGpt5ModelSettings(): ModelSettings {
      return {
        temperature: 0.42,
        providerData: {
          reasoning: { effort: 'high' },
          text: { verbosity: 'high' },
          reasoning_effort: 'medium',
          keep: 'value',
        },
        reasoning: { effort: 'high', summary: 'detailed' },
        text: { verbosity: 'medium' },
      };
    }

    it('strips GPT-5-only settings when the RunConfig model is not a GPT-5 string', async () => {
      const modelResponse: ModelResponse = {
        output: [fakeModelMessage('Hello non GPT-5')],
        usage: new Usage(),
      };
      const inspectableModel = new InspectableModel(modelResponse);
      const agent = new Agent({
        name: 'NonGpt5Runner',
        model: inspectableModel,
        modelSettings: createGpt5ModelSettings(),
      });

      const runner = new Runner();
      const result = await runner.run(agent, 'hello');

      expect(result.finalOutput).toBe('Hello non GPT-5');
      expect(inspectableModel.lastRequest).toBeDefined();

      const requestSettings = inspectableModel.lastRequest!.modelSettings;
      expect(requestSettings.temperature).toBe(0.42);
      expect(requestSettings.providerData?.keep).toBe('value');
      expect(requestSettings.providerData?.reasoning).toBeUndefined();
      expect(requestSettings.providerData?.text?.verbosity).toBeUndefined();
      expect(
        (requestSettings.providerData as any)?.reasoning_effort,
      ).toBeUndefined();
      expect(requestSettings.reasoning?.effort).toBeUndefined();
      expect(requestSettings.reasoning?.summary).toBeUndefined();
      expect(requestSettings.text?.verbosity).toBeUndefined();
    });

    it('keeps GPT-5-only settings when the agent relies on the default model', async () => {
      const modelResponse: ModelResponse = {
        output: [fakeModelMessage('Hello default GPT-5')],
        usage: new Usage(),
      };
      const inspectableModel = new InspectableModel(modelResponse);
      const runner = new Runner({
        modelProvider: new InspectableModelProvider(inspectableModel),
      });

      const agent = new Agent({
        name: 'DefaultModelAgent',
        modelSettings: createGpt5ModelSettings(),
      });

      const result = await runner.run(agent, 'hello');

      expect(result.finalOutput).toBe('Hello default GPT-5');
      expect(inspectableModel.lastRequest).toBeDefined();

      const requestSettings = inspectableModel.lastRequest!.modelSettings;
      expect(requestSettings.providerData?.reasoning).toEqual({
        effort: 'high',
      });
      expect(requestSettings.providerData?.text?.verbosity).toBe('high');
      expect((requestSettings.providerData as any)?.reasoning_effort).toBe(
        'medium',
      );
      expect(requestSettings.reasoning?.effort).toBe('high');
      expect(requestSettings.reasoning?.summary).toBe('detailed');
      expect(requestSettings.text?.verbosity).toBe('medium');
    });

    it.each([
      ['gpt-5', 'low'],
      ['gpt-5.6', 'none'],
    ] as const)(
      'uses model-specific defaults when the RunConfig model is %s',
      async (modelName, reasoningEffort) => {
        const modelResponse: ModelResponse = {
          output: [fakeModelMessage('Hello explicit runner GPT-5')],
          usage: new Usage(),
        };
        const inspectableModel = new InspectableModel(modelResponse);
        const runner = new Runner({
          model: modelName,
          modelProvider: new InspectableModelProvider(inspectableModel),
        });
        const agent = new Agent({ name: 'RunnerModelAgent' });

        const result = await runner.run(agent, 'hello');

        expect(result.finalOutput).toBe('Hello explicit runner GPT-5');
        expect(inspectableModel.lastRequest?.modelSettings).toMatchObject({
          reasoning: { effort: reasoningEffort },
          text: { verbosity: 'low' },
        });
        expect(
          inspectableModel.lastRequest?._internal?.reasoningEffortImplicit,
        ).toBe(true);
      },
    );

    it('lets RunConfig modelSettings override implicit model defaults', async () => {
      const modelResponse: ModelResponse = {
        output: [fakeModelMessage('Hello runner override')],
        usage: new Usage(),
      };
      const inspectableModel = new InspectableModel(modelResponse);
      const runner = new Runner({
        model: 'gpt-5',
        modelProvider: new InspectableModelProvider(inspectableModel),
        modelSettings: {
          reasoning: { effort: 'medium' },
          temperature: 0.7,
        },
      });
      const agent = new Agent({ name: 'RunnerModelSettingsAgent' });

      const result = await runner.run(agent, 'hello');

      expect(result.finalOutput).toBe('Hello runner override');
      expect(inspectableModel.lastRequest?.modelSettings).toMatchObject({
        reasoning: { effort: 'medium' },
        text: { verbosity: 'low' },
        temperature: 0.7,
      });
      expect(
        inspectableModel.lastRequest?._internal?.reasoningEffortImplicit,
      ).toBe(false);
    });
  });

  describe('server-managed conversation state', () => {
    class RecordingSession implements Session {
      public added: AgentInputItem[][] = [];

      async getSessionId(): Promise<string> {
        return 'server-managed-session';
      }

      async getItems(): Promise<AgentInputItem[]> {
        return [];
      }

      async addItems(items: AgentInputItem[]): Promise<void> {
        this.added.push(items);
      }

      async popItem(): Promise<AgentInputItem | undefined> {
        return undefined;
      }

      async clearSession(): Promise<void> {
        this.added = [];
      }
    }

    class TrackingModel extends ScriptedModel {
      public requests: ModelRequest[];

      constructor(responses: Array<ReturnType<typeof modelResponse>>) {
        const requests: ModelRequest[] = [];
        super(
          responses.map((step) =>
            modelResponder((call) => {
              requests.push(cloneModelRequest(call.request));
              return step.response;
            }),
          ),
        );
        this.requests = requests;
      }

      get firstRequest(): ModelRequest | undefined {
        return this.requests[0];
      }

      get lastRequest(): ModelRequest | undefined {
        return this.requests.at(-1);
      }
    }

    const buildResponse = (
      items: protocol.ModelItem[],
      responseId?: string,
    ): ModelResponse => ({
      output: JSON.parse(JSON.stringify(items)) as protocol.ModelItem[],
      usage: new Usage(),
      responseId,
    });

    const buildToolCall = (
      callId: string,
      arg: string,
    ): protocol.FunctionCallItem => ({
      id: callId,
      type: 'function_call',
      name: 'test',
      callId,
      status: 'completed',
      arguments: JSON.stringify({ test: arg }),
    });

    const serverTool = tool({
      name: 'test',
      description: 'test tool',
      parameters: z.object({ test: z.string() }),
      execute: async ({ test }) => `result:${test}`,
    });

    it('marks server-managed inputs as sent only after a successful response', async () => {
      class SingleResponseModel extends ScriptedModel {
        constructor(response: ModelResponse) {
          super([modelResponse(response)]);
        }

        get requests(): readonly ModelRequest[] {
          return this.calls.map((call) => call.request);
        }
      }

      const markSpy = vi.spyOn(
        ServerConversationTracker.prototype,
        'markInputAsSent',
      );

      const model = new SingleResponseModel(TEST_MODEL_RESPONSE_BASIC);
      const agent = new Agent({ name: 'MarkSuccess', model });
      const runner = new Runner();

      const result = await runner.run(agent, 'hi there', {
        conversationId: 'conv-mark-success',
      });

      expect(result.finalOutput).toBe('Hello World');
      expect(markSpy).toHaveBeenCalledTimes(1);
      const [sourceItems, options] = markSpy.mock.calls[0];
      expect(Array.isArray(sourceItems)).toBe(true);
      expect(options?.filterApplied).toBe(false);
      expect(model.requests[0]?.conversationId).toBe('conv-mark-success');

      markSpy.mockRestore();
    });

    it('does not mark server inputs as sent when the model call fails before sending', async () => {
      const markSpy = vi.spyOn(
        ServerConversationTracker.prototype,
        'markInputAsSent',
      );
      const agent = new Agent({
        name: 'MarkFailure',
        model: new ScriptedModel([modelError(new Error('boom'))]),
      });
      const runner = new Runner();

      await expect(
        runner.run(agent, 'please fail', {
          conversationId: 'conv-mark-failure',
        }),
      ).rejects.toThrow('boom');

      expect(markSpy).not.toHaveBeenCalled();
      markSpy.mockRestore();
    });

    it('skips persisting turns when the server manages conversation history via conversationId', async () => {
      const model = new TrackingModel([
        modelResponse({
          ...TEST_MODEL_RESPONSE_BASIC,
          output: [fakeModelMessage('response')],
        }),
      ]);
      const agent = new Agent({ name: 'ServerManagedConversation', model });
      // Deliberately combine session with conversationId to ensure callbacks and state helpers remain usable without duplicating remote history.
      const session = new RecordingSession();
      const runner = new Runner();

      await runner.run(agent, 'Hello there', {
        session,
        conversationId: 'conv-server-managed',
      });

      expect(session.added).toHaveLength(0);
      expect(model.lastRequest?.conversationId).toBe('conv-server-managed');
    });

    it('skips persisting turns when the server manages conversation history via previousResponseId', async () => {
      const model = new TrackingModel([
        modelResponse({
          ...TEST_MODEL_RESPONSE_BASIC,
          output: [fakeModelMessage('response')],
        }),
      ]);
      const agent = new Agent({ name: 'ServerManagedPrevious', model });
      // Deliberately combine session with previousResponseId to ensure we honor server-side transcripts while keeping session utilities available.
      const session = new RecordingSession();
      const runner = new Runner();

      await runner.run(agent, 'Hi again', {
        session,
        previousResponseId: 'resp-existing',
      });

      expect(session.added).toHaveLength(0);
      expect(model.lastRequest?.previousResponseId).toBe('resp-existing');
    });

    it('preserves user input when the session callback only reuses history with conversationId', async () => {
      const model = new TrackingModel([
        modelResponse({
          ...TEST_MODEL_RESPONSE_BASIC,
          output: [fakeModelMessage('response')],
        }),
      ]);
      const agent = new Agent({ name: 'ServerManagedReuse', model });
      const persistedHistory: AgentInputItem[] = [
        assistant('Persisted reply from history'),
      ];
      const session: Session = {
        async getSessionId() {
          return 'server-managed-session';
        },
        async getItems() {
          return persistedHistory;
        },
        async addItems(items) {
          persistedHistory.push(...items);
        },
        async popItem() {
          return persistedHistory.pop();
        },
        async clearSession() {
          persistedHistory.length = 0;
        },
      };
      const runner = new Runner();

      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      await runner.run(agent, 'Latest user input', {
        session,
        conversationId: 'conv-history-only',
        sessionInputCallback: (historyItems) => historyItems,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        'sessionInputCallback dropped all new inputs in a server-managed conversation; original turn inputs were restored to avoid losing the API delta. Keep at least one new item or omit conversationId if you intended to drop them.',
      );
      warnSpy.mockRestore();

      const firstInput = model.firstRequest?.input;
      expect(Array.isArray(firstInput)).toBe(true);
      const sentItems = firstInput as AgentInputItem[];
      expect(sentItems).toHaveLength(1);
      expect(getFirstTextContent(sentItems[0])).toBe('Latest user input');
    });

    it('only sends new items when using conversationId across turns', async () => {
      const model = new TrackingModel([
        modelResponse(
          buildResponse(
            [fakeModelMessage('a_message'), buildToolCall('call-1', 'foo')],
            'resp-1',
          ),
        ),
        modelResponse(
          buildResponse(
            [fakeModelMessage('b_message'), buildToolCall('call-2', 'bar')],
            'resp-2',
          ),
        ),
        modelResponse(buildResponse([fakeModelMessage('done')], 'resp-3')),
      ]);

      const agent = new Agent({
        name: 'Test',
        model,
        tools: [serverTool],
      });

      const runner = new Runner();
      const result = await runner.run(agent, 'user_message', {
        conversationId: 'conv-test-123',
      });

      expect(result.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(3);
      expect(model.requests.map((req) => req.conversationId)).toEqual([
        'conv-test-123',
        'conv-test-123',
        'conv-test-123',
      ]);

      const firstInput = model.requests[0].input;
      expect(Array.isArray(firstInput)).toBe(true);
      expect(firstInput as AgentInputItem[]).toHaveLength(1);
      const userMessage = (firstInput as AgentInputItem[])[0] as any;
      expect(userMessage.role).toBe('user');
      expect(userMessage.content).toBe('user_message');

      const secondInput = model.requests[1].input;
      expect(Array.isArray(secondInput)).toBe(true);
      const secondItems = secondInput as AgentInputItem[];
      expect(secondItems).toHaveLength(1);
      expect(secondItems[0]).toMatchObject({
        type: 'function_call_result',
        callId: 'call-1',
      });

      const thirdInput = model.requests[2].input;
      expect(Array.isArray(thirdInput)).toBe(true);
      const thirdItems = thirdInput as AgentInputItem[];
      expect(thirdItems).toHaveLength(1);
      expect(thirdItems[0]).toMatchObject({
        type: 'function_call_result',
        callId: 'call-2',
      });
    });

    it('does not retry a failed server-managed request before the server ack is recorded', async () => {
      class RetryTrackingModel extends ScriptedModel {
        constructor() {
          const error = new Error('temporary conversation failure') as Error & {
            statusCode?: number;
          };
          error.statusCode = 503;
          super([modelError(error)]);
        }

        get requests(): readonly Readonly<ModelRequest>[] {
          return this.calls.map((call) => call.request);
        }
      }

      const markSpy = vi.spyOn(
        ServerConversationTracker.prototype,
        'markInputAsSent',
      );
      const model = new RetryTrackingModel();

      const agent = new Agent({
        name: 'RetryConversationAgent',
        model,
        tools: [serverTool],
        modelSettings: {
          retry: {
            maxRetries: 1,
            backoff: { initialDelayMs: 0, jitter: false },
            policy: ({ normalized }) => normalized.statusCode === 503,
          },
        },
      });

      await expect(
        new Runner().run(agent, 'user_message', {
          conversationId: 'conv-retry-managed',
        }),
      ).rejects.toThrow('temporary conversation failure');

      expect(model.requests).toHaveLength(1);
      expect(markSpy).not.toHaveBeenCalled();

      const firstAttemptItems = model.requests[0].input as AgentInputItem[];
      expect(firstAttemptItems).toHaveLength(1);
      expect(getFirstTextContent(firstAttemptItems[0]!)).toBe('user_message');

      markSpy.mockRestore();
    });

    it('only sends new items and updates previousResponseId across turns', async () => {
      const model = new TrackingModel([
        modelResponse(
          buildResponse(
            [fakeModelMessage('a_message'), buildToolCall('call-1', 'foo')],
            'resp-789',
          ),
        ),
        modelResponse(buildResponse([fakeModelMessage('done')], 'resp-900')),
      ]);

      const agent = new Agent({
        name: 'Test',
        model,
        tools: [serverTool],
      });

      const runner = new Runner();
      const result = await runner.run(agent, 'user_message', {
        previousResponseId: 'initial-response-123',
      });

      expect(result.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);

      expect(model.requests[0].previousResponseId).toBe('initial-response-123');

      const secondRequest = model.requests[1];
      expect(secondRequest.previousResponseId).toBe('resp-789');
      expect(Array.isArray(secondRequest.input)).toBe(true);
      const secondItems = secondRequest.input as AgentInputItem[];
      expect(secondItems).toHaveLength(1);
      expect(secondItems[0]).toMatchObject({
        type: 'function_call_result',
        callId: 'call-1',
      });
    });

    it('acknowledges ignored handoffs when continuing a managed previousResponseId run', async () => {
      const agentBModel = new TrackingModel([
        modelResponse(buildResponse([fakeModelMessage('done B')], 'resp-b')),
      ]);
      const agentCModel = new TrackingModel([
        modelResponse(buildResponse([fakeModelMessage('done C')], 'resp-c')),
      ]);
      const agentB = new Agent({
        name: 'ManagedB',
        model: agentBModel,
      });
      const agentC = new Agent({
        name: 'ManagedC',
        model: agentCModel,
      });
      const handoffToB = handoff(agentB);
      const handoffToC = handoff(agentC);
      const acceptedCall: protocol.FunctionCallItem = {
        id: 'h1',
        type: 'function_call',
        name: handoffToB.toolName,
        callId: 'c1',
        status: 'completed',
        arguments: '{}',
      };
      const ignoredCall: protocol.FunctionCallItem = {
        id: 'h2',
        type: 'function_call',
        name: handoffToC.toolName,
        callId: 'c2',
        status: 'completed',
        arguments: '{}',
      };
      const agentA = new Agent({
        name: 'ManagedA',
        model: new TrackingModel([
          modelResponse(buildResponse([acceptedCall, ignoredCall], 'resp-a')),
        ]),
        handoffs: [handoffToB, handoffToC],
      });

      const result = await new Runner().run(agentA, 'hi', {
        previousResponseId: 'initial-response',
      });

      expect(result.finalOutput).toBe('done B');
      expect(agentBModel.requests).toHaveLength(1);
      expect(agentCModel.requests).toHaveLength(0);
      expect(agentBModel.requests[0].previousResponseId).toBe('resp-a');
      expect(agentBModel.requests[0].input).toEqual([
        expect.objectContaining({
          type: 'function_call_result',
          callId: acceptedCall.callId,
        }),
        expect.objectContaining({
          type: 'function_call_result',
          callId: ignoredCall.callId,
        }),
      ]);
      expect(
        result.history.some(
          (item) => (item as { callId?: string }).callId === ignoredCall.callId,
        ),
      ).toBe(false);
    });

    it('rejects an ignored handoff that reuses a committed callId', async () => {
      const agentBModel = new TrackingModel([
        modelResponse(buildResponse([fakeModelMessage('done B')], 'resp-b')),
      ]);
      const agentCModel = new TrackingModel([
        modelResponse(buildResponse([fakeModelMessage('done C')], 'resp-c')),
      ]);
      const agentB = new Agent({
        name: 'ManagedReuseB',
        model: agentBModel,
      });
      const agentC = new Agent({
        name: 'ManagedReuseC',
        model: agentCModel,
      });
      const handoffToB = handoff(agentB);
      const handoffToC = handoff(agentC);
      const reusedCallId = 'reused-call-id';
      const acceptedCall: protocol.FunctionCallItem = {
        id: 'handoff-accepted',
        type: 'function_call',
        name: handoffToB.toolName,
        callId: 'handoff-accepted-id',
        status: 'completed',
        arguments: '{}',
      };
      const ignoredCall: protocol.FunctionCallItem = {
        id: 'handoff-ignored',
        type: 'function_call',
        name: handoffToC.toolName,
        callId: reusedCallId,
        status: 'completed',
        arguments: '{}',
      };
      const agentA = new Agent({
        name: 'ManagedReuseA',
        model: new TrackingModel([
          modelResponse(
            buildResponse([buildToolCall(reusedCallId, 'warmup')], 'resp-tool'),
          ),
          modelResponse(
            buildResponse([acceptedCall, ignoredCall], 'resp-handoff'),
          ),
        ]),
        tools: [serverTool],
        handoffs: [handoffToB, handoffToC],
      });

      await expect(
        new Runner().run(agentA, 'hi', {
          previousResponseId: 'initial-response',
        }),
      ).rejects.toThrow(
        'Tool call ID reused-call-id was reused for a different invocation after its output was committed.',
      );

      expect(agentBModel.requests).toHaveLength(0);
      expect(agentCModel.requests).toHaveLength(0);
    });

    it('replays pending managed handoff acknowledgements when resuming in non-stream mode', async () => {
      const agentBModel = new TrackingModel([
        modelResponse(buildResponse([fakeModelMessage('done B')], 'resp-b')),
      ]);
      const agentB = new Agent({
        name: 'ManagedResumeNonStreamB',
        model: agentBModel,
      });
      const agentC = new Agent({
        name: 'ManagedResumeNonStreamC',
        model: new TrackingModel([
          modelResponse(buildResponse([fakeModelMessage('done C')], 'resp-c')),
        ]),
      });
      const handoffToB = handoff(agentB);
      const handoffToC = handoff(agentC);
      const acceptedCall: protocol.FunctionCallItem = {
        id: 'handoff-accepted',
        type: 'function_call',
        name: handoffToB.toolName,
        callId: 'c1',
        status: 'completed',
        arguments: '{}',
      };
      const ignoredCall: protocol.FunctionCallItem = {
        id: 'handoff-ignored',
        type: 'function_call',
        name: handoffToC.toolName,
        callId: 'c2',
        status: 'completed',
        arguments: '{}',
      };
      const agentA = new Agent({
        name: 'ManagedResumeNonStreamA',
        model: new TrackingModel([]),
        handoffs: [handoffToB, handoffToC],
      });
      const state = new RunState(new RunContext(), 'hi', agentA, 3);

      state._currentAgent = agentB;
      state._currentTurn = 1;
      state._currentTurnInProgress = true;
      state._currentStep = { type: 'next_step_run_again' } as const;
      state._noActiveAgentRun = true;
      state._modelResponses = [
        buildResponse([acceptedCall, ignoredCall], 'resp-a'),
      ];
      state._generatedItems = [
        new RunHandoffOutputItem(
          {
            type: 'function_call_result',
            name: acceptedCall.name,
            callId: acceptedCall.callId,
            status: 'completed',
            output: {
              type: 'text',
              text: 'Transferred to ManagedResumeNonStreamB',
            },
          },
          agentA,
          agentB,
        ),
      ];
      state._lastProcessedResponse = {
        newItems: [],
        handoffs: [
          { toolCall: acceptedCall, handoff: handoffToB },
          { toolCall: ignoredCall, handoff: handoffToC },
        ],
        functions: [],
        computerActions: [],
        shellActions: [],
        applyPatchActions: [],
        mcpApprovalRequests: [],
        toolsUsed: [],
        hasToolsOrApprovalsToRun: () => true,
      } as any;
      state.setConversationContext(
        'conv-managed-handoff-resume-non-stream',
        undefined,
      );

      const result = await new Runner().run(agentA, state, {
        conversationId: 'conv-managed-handoff-resume-non-stream',
      });

      expect(result.finalOutput).toBe('done B');
      expect(agentBModel.requests).toHaveLength(1);
      expect(agentBModel.requests[0].conversationId).toBe(
        'conv-managed-handoff-resume-non-stream',
      );
      expect(agentBModel.requests[0].input).toEqual([
        expect.objectContaining({
          type: 'function_call_result',
          callId: acceptedCall.callId,
        }),
        expect.objectContaining({
          type: 'function_call_result',
          callId: ignoredCall.callId,
        }),
      ]);
    });

    it('does not append ignored handoff acknowledgements after removeAllTools filters the handoff input', async () => {
      const agentBModel = new TrackingModel([
        modelResponse(buildResponse([fakeModelMessage('done B')], 'resp-b')),
      ]);
      const agentCModel = new TrackingModel([
        modelResponse(buildResponse([fakeModelMessage('done C')], 'resp-c')),
      ]);
      const agentB = new Agent({
        name: 'ManagedFilteredB',
        model: agentBModel,
      });
      const agentC = new Agent({
        name: 'ManagedFilteredC',
        model: agentCModel,
      });
      const handoffToB = handoff(agentB, {
        inputFilter: removeAllTools,
      });
      const handoffToC = handoff(agentC);
      const acceptedCall: protocol.FunctionCallItem = {
        id: 'handoff-filtered-accepted',
        type: 'function_call',
        name: handoffToB.toolName,
        callId: 'filtered-c1',
        status: 'completed',
        arguments: '{}',
      };
      const ignoredCall: protocol.FunctionCallItem = {
        id: 'handoff-filtered-ignored',
        type: 'function_call',
        name: handoffToC.toolName,
        callId: 'filtered-c2',
        status: 'completed',
        arguments: '{}',
      };
      const agentA = new Agent({
        name: 'ManagedFilteredA',
        model: new TrackingModel([
          modelResponse(buildResponse([acceptedCall, ignoredCall], 'resp-a')),
        ]),
        handoffs: [handoffToB, handoffToC],
      });

      const result = await new Runner().run(agentA, 'hi', {
        previousResponseId: 'initial-response',
      });

      expect(result.finalOutput).toBe('done B');
      expect(agentBModel.requests).toHaveLength(1);
      expect(agentCModel.requests).toHaveLength(0);
      expect(agentBModel.requests[0].previousResponseId).toBe('resp-a');
      expect(agentBModel.requests[0].input).toEqual([]);
    });

    it('does not replay orphan hosted shell calls in default multi-turn runs', async () => {
      const hostedShell = shellTool({
        environment: { type: 'container_auto' },
      });
      const model = new TrackingModel([
        modelResponse(
          buildResponse(
            [
              {
                type: 'shell_call',
                callId: 'call-shell-1',
                status: 'completed',
                action: { commands: ['echo hi'] },
              } satisfies protocol.ShellCallItem,
            ],
            'resp-shell-1',
          ),
        ),
        modelResponse(
          buildResponse([fakeModelMessage('done')], 'resp-shell-2'),
        ),
      ]);

      const agent = new Agent({
        name: 'HostedShellAgent',
        model,
        tools: [hostedShell],
      });

      const result = await new Runner().run(agent, 'user_message');

      expect(result.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);

      const secondInput = model.requests[1].input as AgentInputItem[];
      expect(secondInput).toHaveLength(1);
      expect(secondInput[0]).toMatchObject({
        type: 'message',
        role: 'user',
        content: 'user_message',
      });
      expect(secondInput.some((item) => item.type === 'shell_call')).toBe(
        false,
      );
    });

    it('does not reintroduce orphan hosted shell calls when continuing from public history', async () => {
      const hostedShell = shellTool({
        environment: { type: 'container_auto' },
      });
      const model = new TrackingModel([
        modelResponse(
          buildResponse(
            [
              {
                type: 'shell_call',
                callId: 'call-shell-1',
                status: 'completed',
                action: { commands: ['echo hi'] },
              } satisfies protocol.ShellCallItem,
            ],
            'resp-shell-1',
          ),
        ),
        modelResponse(
          buildResponse([fakeModelMessage('done')], 'resp-shell-2'),
        ),
        modelResponse(
          buildResponse(
            [fakeModelMessage('continued from result')],
            'resp-shell-3',
          ),
        ),
        modelResponse(
          buildResponse(
            [fakeModelMessage('continued from state')],
            'resp-shell-4',
          ),
        ),
      ]);

      const agent = new Agent({
        name: 'HostedShellAgent',
        model,
        tools: [hostedShell],
      });
      const runner = new Runner();
      const firstResult = await runner.run(agent, 'user_message');

      expect(
        firstResult.history.some((item) => item.type === 'shell_call'),
      ).toBe(false);
      expect(
        firstResult.state.history.some((item) => item.type === 'shell_call'),
      ).toBe(false);

      await runner.run(agent, firstResult.history);
      await runner.run(agent, firstResult.state.history);

      expect(model.requests).toHaveLength(4);
      const continuedFromResult = getRequestInputItems(model.requests[2]);
      const continuedFromState = getRequestInputItems(model.requests[3]);

      expect(
        continuedFromResult.some((item) => item.type === 'shell_call'),
      ).toBe(false);
      expect(
        continuedFromState.some((item) => item.type === 'shell_call'),
      ).toBe(false);
      expect(continuedFromResult).toEqual(firstResult.history);
      expect(continuedFromState).toEqual(firstResult.state.history);
    });

    it('replays pending hosted shell calls in default multi-turn runs', async () => {
      const hostedShell = shellTool({
        environment: { type: 'container_auto' },
      });
      const model = new TrackingModel([
        modelResponse(
          buildResponse(
            [
              {
                type: 'shell_call',
                callId: 'call-shell-pending',
                status: 'in_progress',
                action: { commands: ['echo hi'] },
              } satisfies protocol.ShellCallItem,
            ],
            'resp-shell-pending-1',
          ),
        ),
        modelResponse(
          buildResponse([fakeModelMessage('done')], 'resp-shell-pending-2'),
        ),
      ]);

      const agent = new Agent({
        name: 'HostedShellAgent',
        model,
        tools: [hostedShell],
      });

      const result = await new Runner().run(agent, 'user_message');

      expect(result.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);

      const secondInput = model.requests[1].input as AgentInputItem[];
      expect(secondInput).toHaveLength(2);
      expect(secondInput[0]).toMatchObject({
        type: 'message',
        role: 'user',
        content: 'user_message',
      });
      expect(secondInput[1]).toMatchObject({
        type: 'shell_call',
        callId: 'call-shell-pending',
        status: 'in_progress',
      });
    });

    it('does not retry a failed previousResponseId request before the server ack is recorded', async () => {
      class RetryTrackingModel extends ScriptedModel {
        readonly error: Error & { statusCode?: number };

        constructor() {
          const error = new Error(
            'temporary previousResponseId failure',
          ) as Error & { statusCode?: number };
          error.statusCode = 503;
          super([modelError(error)]);
          this.error = error;
        }

        get requests(): readonly Readonly<ModelRequest>[] {
          return this.calls.map((call) => call.request);
        }

        get attempts(): number {
          return this.calls.length;
        }
      }

      const model = new RetryTrackingModel();

      const agent = new Agent({
        name: 'RetryPreviousResponseAgent',
        model,
        tools: [serverTool],
        modelSettings: {
          retry: {
            maxRetries: 1,
            backoff: { initialDelayMs: 0, jitter: false },
            policy: ({ normalized }) => normalized.statusCode === 503,
          },
        },
      });

      await expect(
        new Runner().run(agent, 'user_message', {
          previousResponseId: 'initial-response-123',
        }),
      ).rejects.toThrow('temporary previousResponseId failure');

      expect(model.requests).toHaveLength(1);
      expect(model.requests[0].previousResponseId).toBe('initial-response-123');

      const firstAttemptItems = model.requests[0].input as AgentInputItem[];
      expect(firstAttemptItems).toHaveLength(1);
      expect(getFirstTextContent(firstAttemptItems[0]!)).toBe('user_message');
    });

    it('does not retry a streamed server-managed request before the server ack is recorded', async () => {
      class RetryStreamingTrackingModel extends ScriptedModel {
        constructor() {
          const error = new Error(
            'temporary streamed conversation failure',
          ) as Error & { statusCode?: number };
          error.statusCode = 503;
          super([modelError(error)]);
        }

        get requests(): readonly Readonly<ModelRequest>[] {
          return this.calls.map((call) => call.request);
        }

        get attempts(): number {
          return this.calls.length;
        }
      }

      const model = new RetryStreamingTrackingModel();
      const markSpy = vi.spyOn(
        ServerConversationTracker.prototype,
        'markInputAsSent',
      );
      const agent = new Agent({
        name: 'RetryStreamingConversationAgent',
        model,
        modelSettings: {
          retry: {
            maxRetries: 1,
            backoff: { initialDelayMs: 0, jitter: false },
            policy: ({ normalized }) => normalized.statusCode === 503,
          },
        },
      });

      const result = await new Runner().run(agent, 'user_message', {
        stream: true,
        conversationId: 'conv-stream-retry-managed',
      });

      const consume = async () => {
        for await (const _event of result) {
          // Consume until the stream throws.
        }
      };

      await expect(consume()).rejects.toThrow(
        'temporary streamed conversation failure',
      );
      expect(model.attempts).toBe(1);
      expect(model.requests).toHaveLength(1);
      expect(markSpy).not.toHaveBeenCalled();
      markSpy.mockRestore();
    });

    it('does not resend prior items when resuming with conversationId', async () => {
      const approvalTool = tool({
        name: 'test',
        description: 'tool that requires approval',
        parameters: z.object({ test: z.string() }),
        needsApproval: async () => true,
        execute: async ({ test }) => `result:${test}`,
      });

      const model = new TrackingModel([
        modelResponse(
          buildResponse([buildToolCall('call-approved', 'foo')], 'resp-1'),
        ),
        modelResponse(buildResponse([fakeModelMessage('done')], 'resp-2')),
      ]);

      const agent = new Agent({
        name: 'ApprovalAgent',
        model,
        tools: [approvalTool],
      });

      const runner = new Runner();
      const firstResult = await runner.run(agent, 'user_message', {
        conversationId: 'conv-approval',
      });

      expect(firstResult.interruptions).toHaveLength(1);
      const approvalItem = firstResult.interruptions[0];
      firstResult.state.approve(approvalItem);

      const secondResult = await runner.run(agent, firstResult.state, {
        conversationId: 'conv-approval',
      });

      expect(secondResult.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);

      const firstInput = model.requests[0].input;
      expect(Array.isArray(firstInput)).toBe(true);
      const firstItems = firstInput as AgentInputItem[];
      expect(firstItems).toHaveLength(1);
      expect(firstItems[0]).toMatchObject({
        role: 'user',
        content: 'user_message',
      });

      const secondRequest = model.requests[1];
      expect(secondRequest.conversationId).toBe('conv-approval');
      expect(Array.isArray(secondRequest.input)).toBe(true);
      const secondItems = secondRequest.input as AgentInputItem[];
      expect(secondItems).toHaveLength(1);
      expect(secondItems[0]).toMatchObject({
        type: 'function_call_result',
        callId: 'call-approved',
      });
    });

    it('does not re-emit missing function tool results when resuming an interrupted turn', async () => {
      const approvalTool = tool({
        name: 'test',
        description: 'tool that requires approval',
        parameters: z.object({ test: z.string() }),
        needsApproval: async () => true,
        execute: async ({ test }) => `result:${test}`,
      });
      const missingToolCall: protocol.FunctionCallItem = {
        ...buildToolCall('call-missing', 'missing'),
        name: 'missing_tool',
      };

      const model = new TrackingModel([
        modelResponse(
          buildResponse(
            [buildToolCall('call-approved', 'foo'), missingToolCall],
            'resp-mixed-missing-1',
          ),
        ),
        modelResponse(
          buildResponse([fakeModelMessage('done')], 'resp-mixed-missing-2'),
        ),
      ]);

      const agent = new Agent({
        name: 'MixedMissingToolResumeAgent',
        model,
        tools: [approvalTool],
      });

      const runner = new Runner();
      const firstResult = await runner.run(agent, 'user_message', {
        conversationId: 'conv-mixed-missing',
        toolNotFoundBehavior: 'return_error_to_model',
      });

      expect(firstResult.interruptions).toHaveLength(1);
      const preResumeMissingResults = firstResult.state._generatedItems.filter(
        (item) =>
          item.rawItem.type === 'function_call_result' &&
          item.rawItem.callId === 'call-missing',
      );
      expect(preResumeMissingResults).toHaveLength(1);

      firstResult.state.approve(firstResult.interruptions[0]);
      const secondResult = await runner.run(agent, firstResult.state, {
        conversationId: 'conv-mixed-missing',
        toolNotFoundBehavior: 'return_error_to_model',
      });

      expect(secondResult.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);

      const allMissingResults = secondResult.state._generatedItems.filter(
        (item) =>
          item.rawItem.type === 'function_call_result' &&
          item.rawItem.callId === 'call-missing',
      );
      expect(allMissingResults).toHaveLength(1);

      const secondInput = model.requests[1].input as AgentInputItem[];
      const missingResultsSentOnResume = secondInput.filter(
        (item) =>
          item.type === 'function_call_result' &&
          item.callId === 'call-missing',
      );
      expect(missingResultsSentOnResume).toHaveLength(1);
    });

    it('does not resend prior items when resuming with previousResponseId', async () => {
      const approvalTool = tool({
        name: 'test',
        description: 'tool that requires approval',
        parameters: z.object({ test: z.string() }),
        needsApproval: async () => true,
        execute: async ({ test }) => `result:${test}`,
      });

      const model = new TrackingModel([
        modelResponse(
          buildResponse([buildToolCall('call-prev', 'foo')], 'resp-prev-1'),
        ),
        modelResponse(buildResponse([fakeModelMessage('done')], 'resp-prev-2')),
      ]);

      const agent = new Agent({
        name: 'ApprovalPrevAgent',
        model,
        tools: [approvalTool],
      });

      const runner = new Runner();
      const firstResult = await runner.run(agent, 'user_message', {
        previousResponseId: 'initial-response',
      });

      expect(firstResult.interruptions).toHaveLength(1);
      const approvalItem = firstResult.interruptions[0];
      firstResult.state.approve(approvalItem);

      const secondResult = await runner.run(agent, firstResult.state, {
        previousResponseId: 'initial-response',
      });

      expect(secondResult.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);

      expect(model.requests[0].previousResponseId).toBe('initial-response');

      const secondRequest = model.requests[1];
      expect(secondRequest.previousResponseId).toBe('resp-prev-1');
      expect(Array.isArray(secondRequest.input)).toBe(true);
      const secondItems = secondRequest.input as AgentInputItem[];
      expect(secondItems).toHaveLength(1);
      expect(secondItems[0]).toMatchObject({
        type: 'function_call_result',
        callId: 'call-prev',
      });
    });

    it('does not replay an acknowledged result after serializing consecutive approvals', async () => {
      const approvalTool = tool({
        name: 'test',
        description: 'tool that requires approval',
        parameters: z.object({ test: z.string() }),
        needsApproval: async () => true,
        execute: async ({ test }) => `result:${test}`,
      });
      const model = new TrackingModel([
        modelResponse(
          buildResponse(
            [buildToolCall('call-serialized-1', 'first')],
            'resp-1',
          ),
        ),
        modelResponse(
          buildResponse(
            [buildToolCall('call-serialized-2', 'second')],
            'resp-2',
          ),
        ),
        modelResponse(buildResponse([fakeModelMessage('done')], 'resp-3')),
      ]);
      const agent = new Agent({
        name: 'SerializedConsecutiveApprovalAgent',
        model,
        tools: [approvalTool],
      });
      const runner = new Runner();

      const firstResult = await runner.run(agent, 'user_message', {
        previousResponseId: 'initial-response',
      });
      expect(firstResult.interruptions).toHaveLength(1);
      firstResult.state.approve(firstResult.interruptions[0]);

      const secondResult = await runner.run(agent, firstResult.state, {
        previousResponseId: 'initial-response',
      });
      expect(secondResult.interruptions).toHaveLength(1);

      const restoredState = await RunState.fromString(
        agent,
        secondResult.state.toString(),
      );
      const [restoredApproval] = restoredState.getInterruptions();
      restoredState.approve(restoredApproval);

      const thirdResult = await runner.run(agent, restoredState, {
        previousResponseId: 'initial-response',
      });

      expect(thirdResult.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(3);
      expect(model.requests[2].input).toEqual([
        expect.objectContaining({
          type: 'function_call_result',
          callId: 'call-serialized-2',
        }),
      ]);
    });

    it('does not replay acknowledged hosted MCP approval responses', async () => {
      const mcpTool = hostedMcpTool({
        serverLabel: 'demo_server',
        serverUrl: 'https://example.com',
        requireApproval: {
          always: { toolNames: ['demo_tool'] },
        },
      });
      const buildMcpApproval = (id: string): protocol.HostedToolCallItem => ({
        type: 'hosted_tool_call',
        id: `item-${id}`,
        name: 'mcp_approval_request',
        status: 'completed',
        providerData: {
          type: 'mcp_approval_request',
          server_label: 'demo_server',
          name: 'demo_tool',
          id,
          arguments: '{}',
        },
      });
      const model = new TrackingModel([
        modelResponse(
          buildResponse([buildMcpApproval('approval-1')], 'resp-mcp-1'),
        ),
        modelResponse(
          buildResponse([buildMcpApproval('approval-2')], 'resp-mcp-2'),
        ),
        modelResponse(buildResponse([fakeModelMessage('done')], 'resp-mcp-3')),
      ]);
      const agent = new Agent({
        name: 'ConsecutiveHostedMcpApprovalAgent',
        model,
        tools: [mcpTool],
      });
      const runner = new Runner();

      const firstResult = await runner.run(agent, 'user_message', {
        conversationId: 'conv-mcp-consecutive',
      });
      expect(firstResult.interruptions).toHaveLength(1);
      firstResult.state.approve(firstResult.interruptions[0]);

      const secondResult = await runner.run(agent, firstResult.state, {
        conversationId: 'conv-mcp-consecutive',
      });
      expect(secondResult.interruptions).toHaveLength(1);
      secondResult.state.approve(secondResult.interruptions[0]);

      const thirdResult = await runner.run(agent, secondResult.state, {
        conversationId: 'conv-mcp-consecutive',
      });

      expect(thirdResult.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(3);
      expect(model.requests[2].input).toEqual([
        expect.objectContaining({
          type: 'hosted_tool_call',
          name: 'mcp_approval_response',
          providerData: expect.objectContaining({
            approval_request_id: 'approval-2',
          }),
        }),
      ]);
    });

    it('does not resend items when resuming multiple times without new approvals', async () => {
      const approvalTool = tool({
        name: 'test',
        description: 'approval tool',
        parameters: z.object({ test: z.string() }),
        needsApproval: async () => true,
        execute: async ({ test }) => `result:${test}`,
      });

      const model = new TrackingModel([
        modelResponse(
          buildResponse([buildToolCall('call-repeat', 'foo')], 'resp-repeat-1'),
        ),
        modelResponse(
          buildResponse([fakeModelMessage('done')], 'resp-repeat-2'),
        ),
      ]);

      const agent = new Agent({
        name: 'RepeatAgent',
        model,
        tools: [approvalTool],
      });

      const runner = new Runner();
      const firstResult = await runner.run(agent, 'user_message', {
        conversationId: 'conv-repeat',
      });

      expect(firstResult.interruptions).toHaveLength(1);
      const approvalItem = firstResult.interruptions[0];
      firstResult.state.approve(approvalItem);

      const secondResult = await runner.run(agent, firstResult.state, {
        conversationId: 'conv-repeat',
      });

      expect(secondResult.finalOutput).toBe('done');

      const thirdResult = await runner.run(agent, secondResult.state, {
        conversationId: 'conv-repeat',
      });

      expect(thirdResult.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);
    });

    it('sends newly appended generated items when resuming', async () => {
      const approvalTool = tool({
        name: 'test',
        description: 'approval tool',
        parameters: z.object({ test: z.string() }),
        needsApproval: async () => true,
        execute: async ({ test }) => `result:${test}`,
      });

      const model = new TrackingModel([
        modelResponse(
          buildResponse([buildToolCall('call-extra', 'foo')], 'resp-extra-1'),
        ),
        modelResponse(
          buildResponse([fakeModelMessage('done')], 'resp-extra-2'),
        ),
      ]);

      const agent = new Agent({
        name: 'ExtraAgent',
        model,
        tools: [approvalTool],
      });

      const runner = new Runner();
      const firstResult = await runner.run(agent, 'user_message', {
        conversationId: 'conv-extra',
      });

      expect(firstResult.interruptions).toHaveLength(1);
      const approvalItem = firstResult.interruptions[0];

      const extraMessage = new MessageOutputItem(
        fakeModelMessage('cached note'),
        agent,
      );
      firstResult.state._generatedItems.push(extraMessage);

      firstResult.state.approve(approvalItem);

      const secondResult = await runner.run(agent, firstResult.state, {
        conversationId: 'conv-extra',
      });

      expect(secondResult.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);

      const secondItems = model.requests[1].input as AgentInputItem[];
      expect(secondItems).toHaveLength(2);
      expect(secondItems[0]).toMatchObject({
        type: 'message',
        content: expect.arrayContaining([
          expect.objectContaining({ text: 'cached note' }),
        ]),
      });
      expect(secondItems[1]).toMatchObject({
        type: 'function_call_result',
        callId: 'call-extra',
      });
    });

    it('sends only approved items when mixing function and MCP approvals', async () => {
      const functionTool = tool({
        name: 'test',
        description: 'function tool',
        parameters: z.object({ test: z.string() }),
        needsApproval: async () => true,
        execute: async ({ test }) => `result:${test}`,
      });

      const mcpTool = hostedMcpTool({
        serverLabel: 'demo_server',
        serverUrl: 'https://example.com',
        requireApproval: {
          always: { toolNames: ['demo_tool'] },
        },
      });

      const mcpApprovalCall: protocol.HostedToolCallItem = {
        type: 'hosted_tool_call',
        id: 'approval-id',
        name: 'mcp_approval_request',
        status: 'completed',
        providerData: {
          type: 'mcp_approval_request',
          server_label: 'demo_server',
          name: 'demo_tool',
          id: 'approval-id',
          arguments: '{}',
        },
      } as protocol.HostedToolCallItem;

      const model = new TrackingModel([
        modelResponse(
          buildResponse(
            [mcpApprovalCall, buildToolCall('call-mixed', 'foo')],
            'resp-mixed-1',
          ),
        ),
        modelResponse(
          buildResponse([fakeModelMessage('still waiting')], 'resp-mixed-2'),
        ),
      ]);

      const agent = new Agent({
        name: 'MixedAgent',
        model,
        tools: [functionTool, mcpTool],
      });

      const runner = new Runner();
      const firstResult = await runner.run(agent, 'user_message', {
        conversationId: 'conv-mixed',
      });

      const functionApproval = firstResult.interruptions.find(
        (item) => item.rawItem.type === 'function_call',
      );
      const mcpApproval = firstResult.interruptions.find(
        (item) => item.rawItem.type === 'hosted_tool_call',
      );

      expect(functionApproval).toBeDefined();
      expect(mcpApproval).toBeDefined();

      firstResult.state.approve(functionApproval!);

      const secondResult = await runner.run(agent, firstResult.state, {
        conversationId: 'conv-mixed',
      });

      expect(model.requests).toHaveLength(1);

      const toolOutputs = secondResult.newItems.filter(
        (item) =>
          item instanceof ToolCallOutputItem &&
          item.rawItem.type === 'function_call_result' &&
          item.rawItem.callId === 'call-mixed',
      );
      expect(toolOutputs).toHaveLength(1);

      expect(secondResult.interruptions).toHaveLength(1);
      expect(secondResult.interruptions[0].rawItem).toMatchObject({
        providerData: { id: 'approval-id', type: 'mcp_approval_request' },
      });
      expect(secondResult.state._currentStep?.type).toBe(
        'next_step_interruption',
      );
    });

    it('does not use toolErrorFormatter for hosted MCP rejection responses', async () => {
      const mcpTool = hostedMcpTool({
        serverLabel: 'demo_server',
        serverUrl: 'https://example.com',
        requireApproval: {
          always: { toolNames: ['demo_tool'] },
        },
      });

      const mcpApprovalCall: protocol.HostedToolCallItem = {
        type: 'hosted_tool_call',
        id: 'approval-id',
        name: 'mcp_approval_request',
        status: 'completed',
        providerData: {
          type: 'mcp_approval_request',
          server_label: 'demo_server',
          name: 'demo_tool',
          id: 'approval-id',
          arguments: '{}',
        },
      } as protocol.HostedToolCallItem;

      const model = new TrackingModel([
        modelResponse(buildResponse([mcpApprovalCall], 'resp-mcp-reject-1')),
        modelResponse(
          buildResponse([fakeModelMessage('done')], 'resp-mcp-reject-2'),
        ),
      ]);

      const agent = new Agent({
        name: 'HostedMcpRejectAgent',
        model,
        tools: [mcpTool],
      });

      const formatter = vi.fn(() => 'Formatter denial');
      const runner = new Runner({
        toolErrorFormatter: formatter,
      });
      const firstResult = await runner.run(agent, 'user_message', {
        conversationId: 'conv-mcp-reject',
      });

      expect(firstResult.interruptions).toHaveLength(1);
      firstResult.state.reject(firstResult.interruptions[0]);

      const secondResult = await runner.run(agent, firstResult.state, {
        conversationId: 'conv-mcp-reject',
      });

      expect(secondResult.finalOutput).toBe('done');
      expect(formatter).not.toHaveBeenCalled();
      expect(model.requests).toHaveLength(2);

      const secondRequest = model.requests[1];
      expect(secondRequest.conversationId).toBe('conv-mcp-reject');
      expect(Array.isArray(secondRequest.input)).toBe(true);
      const secondItems = secondRequest.input as AgentInputItem[];
      expect(secondItems).toHaveLength(1);
      expect(secondItems[0]).toMatchObject({
        type: 'hosted_tool_call',
        name: 'mcp_approval_response',
        providerData: {
          approve: false,
          approval_request_id: 'approval-id',
        },
      });
      expect(
        (
          secondItems[0] as protocol.HostedToolCallItem & {
            providerData: { reason?: string };
          }
        ).providerData.reason,
      ).toBeUndefined();
    });

    it('sends full history when no server-managed state is provided', async () => {
      const model = new TrackingModel([
        modelResponse(
          buildResponse(
            [fakeModelMessage('a_message'), buildToolCall('call-1', 'foo')],
            'resp-789',
          ),
        ),
        modelResponse(buildResponse([fakeModelMessage('done')], 'resp-900')),
      ]);

      const agent = new Agent({
        name: 'Test',
        model,
        tools: [serverTool],
      });

      const runner = new Runner();
      const result = await runner.run(agent, 'user_message');

      expect(result.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);

      const secondInput = model.requests[1].input;
      expect(Array.isArray(secondInput)).toBe(true);
      const secondItems = secondInput as AgentInputItem[];
      expect(secondItems).toHaveLength(4);
      expect(secondItems[0]).toMatchObject({ role: 'user' });
      expect(secondItems[1]).toMatchObject({ role: 'assistant' });
      expect(secondItems[2]).toMatchObject({
        type: 'function_call',
        name: 'test',
      });
      expect(secondItems[3]).toMatchObject({
        type: 'function_call_result',
        callId: 'call-1',
      });
    });
  });

  describe('inline compaction items', () => {
    class RecordingModel extends ScriptedModel {
      get requests(): readonly Readonly<ModelRequest>[] {
        return this.calls.map((call) => call.request);
      }
    }

    const COMPACTION_ITEM: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_inline',
      encrypted_content: 'ciphertext',
      created_by: 'compaction_endpoint',
      providerData: { extra: 'value' },
    };

    it('replays a compaction marker in provider order on the next request', async () => {
      const lookup = tool({
        name: 'lookup',
        description: 'Look something up.',
        parameters: z.object({}),
        execute: async () => 'tool result payload',
      });
      const model = new RecordingModel([
        modelResponse({
          output: [
            COMPACTION_ITEM,
            {
              ...TEST_MODEL_FUNCTION_CALL,
              name: 'lookup',
              callId: 'call_lookup',
              arguments: '{}',
            },
          ],
          usage: new Usage(),
        }),
        modelResponse({
          output: [fakeModelMessage('done')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'CompactionAgent',
        model,
        tools: [lookup],
      });

      const result = await run(agent, [user('identifiable old user input')]);

      expect(result.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);
      const secondInput = getRequestInputItems(model.requests[1]);
      expect(secondInput).toHaveLength(3);
      expect(secondInput[0]).toEqual(COMPACTION_ITEM);
      expect(secondInput[1]).toMatchObject({
        type: 'function_call',
        callId: 'call_lookup',
      });
      expect(secondInput[2]).toMatchObject({
        type: 'function_call_result',
        callId: 'call_lookup',
      });
      expect(secondInput).not.toContainEqual(
        expect.objectContaining({
          content: 'identifiable old user input',
        }),
      );
      expect(result.output).toContainEqual(COMPACTION_ITEM);
      expect(result.history[0]).toEqual(COMPACTION_ITEM);
    });

    it('rewrites ordinary session history from the latest compaction marker', async () => {
      const session = new CoreMemorySession({
        initialItems: [user('earlier stored input')],
      });
      const clearSession = vi.spyOn(session, 'clearSession');
      const model = new RecordingModel([
        modelResponse({
          output: [COMPACTION_ITEM, fakeModelMessage('first turn done')],
          usage: new Usage(),
        }),
        modelResponse({
          output: [fakeModelMessage('second turn done')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'SessionCompactionAgent',
        model,
      });

      await run(agent, 'new user input', { session });

      expect(clearSession).toHaveBeenCalledOnce();
      const stored = await session.getItems();
      expect(stored[0]).toEqual(COMPACTION_ITEM);
      expect(stored).toHaveLength(2);

      await run(agent, 'later user input', { session });
      const laterInput = getRequestInputItems(model.requests[1]);
      expect(laterInput[0]).toEqual(COMPACTION_ITEM);
      expect(laterInput).not.toContainEqual(
        expect.objectContaining({ content: 'earlier stored input' }),
      );
      expect(getFirstTextContent(laterInput[laterInput.length - 1])).toBe(
        'later user input',
      );
    });
  });

  describe('selectModel', () => {
    const MODEL_A = 'gpt-4o';
    const MODEL_B = 'gpt-4.1-mini';

    it("returns the agent's model when it is a non-empty string and no override is provided", () => {
      const result = selectModel(MODEL_A, undefined);
      expect(result).toBe(MODEL_A);
    });

    it("returns the agent's model when it is a non-empty string even when an override is provided", () => {
      const result = selectModel(MODEL_A, MODEL_B);
      expect(result).toBe(MODEL_A);
    });

    it("returns the agent's model when it is a Model instance and no override is provided", () => {
      const fakeModel = new ScriptedModel();
      const result = selectModel(fakeModel, undefined);
      expect(result).toBe(fakeModel);
    });

    it("returns the agent's model when it is a Model instance even when an override is provided", () => {
      const fakeModel = new ScriptedModel();
      const result = selectModel(fakeModel, MODEL_B);
      expect(result).toBe(fakeModel);
    });

    it('returns the override model when the agent model is the default placeholder', () => {
      const result = selectModel(Agent.DEFAULT_MODEL_PLACEHOLDER, MODEL_B);
      expect(result).toBe(MODEL_B);
    });

    it('returns the default placeholder when both agent and override models are the default placeholder / undefined', () => {
      const result = selectModel(Agent.DEFAULT_MODEL_PLACEHOLDER, undefined);
      expect(result).toBe(Agent.DEFAULT_MODEL_PLACEHOLDER);
    });
  });
});
