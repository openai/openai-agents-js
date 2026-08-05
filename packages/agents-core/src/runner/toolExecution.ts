import { FunctionCallResultItem } from '../types/protocol';
import { Agent, AgentOutputType, ToolsToFinalOutputResult } from '../agent';
import {
  setAgentToolParentRunConfigOnDetails,
  setToolCallParentSpanOnDetails,
} from '../agentToolRunConfig';
import { consumeAgentToolRunResult } from '../agentToolRunResults';
import {
  clearToolErrorState,
  InvalidToolOutputError,
  isToolTimeoutError,
  ToolCallError,
  UserError,
} from '../errors';
import {
  createInvalidToolInputFailure,
  type InvalidToolInputFailure,
  isRedactedInvalidToolInputError,
  refreshInvalidToolInputFailure,
} from '../toolInputError';
import { getTransferMessage, HandoffInputData } from '../handoff';
import {
  RunHandoffCallItem,
  RunHandoffOutputItem,
  RunItem,
  RunMessageOutputItem,
  RunToolApprovalItem,
  RunToolCallOutputItem,
} from '../items';
import { assistant } from '../helpers/message';
import logger, { Logger, logToolActionError } from '../logger';
import { ModelResponse } from '../model';
import {
  ComputerSafetyCheck,
  ComputerSafetyCheckResult,
  ComputerToolCustomDataContext,
  FunctionTool,
  type FunctionToolPreparedInput,
  FunctionToolResult,
  FunctionToolCustomDataContext,
  ToolCallDetails,
  FUNCTION_TOOL_PARSED_INPUT_CALLBACK,
  ApplyPatchToolCustomDataContext,
  invokeFunctionTool,
  prepareFunctionToolInput,
  hasDynamicFunctionToolApprovalPolicy,
  hasInspectableFunctionToolArguments,
  setFunctionToolPreparedInput,
  validateFunctionToolOutput,
  resolveComputer,
  Tool,
} from '../tool';
import type { ShellResult } from '../shell';
import { RunContext } from '../runContext';
import type { RunResult } from '../result';
import { isAbortError } from '../utils/abortSignals';
import { isZodObject } from '../utils';
import { toSmartString } from '../utils/smartString';
import { withFunctionSpan, withHandoffSpan } from '../tracing/createSpans';
import { getCurrentTrace } from '../tracing/context';
import type { FunctionSpanData, Span } from '../tracing/spans';
import * as protocol from '../types/protocol';
import { Computer } from '../computer';
import type { ApplyPatchResult } from '../editor';
import { RunState } from '../runState';
import type { AgentInputItem, UnknownContext } from '../types';
import type { RunConfig, Runner, ToolErrorFormatter } from '../run';
import {
  getFunctionToolQualifiedName,
  getFunctionToolStateKey,
  getFunctionToolStateKeys,
  matchesFunctionToolName,
} from '../toolIdentity';
import {
  convertStructuredToolOutputToInputItem,
  normalizeStructuredToolOutputs,
} from './toolOutputNormalization';
import {
  runToolInputGuardrails,
  runToolOutputGuardrails,
} from '../utils/toolGuardrails';
import type {
  ToolInputGuardrailResult,
  ToolOutputGuardrailResult,
} from '../toolGuardrail';
import { maybeExtractToolOutputCustomData } from '../utils/customData';
import {
  resolveApprovalRejectionMessage,
  TOOL_APPROVAL_REJECTION_MESSAGE,
} from './approvalRejection';
import type {
  ToolRunApplyPatch,
  ToolRunComputer,
  ToolRunFunction,
  ToolRunHandoff,
  ToolRunShell,
} from './types';
import { SingleStepResult } from './steps';
import {
  getRunStateUsageRecorder,
  setToolUsageRecorder,
} from './usageTracking';
import { getRunStateTurnSpanParent } from './invocationContext';
import {
  buildComputerAbortResult,
  buildFunctionAbortResult,
  COMPUTER_FALLBACK_SCREENSHOT_DATA_URL,
} from './streamReconciliation';

type FunctionToolCallDeps<TContext = UnknownContext> = {
  agent: Agent<TContext, any>;
  runner: Runner;
  state: RunState<TContext, Agent<TContext, any>>;
  toolErrorFormatter?: ToolErrorFormatter;
  agentToolParentRunConfig?: Partial<RunConfig>;
  signal?: AbortSignal;
};

const REDACTED_TOOL_ERROR_MESSAGE =
  'Tool execution failed. Error details are redacted.';

type ParseToolArgumentsResult =
  | {
      success: true;
      approvalArgs: any;
      preparedInput?: FunctionToolPreparedInput;
    }
  | {
      success: false;
      error: unknown;
      approvalArgs?: any;
      preparedInput?: FunctionToolPreparedInput;
    };

type ToolInputGuardrailCheckResult =
  { type: 'allow' } | { type: 'reject'; message: string };

type InvalidToolInputRedactionBoundary = {
  failure: InvalidToolInputFailure;
  redactedLegacyOutput: string;
};

function getFunctionToolIdentity<TContext>(
  toolRun: ToolRunFunction<TContext>,
): string {
  return getFunctionToolQualifiedName(toolRun.tool) ?? toolRun.tool.name;
}

function cloneForCustomDataContext<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function getFunctionToolCallbackToolCall(
  toolCall: protocol.FunctionCallItem,
  redactArguments: boolean,
): protocol.FunctionCallItem {
  if (!redactArguments) {
    return toolCall;
  }
  return {
    type: 'function_call',
    callId: toolCall.callId,
    name: toolCall.name,
    arguments: '',
    ...(toolCall.id ? { id: toolCall.id } : {}),
    ...(toolCall.namespace ? { namespace: toolCall.namespace } : {}),
    ...(toolCall.status ? { status: toolCall.status } : {}),
    ...(toolCall.caller ? { caller: toolCall.caller } : {}),
  };
}

function getFunctionToolTraceName<TContext>(
  toolRun: ToolRunFunction<TContext>,
): string {
  return getFunctionToolIdentity(toolRun);
}

function getFunctionToolApprovalStateKey<TContext>(
  toolRun: ToolRunFunction<TContext>,
): string {
  return (
    getFunctionToolStateKey(toolRun.tool) ?? getFunctionToolIdentity(toolRun)
  );
}

function getFunctionToolPendingStateKeys<TContext>(
  toolRun: ToolRunFunction<TContext>,
): string[] {
  const availableTools = toolRun.availableFunctionTools ?? [toolRun.tool];
  return getFunctionToolStateKeys(toolRun.tool, availableTools);
}

const COMPUTER_TRACE_NAME = 'computer';

function getComputerToolActions(
  toolCall: protocol.ComputerUseCallItem,
): protocol.ComputerAction[] {
  if (Array.isArray(toolCall.actions) && toolCall.actions.length > 0) {
    return toolCall.actions;
  }

  return toolCall.action ? [toolCall.action] : [];
}

function getComputerTraceInputPayload(
  toolCall: protocol.ComputerUseCallItem,
): protocol.ComputerAction[] | protocol.ComputerAction | undefined {
  const actions = getComputerToolActions(toolCall);

  if (Array.isArray(toolCall.actions) && toolCall.actions.length > 0) {
    return actions;
  }

  return actions[0];
}

/**
 * @internal
 * Normalizes tool outputs once so downstream code works with fully structured protocol items.
 * Doing this here keeps API surface stable even when providers add new shapes.
 */
export function getToolCallOutputItem(
  toolCall: protocol.FunctionCallItem,
  output: string | unknown,
  options?: {
    outputSchema?: FunctionTool<any, any, any>['outputSchema'];
  },
): FunctionCallResultItem {
  const hasOutputSchema = typeof options?.outputSchema !== 'undefined';
  const maybeStructuredOutputs = hasOutputSchema
    ? null
    : normalizeStructuredToolOutputs(output);

  if (maybeStructuredOutputs) {
    const structuredItems = maybeStructuredOutputs.map(
      convertStructuredToolOutputToInputItem,
    );

    return {
      type: 'function_call_result',
      name: toolCall.name,
      ...(typeof toolCall.namespace === 'string'
        ? { namespace: toolCall.namespace }
        : {}),
      callId: toolCall.callId,
      status: 'completed',
      output: structuredItems,
      ...(toolCall.caller ? { caller: toolCall.caller } : {}),
    };
  }

  let textOutput: string;
  if (hasOutputSchema) {
    try {
      const serializedOutput = JSON.stringify(output);
      if (typeof serializedOutput !== 'string') {
        throw new Error('The output is not a JSON value.');
      }
      textOutput = serializedOutput;
    } catch (error) {
      throw new InvalidToolOutputError(
        `Function tool '${toolCall.name}' outputSchema requires a JSON-serializable output.`,
        undefined,
        error,
        { output },
      );
    }
  } else {
    textOutput = toSmartString(output);
  }

  return {
    type: 'function_call_result',
    name: toolCall.name,
    ...(typeof toolCall.namespace === 'string'
      ? { namespace: toolCall.namespace }
      : {}),
    callId: toolCall.callId,
    status: 'completed',
    output: {
      type: 'text',
      text: textOutput,
    },
    ...(toolCall.caller ? { caller: toolCall.caller } : {}),
  };
}

/**
 * @internal
 * Runs every function tool call requested by the model and returns their outputs alongside
 * the `RunItem` instances that should be appended to history.
 */
export async function executeFunctionToolCalls<TContext = UnknownContext>(
  agent: Agent<TContext, any>,
  toolRuns: ToolRunFunction<TContext>[],
  runner: Runner,
  state: RunState<TContext, Agent<TContext, any>>,
  toolErrorFormatter?: ToolErrorFormatter,
  agentToolParentRunConfig?: Partial<RunConfig>,
  signal?: AbortSignal,
): Promise<FunctionToolResult<TContext>[]> {
  const deps: FunctionToolCallDeps<TContext> = {
    agent,
    runner,
    state,
    toolErrorFormatter,
    agentToolParentRunConfig,
    signal,
  };

  const startedInvalidInputFailures: InvalidToolInputFailure[] = [];

  const executeToolRun = async (toolRun: ToolRunFunction<TContext>) => {
    if (signal?.aborted) {
      return buildFunctionCancellationResult(deps, toolRun);
    }
    const parseResult = parseToolArguments(toolRun);
    let failure: InvalidToolInputFailure | undefined;
    if (!parseResult.success) {
      failure = createInvalidToolInputFailure({
        message: `Invalid input for function tool '${getFunctionToolIdentity(toolRun)}'.`,
        state: deps.state,
        originalError: parseResult.error,
        toolInvocation: {
          runContext: deps.state._context,
          input: toolRun.toolCall.arguments,
          details: { toolCall: toolRun.toolCall },
        },
        disposition: parseResult.preparedInput?.disposition,
      });
      startedInvalidInputFailures.push(failure);
    }

    const dynamicApprovalPolicy = hasDynamicFunctionToolApprovalPolicy(
      toolRun.tool,
    );
    // Handle parse errors gracefully instead of crashing.
    if (!parseResult.success) {
      if (parseResult.preparedInput) {
        const approvalOutcome = await handleFunctionApproval(
          deps,
          toolRun,
          parseResult.approvalArgs,
          false,
          failure,
        );
        if (approvalOutcome !== 'approved') {
          return approvalOutcome;
        }
        try {
          return await runApprovedFunctionTool(
            deps,
            toolRun,
            parseResult.approvalArgs,
            parseResult.preparedInput,
            failure,
          );
        } catch (error) {
          if (
            signal?.aborted &&
            (error === signal.reason || isAbortError(error))
          ) {
            return buildFunctionCancellationResult(deps, toolRun);
          }
          throw error;
        }
      } else if (dynamicApprovalPolicy) {
        const approvalOutcome = await handleFunctionApproval(
          deps,
          toolRun,
          undefined,
          true,
          failure,
        );
        if (approvalOutcome !== 'approved') {
          return approvalOutcome;
        }
      }
      return buildParseErrorResult(deps, toolRun, parseResult.error, failure!);
    }

    const approvalOutcome = await handleFunctionApproval(
      deps,
      toolRun,
      parseResult.approvalArgs,
      dynamicApprovalPolicy &&
        !hasInspectableFunctionToolArguments(parseResult.approvalArgs),
    );
    if (approvalOutcome !== 'approved') {
      return approvalOutcome;
    }
    try {
      return await runApprovedFunctionTool(
        deps,
        toolRun,
        parseResult.approvalArgs,
        parseResult.preparedInput,
      );
    } catch (error) {
      if (signal?.aborted && (error === signal.reason || isAbortError(error))) {
        return buildFunctionCancellationResult(deps, toolRun);
      }
      throw error;
    }
  };

  try {
    const results = await executeToolRunsWithConcurrency(
      toolRuns,
      getMaxFunctionToolConcurrency(
        agentToolParentRunConfig?.toolExecution ?? runner.config.toolExecution,
      ),
      executeToolRun,
    );
    return results;
  } catch (e: unknown) {
    const redactInvalidInputFailure = startedInvalidInputFailures.some(
      (failure) => refreshInvalidToolInputFailure(failure),
    );
    if (redactInvalidInputFailure) {
      clearToolErrorState(e, state);
    }
    if (isToolTimeoutError(e)) {
      if (redactInvalidInputFailure) {
        e.state = undefined;
      } else {
        e.state ??= state;
      }
      throw e;
    }

    const surfacedError = e as Error;
    throw new ToolCallError(
      `Failed to run function tools: ${surfacedError}`,
      surfacedError,
      redactInvalidInputFailure || isRedactedInvalidToolInputError(e)
        ? undefined
        : state,
    );
  }
}

function getMaxFunctionToolConcurrency(
  toolExecution: RunConfig['toolExecution'] | undefined,
): number | undefined {
  return toolExecution?.maxFunctionToolConcurrency ?? undefined;
}

function shouldRunPreApprovalInputGuardrails<TContext>(
  deps: FunctionToolCallDeps<TContext>,
): boolean {
  return (
    (
      deps.agentToolParentRunConfig?.toolExecution ??
      deps.runner.config.toolExecution
    )?.preApprovalInputGuardrails === true
  );
}

async function executeToolRunsWithConcurrency<TContext, TToolRun>(
  toolRuns: TToolRun[],
  maxConcurrency: number | undefined,
  executeToolRun: (toolRun: TToolRun) => Promise<FunctionToolResult<TContext>>,
): Promise<FunctionToolResult<TContext>[]> {
  if (
    maxConcurrency === undefined ||
    maxConcurrency >= toolRuns.length ||
    toolRuns.length <= 1
  ) {
    return Promise.all(toolRuns.map((toolRun) => executeToolRun(toolRun)));
  }

  const results: FunctionToolResult<TContext>[] = [];
  let nextIndex = 0;
  let firstError: { value: unknown } | undefined;

  const worker = async () => {
    while (nextIndex < toolRuns.length && firstError === undefined) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      try {
        const result = await executeToolRun(toolRuns[currentIndex]);
        results[currentIndex] = result;
      } catch (error) {
        firstError ??= { value: error };
        break;
      }
    }
  };

  const workerCount = Math.min(maxConcurrency, toolRuns.length);
  // Drain every started worker before returning so no function tool retains
  // ownership after the run surfaces an error or cancellation.
  await Promise.allSettled(
    Array.from({ length: workerCount }, async () => worker()),
  );

  if (firstError !== undefined) {
    throw firstError.value;
  }
  return results;
}

function parseToolArguments<TContext>(
  toolRun: ToolRunFunction<TContext>,
): ParseToolArgumentsResult {
  const toolName = getFunctionToolIdentity(toolRun);
  try {
    let approvalArgs: any = toolRun.toolCall.arguments;
    if (toolRun.tool.parameters) {
      if (isZodObject(toolRun.tool.parameters)) {
        approvalArgs = toolRun.tool.parameters.parse(approvalArgs);
      } else {
        approvalArgs = JSON.parse(approvalArgs);
      }
    }
    const preparedInput = prepareFunctionToolInput(
      toolRun.tool,
      toolRun.toolCall.arguments,
    );
    if (preparedInput && !preparedInput.result.success) {
      return {
        success: false,
        error: preparedInput.result.error,
        approvalArgs,
        preparedInput,
      };
    }
    return { success: true, approvalArgs, preparedInput };
  } catch (error) {
    if (logger.dontLogToolData) {
      logger.debug(`Failed to parse tool arguments for ${toolName}`);
    } else {
      logger.debug(`Failed to parse tool arguments for ${toolName}: ${error}`);
    }
    return { success: false, error };
  }
}

function buildApprovalRequestResult<TContext>(
  deps: FunctionToolCallDeps<TContext>,
  toolRun: ToolRunFunction<TContext>,
): FunctionToolResult<TContext> {
  return {
    type: 'function_approval' as const,
    tool: toolRun.tool,
    runItem: new RunToolApprovalItem(
      toolRun.toolCall,
      deps.agent,
      getFunctionToolIdentity(toolRun),
      getFunctionToolStateKey(toolRun.tool),
    ),
  };
}

function buildFunctionFailureResult<TContext>(
  deps: FunctionToolCallDeps<TContext>,
  toolRun: ToolRunFunction<TContext>,
  output: unknown,
): FunctionToolResult<TContext> {
  return {
    type: 'function_output' as const,
    tool: toolRun.tool,
    output,
    runItem: new RunToolCallOutputItem(
      getToolCallOutputItem(toolRun.toolCall, output, {
        outputSchema: toolRun.tool.outputSchema,
      }),
      deps.agent,
      output,
    ),
  };
}

function buildFunctionCancellationResult<TContext>(
  deps: FunctionToolCallDeps<TContext>,
  toolRun: ToolRunFunction<TContext>,
): FunctionToolResult<TContext> {
  const output = 'aborted';
  const rawItem = buildFunctionAbortResult(toolRun.toolCall);
  return {
    type: 'function_output',
    tool: toolRun.tool,
    output,
    runItem: new RunToolCallOutputItem(rawItem, deps.agent, output),
  };
}

async function resolveFunctionFailureOutput<TContext>(
  deps: FunctionToolCallDeps<TContext>,
  toolRun: ToolRunFunction<TContext>,
  error: Error,
  legacyOutput: string,
  redactionBoundary?: InvalidToolInputRedactionBoundary,
): Promise<unknown> {
  const redactedBeforeCallback = redactionBoundary
    ? refreshInvalidToolInputFailure(redactionBoundary.failure)
    : isRedactedInvalidToolInputError(error);
  const callbackError = redactedBeforeCallback
    ? (redactionBoundary?.failure.error ?? error)
    : error;
  const effectiveLegacyOutput = redactedBeforeCallback
    ? (redactionBoundary?.redactedLegacyOutput ?? legacyOutput)
    : legacyOutput;

  if (!toolRun.tool.outputSchema) {
    return effectiveLegacyOutput;
  }

  if (!toolRun.tool.errorFunction) {
    throw callbackError;
  }

  const details: ToolCallDetails | undefined = redactedBeforeCallback
    ? undefined
    : { toolCall: toolRun.toolCall };
  try {
    const output = await toolRun.tool.errorFunction(
      deps.state._context,
      callbackError,
      details,
    );
    if (
      redactionBoundary &&
      !redactedBeforeCallback &&
      refreshInvalidToolInputFailure(redactionBoundary.failure)
    ) {
      throw redactionBoundary.failure.error;
    }
    const validatedOutput = validateFunctionToolOutput({
      tool: toolRun.tool,
      output,
      runContext: deps.state._context,
      details,
    });
    if (
      redactionBoundary &&
      !redactedBeforeCallback &&
      refreshInvalidToolInputFailure(redactionBoundary.failure)
    ) {
      throw redactionBoundary.failure.error;
    }
    return validatedOutput;
  } catch (callbackFailure) {
    if (
      redactionBoundary &&
      refreshInvalidToolInputFailure(redactionBoundary.failure)
    ) {
      throw redactionBoundary.failure.error;
    }
    throw callbackFailure;
  }
}

async function buildParseErrorResult<TContext>(
  deps: FunctionToolCallDeps<TContext>,
  toolRun: ToolRunFunction<TContext>,
  error: unknown,
  failure: InvalidToolInputFailure,
): Promise<FunctionToolResult<TContext>> {
  const traceToolName = getFunctionToolTraceName(toolRun);
  return withRunStateToolFunctionSpan(deps, traceToolName, async (span) => {
    refreshInvalidToolInputFailure(failure);
    if (
      span &&
      deps.runner.config.traceIncludeSensitiveData &&
      !failure.redacted
    ) {
      span.spanData.input = toolRun.toolCall.arguments;
    }
    span?.setError({
      message: 'Error running tool (non-fatal)',
      data: {
        tool_name: traceToolName,
        error: failure.error.toString(),
      },
    });

    const baseMessage =
      'An error occurred while parsing tool arguments. Please try again with valid JSON.';
    const errorMessage = failure.redacted
      ? baseMessage
      : `${baseMessage} Error: ${(error as Error).message}`;
    let output: unknown;
    try {
      output = await resolveFunctionFailureOutput(
        deps,
        toolRun,
        failure.error,
        errorMessage,
        { failure, redactedLegacyOutput: baseMessage },
      );
    } finally {
      refreshInvalidToolInputFailure(failure);
      if (failure.redacted && span) {
        span.spanData.input = '';
      }
    }
    if (span && deps.runner.config.traceIncludeSensitiveData) {
      span.spanData.output = toSmartString(output);
    }
    return buildFunctionFailureResult(deps, toolRun, output);
  });
}

async function buildApprovalRejectionResult<TContext>(
  deps: FunctionToolCallDeps<TContext>,
  toolRun: ToolRunFunction<TContext>,
  invalidInputFailure?: InvalidToolInputFailure,
): Promise<FunctionToolResult<TContext>> {
  const { runner, state, toolErrorFormatter } = deps;
  const toolName = getFunctionToolIdentity(toolRun);
  const approvalToolNames = [getFunctionToolApprovalStateKey(toolRun)];
  const traceToolName = getFunctionToolTraceName(toolRun);
  return withRunStateToolFunctionSpan(deps, traceToolName, async (span) => {
    const response = await resolveApprovalRejectionMessage({
      runContext: state._context,
      toolType: 'function',
      toolName,
      approvalToolNames,
      approvalAgent: deps.agent,
      callId: toolRun.toolCall.callId,
      toolErrorFormatter,
    });
    const redactDetails = invalidInputFailure
      ? refreshInvalidToolInputFailure(invalidInputFailure)
      : false;
    const traceErrorMessage =
      runner.config.traceIncludeSensitiveData && !redactDetails
        ? response
        : TOOL_APPROVAL_REJECTION_MESSAGE;

    span?.setError({
      message: traceErrorMessage,
      data: {
        tool_name: traceToolName,
        error: `Tool execution for ${toolRun.toolCall.callId} was manually rejected by user.`,
      },
    });

    const output = await resolveFunctionFailureOutput(
      deps,
      toolRun,
      new Error(response),
      response,
      invalidInputFailure
        ? {
            failure: invalidInputFailure,
            redactedLegacyOutput: TOOL_APPROVAL_REJECTION_MESSAGE,
          }
        : undefined,
    );
    if (
      invalidInputFailure &&
      refreshInvalidToolInputFailure(invalidInputFailure) &&
      span
    ) {
      span.spanData.input = '';
    }
    if (span && runner.config.traceIncludeSensitiveData) {
      span.spanData.output = toSmartString(output);
    }
    return buildFunctionFailureResult(deps, toolRun, output);
  });
}

async function handleFunctionApproval<TContext>(
  deps: FunctionToolCallDeps<TContext>,
  toolRun: ToolRunFunction<TContext>,
  parsedArgs: any,
  forceApproval: boolean = false,
  invalidInputFailure?: InvalidToolInputFailure,
): Promise<'approved' | FunctionToolResult<TContext>> {
  const { agent, state } = deps;
  const approvalStateKey = getFunctionToolApprovalStateKey(toolRun);
  const pendingStateKeys = getFunctionToolPendingStateKeys(toolRun);
  const approval = state._context.isToolApproved({
    toolName: approvalStateKey,
    callId: toolRun.toolCall.callId,
    functionTool: false,
    agent,
  });

  if (approval === false) {
    for (const stateKey of pendingStateKeys) {
      state.clearPendingAgentToolRun(stateKey, toolRun.toolCall.callId);
    }
    return await buildApprovalRejectionResult(
      deps,
      toolRun,
      invalidInputFailure,
    );
  }

  if (approval === true) {
    return 'approved';
  }

  let needsApproval = forceApproval;
  if (!needsApproval) {
    try {
      needsApproval = await toolRun.tool.needsApproval(
        state._context,
        parsedArgs,
        toolRun.toolCall.callId,
      );
    } catch (error) {
      if (
        invalidInputFailure &&
        refreshInvalidToolInputFailure(invalidInputFailure)
      ) {
        throw invalidInputFailure.error;
      }
      throw error;
    }
  }

  if (!needsApproval) {
    return 'approved';
  }

  if (shouldRunPreApprovalInputGuardrails(deps)) {
    const redactedBeforeGuardrails = invalidInputFailure
      ? refreshInvalidToolInputFailure(invalidInputFailure)
      : false;
    const guardrailResults: ToolInputGuardrailResult[] = [];
    let inputGuardrailResult: ToolInputGuardrailCheckResult = { type: 'allow' };
    let guardrailFailed = false;
    let guardrailError: unknown;
    try {
      inputGuardrailResult = await runFunctionToolInputGuardrails({
        guardrails: toolRun.tool.inputGuardrails,
        context: state._context,
        agent,
        toolCall: getFunctionToolCallbackToolCall(
          toolRun.toolCall,
          redactedBeforeGuardrails,
        ),
        onResult: (result) => {
          guardrailResults.push(result);
        },
      });
    } catch (error) {
      guardrailFailed = true;
      guardrailError = error;
    }
    const redactedAfterGuardrails = invalidInputFailure
      ? refreshInvalidToolInputFailure(invalidInputFailure)
      : false;
    if (redactedBeforeGuardrails || !redactedAfterGuardrails) {
      state._toolInputGuardrailResults.push(...guardrailResults);
    }
    if (guardrailFailed) {
      const sdkTripwire = guardrailResults.some(
        (result) => result.output.behavior?.type === 'throwException',
      );
      if (
        invalidInputFailure &&
        redactedAfterGuardrails &&
        (!redactedBeforeGuardrails || !sdkTripwire)
      ) {
        throw invalidInputFailure.error;
      }
      throw guardrailError;
    }

    if (inputGuardrailResult.type === 'reject') {
      return buildInputGuardrailRejectionResult(
        deps,
        toolRun,
        inputGuardrailResult.message,
        invalidInputFailure,
      );
    }
  }
  return buildApprovalRequestResult(deps, toolRun);
}

async function buildInputGuardrailRejectionResult<TContext>(
  deps: FunctionToolCallDeps<TContext>,
  toolRun: ToolRunFunction<TContext>,
  message: string,
  invalidInputFailure?: InvalidToolInputFailure,
): Promise<FunctionToolResult<TContext>> {
  const output = await resolveFunctionFailureOutput(
    deps,
    toolRun,
    new Error(message),
    message,
    invalidInputFailure
      ? {
          failure: invalidInputFailure,
          redactedLegacyOutput: REDACTED_TOOL_ERROR_MESSAGE,
        }
      : undefined,
  );
  return buildFunctionFailureResult(deps, toolRun, output);
}

async function runFunctionToolInputGuardrails<TContext>({
  guardrails,
  context,
  agent,
  toolCall,
  onResult,
}: {
  guardrails?: ToolRunFunction<TContext>['tool']['inputGuardrails'];
  context: RunContext<TContext>;
  agent: Agent<TContext, any>;
  toolCall: protocol.FunctionCallItem;
  onResult?: (result: ToolInputGuardrailResult) => void;
}): Promise<ToolInputGuardrailCheckResult> {
  return runToolInputGuardrails({
    guardrails,
    context,
    agent,
    toolCall,
    onResult,
  });
}

async function runApprovedFunctionTool<TContext>(
  deps: FunctionToolCallDeps<TContext>,
  toolRun: ToolRunFunction<TContext>,
  approvalArgs: unknown,
  preparedInput: FunctionToolPreparedInput | undefined,
  invalidInputFailure?: InvalidToolInputFailure,
): Promise<FunctionToolResult<TContext>> {
  const { agent, runner, state, agentToolParentRunConfig, signal } = deps;
  const toolName = getFunctionToolIdentity(toolRun);
  const stateKeys = getFunctionToolPendingStateKeys(toolRun);
  const traceToolName = getFunctionToolTraceName(toolRun);
  return withRunStateToolFunctionSpan(deps, traceToolName, async (span) => {
    let preservedLifecycleError: unknown;
    const refreshRedaction = () => {
      const redacted = invalidInputFailure
        ? refreshInvalidToolInputFailure(invalidInputFailure)
        : false;
      if (redacted && span) {
        span.spanData.input = '';
      }
      return redacted;
    };
    const throwIfRedactionPromoted = (redactedBefore: boolean) => {
      if (!redactedBefore && refreshRedaction() && invalidInputFailure) {
        throw invalidInputFailure.error;
      }
    };
    if (
      span &&
      runner.config.traceIncludeSensitiveData &&
      !refreshRedaction()
    ) {
      span.spanData.input = toolRun.toolCall.arguments;
    }

    try {
      const redactedBeforeInputGuardrails = refreshRedaction();
      const inputGuardrailResults: ToolInputGuardrailResult[] = [];
      let inputGuardrailResult: ToolInputGuardrailCheckResult = {
        type: 'allow',
      };
      let inputGuardrailFailed = false;
      let inputGuardrailError: unknown;
      try {
        inputGuardrailResult = await runFunctionToolInputGuardrails({
          guardrails: toolRun.tool.inputGuardrails,
          context: state._context,
          agent,
          toolCall: getFunctionToolCallbackToolCall(
            toolRun.toolCall,
            redactedBeforeInputGuardrails,
          ),
          onResult: (result) => {
            inputGuardrailResults.push(result);
          },
        });
      } catch (error) {
        inputGuardrailFailed = true;
        inputGuardrailError = error;
        if (
          inputGuardrailResults.some(
            (result) => result.output.behavior?.type === 'throwException',
          )
        ) {
          preservedLifecycleError = error;
        }
      }
      const redactedAfterInputGuardrails = refreshRedaction();
      if (redactedBeforeInputGuardrails || !redactedAfterInputGuardrails) {
        state._toolInputGuardrailResults.push(...inputGuardrailResults);
      }
      if (inputGuardrailFailed) {
        if (
          !redactedBeforeInputGuardrails &&
          redactedAfterInputGuardrails &&
          invalidInputFailure
        ) {
          throw invalidInputFailure.error;
        }
        throw inputGuardrailError;
      }

      if (signal?.aborted) {
        return buildFunctionCancellationResult(deps, toolRun);
      }

      const redactedBeforeToolStart = refreshRedaction();
      try {
        emitFunctionToolStart(
          runner,
          state._context,
          agent,
          toolRun.tool,
          toolRun.toolCall,
          refreshRedaction,
        );
      } catch (hookError) {
        if (
          !redactedBeforeToolStart &&
          refreshRedaction() &&
          invalidInputFailure
        ) {
          throw invalidInputFailure.error;
        }
        throw hookError;
      }
      refreshRedaction();

      let toolOutput: unknown;
      let executedInput = approvalArgs;
      let toolDetails: ToolCallDetails = { toolCall: toolRun.toolCall };
      let shouldValidateToolOutput = false;
      if (inputGuardrailResult.type === 'reject') {
        toolOutput = await resolveFunctionFailureOutput(
          deps,
          toolRun,
          new Error(inputGuardrailResult.message),
          inputGuardrailResult.message,
          invalidInputFailure
            ? {
                failure: invalidInputFailure,
                redactedLegacyOutput: REDACTED_TOOL_ERROR_MESSAGE,
              }
            : undefined,
        );
      } else {
        const resumeState = stateKeys
          .map((stateKey) =>
            state.getPendingAgentToolRun(stateKey, toolRun.toolCall.callId),
          )
          .find((pendingState) => typeof pendingState !== 'undefined');
        const redactedBeforeInvocation = refreshRedaction();
        toolDetails = {
          toolCall: getFunctionToolCallbackToolCall(
            toolRun.toolCall,
            redactedBeforeInvocation,
          ),
          resumeState,
          ...(signal ? { signal } : {}),
          [FUNCTION_TOOL_PARSED_INPUT_CALLBACK]: (input: unknown) => {
            executedInput = cloneForCustomDataContext(input);
          },
        };
        if (preparedInput) {
          setFunctionToolPreparedInput(toolDetails, preparedInput);
        }
        setToolUsageRecorder(toolDetails, getRunStateUsageRecorder(state));
        setAgentToolParentRunConfigOnDetails(
          toolDetails,
          agentToolParentRunConfig ?? runner.config,
        );
        setToolCallParentSpanOnDetails(toolDetails, span);
        signal?.throwIfAborted();
        const invokedToolOutput = await invokeFunctionTool({
          tool: toolRun.tool,
          runContext: state._context,
          input: toolRun.toolCall.arguments,
          details: toolDetails,
        });
        throwIfRedactionPromoted(redactedBeforeInvocation);
        const redactedBeforeOutputGuardrails = refreshRedaction();
        const outputGuardrailResults: ToolOutputGuardrailResult[] = [];
        try {
          toolOutput = await runToolOutputGuardrails({
            guardrails: toolRun.tool.outputGuardrails,
            context: state._context,
            agent,
            toolCall: getFunctionToolCallbackToolCall(
              toolRun.toolCall,
              redactedBeforeOutputGuardrails,
            ),
            toolOutput: invokedToolOutput,
            onResult: (result) => {
              outputGuardrailResults.push(result);
            },
          });
        } catch (guardrailError) {
          if (
            outputGuardrailResults.some(
              (result) => result.output.behavior?.type === 'throwException',
            )
          ) {
            preservedLifecycleError = guardrailError;
          }
          throw guardrailError;
        } finally {
          throwIfRedactionPromoted(redactedBeforeOutputGuardrails);
          state._toolOutputGuardrailResults.push(...outputGuardrailResults);
        }
        shouldValidateToolOutput = toolOutput !== invokedToolOutput;
      }
      if (shouldValidateToolOutput) {
        const redactedBeforeOutputValidation = refreshRedaction();
        toolOutput = validateFunctionToolOutput({
          tool: toolRun.tool,
          output: toolOutput,
          runContext: state._context,
          details: toolDetails,
        });
        throwIfRedactionPromoted(redactedBeforeOutputValidation);
      }
      const stringResult = toSmartString(toolOutput);

      const rawItem = getToolCallOutputItem(toolRun.toolCall, toolOutput, {
        outputSchema: toolRun.tool.outputSchema,
      });
      if (refreshRedaction()) {
        executedInput = undefined;
      }
      const redactedBeforeCustomData = refreshRedaction();
      let customData: Awaited<
        ReturnType<typeof maybeExtractToolOutputCustomData>
      >;
      try {
        customData = await maybeExtractToolOutputCustomData(
          toolRun.tool.customDataExtractor,
          {
            runContext: state._context,
            tool: toolRun.tool,
            toolCall: cloneForCustomDataContext(
              getFunctionToolCallbackToolCall(
                toolRun.toolCall,
                redactedBeforeCustomData,
              ),
            ),
            input: cloneForCustomDataContext(executedInput),
            output: cloneForCustomDataContext(toolOutput),
            rawItem: cloneForCustomDataContext(rawItem),
          } satisfies FunctionToolCustomDataContext<TContext>,
        );
      } finally {
        throwIfRedactionPromoted(redactedBeforeCustomData);
      }

      const redactedBeforeToolEnd = refreshRedaction();
      try {
        emitFunctionToolEnd(
          runner,
          state._context,
          agent,
          toolRun.tool,
          stringResult,
          toolRun.toolCall,
          refreshRedaction,
        );
      } catch (hookError) {
        throwIfRedactionPromoted(redactedBeforeToolEnd);
        throw hookError;
      }
      throwIfRedactionPromoted(redactedBeforeToolEnd);

      if (span && runner.config.traceIncludeSensitiveData) {
        span.spanData.output = stringResult;
      }

      const functionResult: FunctionToolResult<TContext> = {
        type: 'function_output' as const,
        tool: toolRun.tool,
        output: toolOutput,
        runItem: new RunToolCallOutputItem(
          rawItem,
          agent,
          toolOutput,
          customData,
        ),
      };

      const nestedRunResult = consumeAgentToolRunResult(toolRun.toolCall) as
        RunResult<TContext, Agent<TContext, any>> | undefined;
      if (nestedRunResult) {
        functionResult.agentRunResult = nestedRunResult;
        const nestedInterruptions = nestedRunResult.interruptions;
        if (nestedInterruptions.length > 0) {
          functionResult.interruptions = nestedInterruptions;
          const nestedRunStateJson = nestedRunResult.state.toJSON();
          const [stateKey, ...aliases] =
            stateKeys.length > 0 ? stateKeys : [toolName];
          state.setPendingAgentToolRun(
            stateKey,
            toolRun.toolCall.callId,
            JSON.stringify(nestedRunStateJson),
            aliases,
          );
        } else {
          for (const stateKey of stateKeys) {
            state.clearPendingAgentToolRun(stateKey, toolRun.toolCall.callId);
          }
        }
      }

      return functionResult;
    } catch (error) {
      const redacted = refreshRedaction();
      const errorResult = redacted
        ? REDACTED_TOOL_ERROR_MESSAGE
        : String(error);
      span?.setError({
        message: 'Error running tool',
        data: {
          tool_name: traceToolName,
          error: errorResult,
        },
      });

      try {
        emitFunctionToolEnd(
          runner,
          state._context,
          agent,
          toolRun.tool,
          errorResult,
          toolRun.toolCall,
          refreshRedaction,
        );
      } catch (hookError) {
        if (refreshRedaction() && invalidInputFailure) {
          throw invalidInputFailure.error;
        }
        throw hookError;
      }

      if (
        refreshRedaction() &&
        invalidInputFailure &&
        !isToolTimeoutError(error) &&
        error !== preservedLifecycleError
      ) {
        throw invalidInputFailure.error;
      }
      throw error;
    }
  });
}

/**
 * @internal
 */
// Internal helper: dispatch a computer action and return a screenshot (sync/async)
async function _runComputerActionAndScreenshot(
  computer: Computer,
  toolCall: protocol.ComputerUseCallItem,
  runContext: RunContext,
): Promise<string> {
  for (const action of getComputerToolActions(toolCall)) {
    switch (action.type) {
      case 'click':
        await computer.click(action.x, action.y, action.button, runContext);
        break;
      case 'double_click':
        await computer.doubleClick(action.x, action.y, runContext);
        break;
      case 'drag':
        await computer.drag(
          action.path.map((p: any) => [p.x, p.y]),
          runContext,
        );
        break;
      case 'keypress':
        await computer.keypress(action.keys, runContext);
        break;
      case 'move':
        await computer.move(action.x, action.y, runContext);
        break;
      case 'screenshot':
        await computer.screenshot(runContext);
        break;
      case 'scroll':
        await computer.scroll(
          action.x,
          action.y,
          action.scroll_x,
          action.scroll_y,
          runContext,
        );
        break;
      case 'type':
        await computer.type(action.text, runContext);
        break;
      case 'wait':
        await computer.wait(runContext);
        break;
      default:
        action satisfies never;
        break;
    }
  }

  if (typeof computer.screenshot === 'function') {
    const screenshot = await computer.screenshot(runContext);
    if (typeof screenshot !== 'undefined') {
      return screenshot;
    }
  }

  throw new Error('Computer does not implement screenshot()');
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.toString();
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function getTraceToolError(
  traceIncludeSensitiveData: boolean,
  errorMessage: string,
): string {
  return traceIncludeSensitiveData ? errorMessage : REDACTED_TOOL_ERROR_MESSAGE;
}

async function withToolFunctionSpan<T>(
  runner: Runner,
  toolName: string,
  fn: (span?: Span<FunctionSpanData>) => Promise<T>,
  parent?: Span<any>,
): Promise<T> {
  if (runner.config.tracingDisabled || (!getCurrentTrace() && !parent)) {
    return fn();
  }

  return withFunctionSpan(
    async (span) => fn(span),
    {
      data: {
        name: toolName,
      },
    },
    parent,
  );
}

async function withRunStateToolFunctionSpan<TContext, T>(
  deps: FunctionToolCallDeps<TContext>,
  toolName: string,
  fn: (span?: Span<FunctionSpanData>) => Promise<T>,
): Promise<T> {
  return withToolFunctionSpan(
    deps.runner,
    toolName,
    fn,
    getRunStateTurnSpanParent(deps.state) ?? deps.state._currentAgentSpan,
  );
}

type ApprovalResolution = 'approved' | 'rejected' | 'pending';

type LocalApprovalDecision = {
  approve?: boolean;
  reason?: string;
};

async function resolveToolApproval(options: {
  runContext: RunContext;
  toolName: string;
  callId: string;
  approvalItem: RunToolApprovalItem;
  needsApproval: () => Promise<boolean>;
  onApproval?:
    | ((
        runContext: RunContext,
        approvalItem: RunToolApprovalItem,
      ) => Promise<LocalApprovalDecision>)
    | undefined;
}): Promise<ApprovalResolution> {
  const {
    runContext,
    toolName,
    callId,
    approvalItem,
    needsApproval,
    onApproval,
  } = options;

  const existingApproval = runContext.isToolApproved({
    toolName,
    callId,
    functionTool: false,
  });

  if (existingApproval === true) {
    return 'approved';
  }
  if (existingApproval === false) {
    return 'rejected';
  }

  if (!(await needsApproval())) {
    return 'approved';
  }

  if (onApproval) {
    const decision = await onApproval(runContext, approvalItem);
    if (decision.approve === true) {
      runContext.approveTool(approvalItem);
    } else if (decision.approve === false) {
      const reason =
        typeof decision.reason === 'string' && decision.reason.length > 0
          ? decision.reason
          : undefined;
      runContext.rejectTool(
        approvalItem,
        reason === undefined ? undefined : { message: reason },
      );
    }
  }

  const approval = runContext.isToolApproved({
    toolName,
    callId,
    functionTool: false,
  });

  if (approval === true) {
    return 'approved';
  }
  if (approval === false) {
    return 'rejected';
  }
  return 'pending';
}

type ApprovalDecisionResult =
  { status: 'approved' } | { status: 'pending' | 'rejected'; item: RunItem };

async function handleToolApprovalDecision(options: {
  runContext: RunContext;
  toolName: string;
  callId: string;
  approvalItem: RunToolApprovalItem;
  needsApproval: () => Promise<boolean>;
  onApproval?:
    | ((
        runContext: RunContext,
        approvalItem: RunToolApprovalItem,
      ) => Promise<LocalApprovalDecision>)
    | undefined;
  buildRejectionItem: () => Promise<RunItem> | RunItem;
}): Promise<ApprovalDecisionResult> {
  const {
    runContext,
    toolName,
    callId,
    approvalItem,
    needsApproval,
    onApproval,
    buildRejectionItem,
  } = options;

  const approvalState = await resolveToolApproval({
    runContext,
    toolName,
    callId,
    approvalItem,
    needsApproval,
    onApproval,
  });

  if (approvalState === 'rejected') {
    return { status: 'rejected', item: await buildRejectionItem() };
  }
  if (approvalState === 'pending') {
    return { status: 'pending', item: approvalItem };
  }
  return { status: 'approved' };
}

function emitToolStart(
  runner: Runner,
  runContext: RunContext,
  agent: Agent<any, any>,
  tool: Tool<any>,
  toolCall: protocol.ToolCallItem,
): void {
  runner.emit('agent_tool_start', runContext, agent, tool, { toolCall });
  if (typeof agent.emit === 'function') {
    agent.emit('agent_tool_start', runContext, tool, { toolCall });
  }
}

function emitToolEnd(
  runner: Runner,
  runContext: RunContext,
  agent: Agent<any, any>,
  tool: Tool<any>,
  output: string,
  toolCall: protocol.ToolCallItem,
): void {
  runner.emit('agent_tool_end', runContext, agent, tool, output, { toolCall });
  if (typeof agent.emit === 'function') {
    agent.emit('agent_tool_end', runContext, tool, output, { toolCall });
  }
}

function emitFunctionToolStart(
  runner: Runner,
  runContext: RunContext,
  agent: Agent<any, any>,
  tool: FunctionTool<any, any, any>,
  toolCall: protocol.FunctionCallItem,
  refreshRedaction: () => boolean,
): void {
  runner.emit('agent_tool_start', runContext, agent, tool, {
    toolCall: getFunctionToolCallbackToolCall(toolCall, refreshRedaction()),
  });
  if (typeof agent.emit === 'function') {
    agent.emit('agent_tool_start', runContext, tool, {
      toolCall: getFunctionToolCallbackToolCall(toolCall, refreshRedaction()),
    });
  }
}

function emitFunctionToolEnd(
  runner: Runner,
  runContext: RunContext,
  agent: Agent<any, any>,
  tool: FunctionTool<any, any, any>,
  output: string,
  toolCall: protocol.FunctionCallItem,
  refreshRedaction: () => boolean,
): void {
  const redactedBeforeRunnerHook = refreshRedaction();
  runner.emit('agent_tool_end', runContext, agent, tool, output, {
    toolCall: getFunctionToolCallbackToolCall(
      toolCall,
      redactedBeforeRunnerHook,
    ),
  });
  if (typeof agent.emit === 'function') {
    const redactedBeforeAgentHook = refreshRedaction();
    agent.emit(
      'agent_tool_end',
      runContext,
      tool,
      !redactedBeforeRunnerHook && redactedBeforeAgentHook
        ? REDACTED_TOOL_ERROR_MESSAGE
        : output,
      {
        toolCall: getFunctionToolCallbackToolCall(
          toolCall,
          redactedBeforeAgentHook,
        ),
      },
    );
  }
}

function getToolCallKey(toolCall: protocol.ToolCallItem): string | undefined {
  if ('callId' in toolCall && typeof toolCall.callId === 'string') {
    return toolCall.callId;
  }
  if ('id' in toolCall && typeof toolCall.id === 'string') {
    return toolCall.id;
  }
  return undefined;
}

export async function executeShellActions(
  agent: Agent<any, any>,
  actions: ToolRunShell[],
  runner: Runner,
  runContext: RunContext,
  customLogger: Logger | undefined = undefined,
  toolErrorFormatter?: ToolErrorFormatter,
): Promise<RunItem[]> {
  const _logger = customLogger ?? logger;
  const results: RunItem[] = [];

  for (const action of actions) {
    const shellTool = action.shell;
    const toolCall = action.toolCall;
    const toolCallKey = getToolCallKey(toolCall) ?? toolCall.callId;
    if (!shellTool.shell) {
      _logger.warn(
        `Skipping shell action for tool "${shellTool.name}" because no local shell implementation is configured.`,
      );
      continue;
    }
    const approvalItem = new RunToolApprovalItem(
      toolCall,
      agent,
      shellTool.name,
    );
    const approvalDecision = await handleToolApprovalDecision({
      runContext,
      toolName: shellTool.name,
      callId: toolCallKey,
      approvalItem,
      needsApproval: () =>
        shellTool.needsApproval(runContext, toolCall.action, toolCallKey),
      onApproval: shellTool.onApproval,
      buildRejectionItem: async () => {
        const response = await resolveApprovalRejectionMessage({
          runContext,
          toolType: 'shell',
          toolName: shellTool.name,
          callId: toolCallKey,
          toolErrorFormatter,
        });
        const rejectionOutput: protocol.ShellCallOutputContent = {
          stdout: '',
          stderr: response,
          outcome: { type: 'exit', exitCode: null },
        };
        return new RunToolCallOutputItem(
          {
            type: 'shell_call_output',
            callId: toolCallKey,
            output: [rejectionOutput],
            ...(toolCall.caller ? { caller: toolCall.caller } : {}),
          },
          agent,
          response,
        );
      },
    });

    if (approvalDecision.status !== 'approved') {
      results.push(approvalDecision.item);
      continue;
    }

    const shellItem = await withToolFunctionSpan(
      runner,
      shellTool.name,
      async (span) => {
        if (span && runner.config.traceIncludeSensitiveData) {
          span.spanData.input = JSON.stringify(toolCall.action);
        }

        emitToolStart(runner, runContext, agent, shellTool, toolCall);

        let shellOutputs: ShellResult['output'] | undefined;
        const providerMeta: Record<string, unknown> = {};
        let maxOutputLength: number | undefined;

        try {
          const shellResult = await shellTool.shell.run(toolCall.action);
          shellOutputs = shellResult.output ?? [];

          if (shellResult.providerData) {
            Object.assign(providerMeta, shellResult.providerData);
          }

          if (typeof shellResult.maxOutputLength === 'number') {
            maxOutputLength = shellResult.maxOutputLength;
          }
        } catch (err) {
          const errorText = toErrorMessage(err);
          const traceError = getTraceToolError(
            runner.config.traceIncludeSensitiveData,
            errorText,
          );
          shellOutputs = [
            {
              stdout: '',
              stderr: errorText,
              outcome: { type: 'exit', exitCode: null },
            },
          ];
          span?.setError({
            message: 'Error running tool',
            data: {
              tool_name: shellTool.name,
              error: traceError,
            },
          });
          logToolActionError(_logger, 'Failed to execute shell action:', err);
        }

        shellOutputs = shellOutputs ?? [];
        const output = JSON.stringify(shellOutputs);
        emitToolEnd(runner, runContext, agent, shellTool, output, toolCall);

        if (span && runner.config.traceIncludeSensitiveData) {
          span.spanData.output = output;
        }

        const rawItem: protocol.ShellCallResultItem = {
          type: 'shell_call_output',
          callId: toolCallKey,
          output: shellOutputs ?? [],
          ...(toolCall.caller ? { caller: toolCall.caller } : {}),
        };

        if (typeof maxOutputLength === 'number') {
          rawItem.maxOutputLength = maxOutputLength;
        }

        if (Object.keys(providerMeta).length > 0) {
          rawItem.providerData = providerMeta;
        }

        return new RunToolCallOutputItem(rawItem, agent, rawItem.output);
      },
    );

    results.push(shellItem);
  }

  return results;
}

export async function executeApplyPatchOperations(
  agent: Agent<any, any>,
  actions: ToolRunApplyPatch[],
  runner: Runner,
  runContext: RunContext,
  customLogger: Logger | undefined = undefined,
  toolErrorFormatter?: ToolErrorFormatter,
): Promise<RunItem[]> {
  const _logger = customLogger ?? logger;
  const results: RunItem[] = [];

  for (const action of actions) {
    const applyPatchTool = action.applyPatch;
    const toolCall = action.toolCall;
    const toolCallKey = getToolCallKey(toolCall) ?? toolCall.callId;
    const editorContext = { runContext };
    const approvalItem = new RunToolApprovalItem(
      toolCall,
      agent,
      applyPatchTool.name,
    );
    const approvalDecision = await handleToolApprovalDecision({
      runContext,
      toolName: applyPatchTool.name,
      callId: toolCallKey,
      approvalItem,
      needsApproval: () =>
        applyPatchTool.needsApproval(
          runContext,
          toolCall.operation,
          toolCallKey,
        ),
      onApproval: applyPatchTool.onApproval,
      buildRejectionItem: async () => {
        const response = await resolveApprovalRejectionMessage({
          runContext,
          toolType: 'apply_patch',
          toolName: applyPatchTool.name,
          callId: toolCallKey,
          toolErrorFormatter,
        });
        return new RunToolCallOutputItem(
          {
            type: 'apply_patch_call_output',
            callId: toolCallKey,
            status: 'failed',
            output: response,
            ...(toolCall.caller ? { caller: toolCall.caller } : {}),
          },
          agent,
          response,
        );
      },
    });

    if (approvalDecision.status !== 'approved') {
      results.push(approvalDecision.item);
      continue;
    }

    const applyPatchItem = await withToolFunctionSpan(
      runner,
      applyPatchTool.name,
      async (span) => {
        if (span && runner.config.traceIncludeSensitiveData) {
          span.spanData.input = JSON.stringify(toolCall.operation);
        }

        emitToolStart(runner, runContext, agent, applyPatchTool, toolCall);

        let status: 'completed' | 'failed' = 'completed';
        let output = '';

        try {
          let result: ApplyPatchResult | void;
          switch (toolCall.operation.type) {
            case 'create_file':
              result = await applyPatchTool.editor.createFile(
                toolCall.operation,
                editorContext,
              );
              break;
            case 'update_file':
              result = await applyPatchTool.editor.updateFile(
                toolCall.operation,
                editorContext,
              );
              break;
            case 'delete_file':
              result = await applyPatchTool.editor.deleteFile(
                toolCall.operation,
                editorContext,
              );
              break;
            default:
              throw new Error('Unsupported apply_patch operation');
          }

          if (result && typeof result.status === 'string') {
            status = result.status;
          }

          if (result && typeof result.output === 'string') {
            output = result.output;
          }
        } catch (err) {
          status = 'failed';
          output = toErrorMessage(err);
          const traceError = getTraceToolError(
            runner.config.traceIncludeSensitiveData,
            output,
          );
          span?.setError({
            message: 'Error running tool',
            data: {
              tool_name: applyPatchTool.name,
              error: traceError,
            },
          });
          logToolActionError(
            _logger,
            'Failed to execute apply_patch operation:',
            err,
          );
        }

        const rawItem: protocol.ApplyPatchCallResultItem = {
          type: 'apply_patch_call_output',
          callId: toolCallKey,
          status,
          ...(toolCall.caller ? { caller: toolCall.caller } : {}),
        };

        if (output) {
          rawItem.output = output;
        }

        const customData = await maybeExtractToolOutputCustomData(
          applyPatchTool.customDataExtractor,
          {
            runContext,
            tool: applyPatchTool,
            operation: cloneForCustomDataContext(toolCall.operation),
            output,
            status,
            rawItem: cloneForCustomDataContext(rawItem),
          } satisfies ApplyPatchToolCustomDataContext,
        );

        emitToolEnd(
          runner,
          runContext,
          agent,
          applyPatchTool,
          output,
          toolCall,
        );

        if (span && runner.config.traceIncludeSensitiveData) {
          span.spanData.output = output;
        }

        return new RunToolCallOutputItem(rawItem, agent, output, customData);
      },
    );

    results.push(applyPatchItem);
  }

  return results;
}

/**
 * @internal
 * Executes any computer-use actions emitted by the model and returns the resulting items so
 * the run history reflects the computer session.
 */
export async function executeComputerActions(
  agent: Agent<any, any>,
  actions: ToolRunComputer[],
  runner: Runner,
  runContext: RunContext,
  customLogger: Logger | undefined = undefined,
  toolErrorFormatter?: ToolErrorFormatter,
  signal?: AbortSignal,
): Promise<RunItem[]> {
  const _logger = customLogger ?? logger;
  const results: RunItem[] = [];
  for (const action of actions) {
    const toolCall = action.toolCall;
    const computerTool = action.computer;
    if (signal?.aborted) {
      const rawItem = buildComputerAbortResult(toolCall);
      results.push(new RunToolCallOutputItem(rawItem, agent, 'aborted'));
      continue;
    }
    const computerActions = getComputerToolActions(toolCall);
    let cachedRejectionMessage: string | undefined;
    const getRejectionMessage = async () => {
      if (typeof cachedRejectionMessage === 'string') {
        return cachedRejectionMessage;
      }
      cachedRejectionMessage = await resolveApprovalRejectionMessage({
        runContext,
        toolType: 'computer',
        toolName: computerTool.name,
        callId: toolCall.callId,
        toolErrorFormatter,
      });
      return cachedRejectionMessage;
    };
    const pendingSafetyChecks = getPendingSafetyChecks(toolCall);
    const approvalItem = new RunToolApprovalItem(
      toolCall,
      agent,
      computerTool.name,
    );
    const needsApprovalCandidate = (computerTool as { needsApproval?: unknown })
      .needsApproval;
    const approvalDecision = await handleToolApprovalDecision({
      runContext,
      toolName: computerTool.name,
      callId: toolCall.callId,
      approvalItem,
      needsApproval: async () =>
        typeof needsApprovalCandidate === 'function'
          ? (
              await Promise.all(
                computerActions.map((computerAction) =>
                  (
                    needsApprovalCandidate as (
                      runContext: RunContext,
                      action: protocol.ComputerAction,
                      callId?: string,
                    ) => Promise<boolean>
                  )(runContext, computerAction, toolCall.callId),
                ),
              )
            ).some(Boolean)
          : typeof needsApprovalCandidate === 'boolean'
            ? needsApprovalCandidate
            : false,
      buildRejectionItem: async () => {
        const rejectionMessage = await getRejectionMessage();
        const rejectionOutput: protocol.ComputerToolOutput = {
          type: 'computer_screenshot',
          data: COMPUTER_FALLBACK_SCREENSHOT_DATA_URL,
          providerData: {
            approvalStatus: 'rejected',
            message: rejectionMessage,
          },
        };
        const rawItem: protocol.ComputerCallResultItem = {
          type: 'computer_call_result',
          callId: toolCall.callId,
          output: rejectionOutput,
        };
        return new RunToolCallOutputItem(
          rawItem,
          agent,
          COMPUTER_FALLBACK_SCREENSHOT_DATA_URL,
        );
      },
    });

    if (approvalDecision.status === 'rejected') {
      const rejectionMessage = await getRejectionMessage();
      results.push(approvalDecision.item);
      results.push(
        new RunMessageOutputItem(assistant(rejectionMessage), agent),
      );
      continue;
    }

    if (approvalDecision.status === 'pending') {
      results.push(approvalDecision.item);
      continue;
    }

    const computerItem = await withToolFunctionSpan(
      runner,
      COMPUTER_TRACE_NAME,
      async (span) => {
        if (span && runner.config.traceIncludeSensitiveData) {
          const traceInput = getComputerTraceInputPayload(toolCall);
          span.spanData.input =
            typeof traceInput === 'undefined' ? '' : JSON.stringify(traceInput);
        }

        // Hooks: on_tool_start (global + agent)
        emitToolStart(runner, runContext, agent, computerTool, toolCall);

        const acknowledgedSafetyChecks =
          pendingSafetyChecks && pendingSafetyChecks.length > 0
            ? await resolveSafetyCheckAcknowledgements({
                runContext,
                toolCall,
                pendingSafetyChecks,
                onSafetyCheck: computerTool.onSafetyCheck,
              })
            : undefined;

        // Run the action and get screenshot.
        let output: string;
        try {
          const computer = await resolveComputer({
            tool: computerTool,
            runContext,
          });
          output = await _runComputerActionAndScreenshot(
            computer,
            toolCall,
            runContext,
          );
        } catch (err) {
          logToolActionError(
            _logger,
            'Failed to execute computer action:',
            err,
          );
          output = '';
          const errorText = toErrorMessage(err);
          const traceError = getTraceToolError(
            runner.config.traceIncludeSensitiveData,
            errorText,
          );
          span?.setError({
            message: 'Error running tool',
            data: {
              tool_name: COMPUTER_TRACE_NAME,
              error: traceError,
            },
          });
        }

        // Return the screenshot as a data URL when available; fall back to an empty string on failures.
        const imageUrl = output ? `data:image/png;base64,${output}` : '';
        const rawItem: protocol.ComputerCallResultItem = {
          type: 'computer_call_result',
          callId: toolCall.callId,
          output: { type: 'computer_screenshot', data: imageUrl },
        };
        if (acknowledgedSafetyChecks && acknowledgedSafetyChecks.length > 0) {
          rawItem.providerData = {
            acknowledgedSafetyChecks,
          };
        }
        const customData = await maybeExtractToolOutputCustomData(
          computerTool.customDataExtractor,
          {
            runContext,
            tool: computerTool,
            toolCall: cloneForCustomDataContext(toolCall),
            output: imageUrl,
            rawItem: cloneForCustomDataContext(rawItem),
          } satisfies ComputerToolCustomDataContext,
        );

        // Hooks: on_tool_end (global + agent)
        emitToolEnd(runner, runContext, agent, computerTool, output, toolCall);

        if (span && runner.config.traceIncludeSensitiveData) {
          span.spanData.output = imageUrl;
        }

        return new RunToolCallOutputItem(rawItem, agent, imageUrl, customData);
      },
    );

    results.push(computerItem);
  }
  return results;
}

/**
 * @internal
 * Drives handoff calls by invoking the downstream agent and capturing any generated items so
 * the current agent can continue with the new context.
 */
export async function executeHandoffCalls<
  TContext,
  TOutput extends AgentOutputType,
>(
  agent: Agent<TContext, TOutput>,
  originalInput: string | AgentInputItem[],
  preStepItems: RunItem[],
  newStepItems: RunItem[],
  newResponse: ModelResponse,
  runHandoffs: ToolRunHandoff[],
  runner: Runner,
  runContext: RunContext<TContext>,
  parent?: Span<any>,
): Promise<import('./steps').SingleStepResult> {
  newStepItems = [...newStepItems];

  if (runHandoffs.length === 0) {
    logger.warn(
      'Incorrectly called executeHandoffCalls with no handoffs. This should not happen. Moving on.',
    );
    return new SingleStepResult(
      originalInput,
      newResponse,
      preStepItems,
      newStepItems,
      { type: 'next_step_run_again' },
    );
  }

  if (runHandoffs.length > 1) {
    const ignoredCallIds = new Set(
      runHandoffs.slice(1).map((handoff) => handoff.toolCall.callId),
    );
    // Drop ignored handoff requests from the step so they never persist to history.
    newStepItems = newStepItems.filter(
      (item) =>
        !(
          item instanceof RunHandoffCallItem &&
          ignoredCallIds.has(item.rawItem.callId)
        ),
    );
  }

  const actualHandoff = runHandoffs[0];

  return withHandoffSpan(
    async (handoffSpan) => {
      const handoff = actualHandoff.handoff;
      const inputFilter =
        handoff.inputFilter ?? runner.config.handoffInputFilter;
      if (inputFilter != null && typeof inputFilter !== 'function') {
        throw Object.assign(
          new UserError('Invalid handoff input filter: not callable'),
          {
            data: {
              details: 'not callable',
            },
          },
        );
      }

      const newAgent = await handoff.onInvokeHandoff(
        runContext,
        actualHandoff.toolCall.arguments,
      );

      handoffSpan.spanData.to_agent = newAgent.name;

      if (runHandoffs.length > 1) {
        const requestedAgents = runHandoffs.map((h) => h.handoff.agentName);
        handoffSpan.setError({
          message: 'Multiple handoffs requested',
          data: {
            requested_agents: requestedAgents,
          },
        });
      }

      newStepItems.push(
        new RunHandoffOutputItem(
          getToolCallOutputItem(
            actualHandoff.toolCall,
            getTransferMessage(newAgent),
          ),
          agent,
          newAgent,
        ),
      );

      runner.emit('agent_handoff', runContext, agent, newAgent);
      agent.emit('agent_handoff', runContext, newAgent);

      if (inputFilter != null) {
        logger.debug('Filtering inputs for handoff');

        const handoffInputData: HandoffInputData = {
          inputHistory: Array.isArray(originalInput)
            ? [...originalInput]
            : originalInput,
          preHandoffItems: [...preStepItems],
          newItems: [...newStepItems],
          runContext,
        };

        const filtered = inputFilter(handoffInputData);

        originalInput = filtered.inputHistory;
        preStepItems = filtered.preHandoffItems;
        newStepItems = filtered.newItems;
      }

      return new SingleStepResult(
        originalInput,
        newResponse,
        preStepItems,
        newStepItems,
        { type: 'next_step_handoff', newAgent },
      );
    },
    {
      data: {
        from_agent: agent.name,
      },
    },
    parent,
  );
}

const NOT_FINAL_OUTPUT: ToolsToFinalOutputResult = {
  isFinalOutput: false,
  isInterrupted: undefined,
};

/**
 * Collects approval interruptions from tool execution results and any additional
 * RunItems (e.g., shell/apply_patch approval placeholders).
 */
export function collectInterruptions<TContext = UnknownContext>(
  toolResults: FunctionToolResult<TContext>[],
  additionalItems: RunItem[] = [],
): RunToolApprovalItem[] {
  const interruptions: RunToolApprovalItem[] = [];

  for (const item of additionalItems) {
    if (item instanceof RunToolApprovalItem) {
      interruptions.push(item);
    }
  }

  for (const result of toolResults) {
    if (result.runItem instanceof RunToolApprovalItem) {
      interruptions.push(result.runItem);
    }

    if (result.type === 'function_output') {
      if (Array.isArray(result.interruptions)) {
        interruptions.push(...result.interruptions);
      } else if (result.agentRunResult) {
        const nestedInterruptions = result.agentRunResult.interruptions;
        if (nestedInterruptions.length > 0) {
          interruptions.push(...nestedInterruptions);
        }
      }
    }
  }

  return interruptions;
}

/**
 * @internal
 * Determines whether tool executions produced a final agent output, triggered an interruption,
 * or whether the agent loop should continue collecting more responses.
 */
export async function checkForFinalOutputFromTools<
  TContext,
  TOutput extends AgentOutputType,
>(
  agent: Agent<TContext, TOutput>,
  toolResults: FunctionToolResult<TContext>[],
  state: RunState<TContext, Agent<TContext, TOutput>>,
  additionalInterruptions: RunItem[] = [],
): Promise<ToolsToFinalOutputResult> {
  if (toolResults.length === 0 && additionalInterruptions.length === 0) {
    return NOT_FINAL_OUTPUT;
  }

  const interruptions = collectInterruptions(
    toolResults,
    additionalInterruptions,
  );

  if (interruptions.length > 0) {
    return {
      isFinalOutput: false,
      isInterrupted: true,
      interruptions,
    };
  }

  const finalizationResults = toolResults.filter((result) => {
    const rawItem = result.runItem.rawItem;
    return !(
      rawItem &&
      'caller' in rawItem &&
      rawItem.caller?.type === 'program'
    );
  });

  const isIncompleteFunctionResult = (result: FunctionToolResult<TContext>) => {
    const rawItem = result.runItem.rawItem;
    return (
      result.type === 'function_output' &&
      rawItem?.type === 'function_call_result' &&
      rawItem.status === 'incomplete'
    );
  };
  if (
    finalizationResults.length === 0 ||
    finalizationResults.some(isIncompleteFunctionResult)
  ) {
    return NOT_FINAL_OUTPUT;
  }

  if (agent.toolUseBehavior === 'run_llm_again') {
    return NOT_FINAL_OUTPUT;
  }

  const firstToolResult = finalizationResults[0];
  if (agent.toolUseBehavior === 'stop_on_first_tool') {
    if (firstToolResult?.type === 'function_output') {
      const stringOutput = toSmartString(firstToolResult.output);
      return {
        isFinalOutput: true,
        isInterrupted: undefined,
        finalOutput: stringOutput,
      };
    }
    return NOT_FINAL_OUTPUT;
  }

  const toolUseBehavior = agent.toolUseBehavior;
  if (typeof toolUseBehavior === 'object') {
    const stoppingTool = finalizationResults.find((r) => {
      return toolUseBehavior.stopAtToolNames.some((toolName) =>
        matchesFunctionToolName(r.tool, toolName),
      );
    });
    if (stoppingTool?.type === 'function_output') {
      const stringOutput = toSmartString(stoppingTool.output);
      return {
        isFinalOutput: true,
        isInterrupted: undefined,
        finalOutput: stringOutput,
      };
    }
    return NOT_FINAL_OUTPUT;
  }

  if (typeof toolUseBehavior === 'function') {
    return toolUseBehavior(
      state._context,
      finalizationResults as FunctionToolResult[],
    );
  }

  throw new UserError(`Invalid toolUseBehavior: ${toolUseBehavior}`, state);
}

function normalizeSafetyChecks(
  checks: unknown,
): ComputerSafetyCheck[] | undefined {
  if (!Array.isArray(checks)) {
    return undefined;
  }
  const normalized: ComputerSafetyCheck[] = [];
  for (const entry of checks) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = entry.id;
    const code = entry.code;
    if (!isNonEmptyString(id) || !isNonEmptyString(code)) {
      continue;
    }
    const message =
      'message' in entry && isNonEmptyString(entry.message)
        ? entry.message
        : undefined;
    const normalizedEntry: ComputerSafetyCheck = { ...entry, id, code };
    if (message) {
      normalizedEntry.message = message;
    }
    normalized.push(normalizedEntry);
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSafetyCheckResult(
  result: ComputerSafetyCheckResult,
): ComputerSafetyCheck[] | undefined {
  if (!result) {
    return undefined;
  }
  if (!isRecord(result)) {
    return undefined;
  }
  if ('acknowledgedSafetyChecks' in result) {
    return normalizeSafetyChecks(result.acknowledgedSafetyChecks);
  }
  if ('acknowledged_safety_checks' in result) {
    return normalizeSafetyChecks(result.acknowledged_safety_checks);
  }
  return undefined;
}

async function resolveSafetyCheckAcknowledgements(options: {
  runContext: RunContext;
  toolCall: protocol.ComputerUseCallItem;
  pendingSafetyChecks: ComputerSafetyCheck[];
  onSafetyCheck?: (args: {
    runContext: RunContext;
    pendingSafetyChecks: ComputerSafetyCheck[];
    toolCall: protocol.ComputerUseCallItem;
  }) => Promise<ComputerSafetyCheckResult>;
}): Promise<ComputerSafetyCheck[] | undefined> {
  const { runContext, toolCall, pendingSafetyChecks, onSafetyCheck } = options;
  if (!onSafetyCheck) {
    return undefined;
  }
  const result = await onSafetyCheck({
    runContext,
    pendingSafetyChecks,
    toolCall,
  });
  if (result === true) {
    return pendingSafetyChecks;
  }
  if (result === false) {
    return undefined;
  }
  return normalizeSafetyCheckResult(result);
}

function getPendingSafetyChecks(
  toolCall: protocol.ComputerUseCallItem,
): ComputerSafetyCheck[] | undefined {
  const providerData = toolCall.providerData;
  if (!isRecord(providerData)) {
    return undefined;
  }
  if ('pending_safety_checks' in providerData) {
    return normalizeSafetyChecks(providerData.pending_safety_checks);
  }
  if ('pendingSafetyChecks' in providerData) {
    return normalizeSafetyChecks(providerData.pendingSafetyChecks);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
