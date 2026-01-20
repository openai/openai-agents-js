import { FunctionCallResultItem } from '../types/protocol';
import type {
  ToolCallStructuredOutput,
  ToolOutputFileContent,
  ToolOutputImage,
  ToolOutputText,
} from '../types/protocol';
import {
  Agent,
  AgentOutputType,
  ToolsToFinalOutputResult,
  consumeAgentToolRunResult,
} from '../agent';
import { ToolCallError, UserError } from '../errors';
import { getTransferMessage, HandoffInputData } from '../handoff';
import {
  RunHandoffOutputItem,
  RunItem,
  RunToolApprovalItem,
  RunToolCallOutputItem,
} from '../items';
import logger, { Logger } from '../logger';
import { ModelResponse } from '../model';
import { FunctionToolResult, resolveComputer, Tool } from '../tool';
import type { ShellResult } from '../shell';
import { RunContext } from '../runContext';
import type { RunResult } from '../result';
import { encodeUint8ArrayToBase64 } from '../utils/base64';
import { toSmartString } from '../utils/smartString';
import { isZodObject } from '../utils';
import { withFunctionSpan, withHandoffSpan } from '../tracing/createSpans';
import * as protocol from '../types/protocol';
import { Computer } from '../computer';
import type { ApplyPatchResult } from '../editor';
import { RunState } from '../runState';
import type { AgentInputItem, UnknownContext } from '../types';
import type { Runner } from '../run';
import {
  runToolInputGuardrails,
  runToolOutputGuardrails,
} from '../utils/toolGuardrails';
import type {
  ToolRunApplyPatch,
  ToolRunComputer,
  ToolRunFunction,
  ToolRunHandoff,
  ToolRunShell,
} from './types';
import { SingleStepResult } from './steps';

type FunctionToolCallDeps<TContext = UnknownContext> = {
  agent: Agent<TContext, any>;
  runner: Runner;
  state: RunState<TContext, Agent<TContext, any>>;
};

const TOOL_APPROVAL_REJECTION_MESSAGE = 'Tool execution was not approved.';

type ParseToolArgumentsResult =
  | { success: true; args: any }
  | { success: false; error: Error };

/**
 * @internal
 * Normalizes tool outputs once so downstream code works with fully structured protocol items.
 * Doing this here keeps API surface stable even when providers add new shapes.
 */
export function getToolCallOutputItem(
  toolCall: protocol.FunctionCallItem,
  output: string | unknown,
): FunctionCallResultItem {
  const maybeStructuredOutputs = normalizeStructuredToolOutputs(output);

  if (maybeStructuredOutputs) {
    const structuredItems = maybeStructuredOutputs.map(
      convertStructuredToolOutputToInputItem,
    );

    return {
      type: 'function_call_result',
      name: toolCall.name,
      callId: toolCall.callId,
      status: 'completed',
      output: structuredItems,
    };
  }

  return {
    type: 'function_call_result',
    name: toolCall.name,
    callId: toolCall.callId,
    status: 'completed',
    output: {
      type: 'text',
      text: toSmartString(output),
    },
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
): Promise<FunctionToolResult<TContext>[]> {
  const deps: FunctionToolCallDeps<TContext> = { agent, runner, state };

  try {
    const results = await Promise.all(
      toolRuns.map(async (toolRun) => {
        const parseResult = parseToolArguments(toolRun);

        // Handle parse errors gracefully instead of crashing
        if (!parseResult.success) {
          return buildParseErrorResult(deps, toolRun, parseResult.error);
        }

        const approvalOutcome = await handleFunctionApproval(
          deps,
          toolRun,
          parseResult.args,
        );
        if (approvalOutcome !== 'approved') {
          return approvalOutcome;
        }
        return runApprovedFunctionTool(deps, toolRun);
      }),
    );
    return results;
  } catch (e: unknown) {
    throw new ToolCallError(
      `Failed to run function tools: ${e}`,
      e as Error,
      state,
    );
  }
}

function parseToolArguments<TContext>(
  toolRun: ToolRunFunction<TContext>,
): ParseToolArgumentsResult {
  try {
    let parsedArgs: any = toolRun.toolCall.arguments;
    if (toolRun.tool.parameters) {
      if (isZodObject(toolRun.tool.parameters)) {
        parsedArgs = toolRun.tool.parameters.parse(parsedArgs);
      } else {
        parsedArgs = JSON.parse(parsedArgs);
      }
    }
    return { success: true, args: parsedArgs };
  } catch (error) {
    logger.debug(
      `Failed to parse tool arguments for ${toolRun.tool.name}: ${error}`,
    );
    return { success: false, error: error as Error };
  }
}

function buildApprovalRequestResult<TContext>(
  deps: FunctionToolCallDeps<TContext>,
  toolRun: ToolRunFunction<TContext>,
): FunctionToolResult<TContext> {
  return {
    type: 'function_approval' as const,
    tool: toolRun.tool,
    runItem: new RunToolApprovalItem(toolRun.toolCall, deps.agent),
  };
}

function buildParseErrorResult<TContext>(
  deps: FunctionToolCallDeps<TContext>,
  toolRun: ToolRunFunction<TContext>,
  error: Error,
): FunctionToolResult<TContext> {
  const errorMessage = `An error occurred while parsing tool arguments. Please try again with valid JSON. Error: ${error.message}`;
  return {
    type: 'function_output',
    tool: toolRun.tool,
    output: errorMessage,
    runItem: new RunToolCallOutputItem(
      getToolCallOutputItem(toolRun.toolCall, errorMessage),
      deps.agent,
      errorMessage,
    ),
  };
}

async function buildApprovalRejectionResult<TContext>(
  deps: FunctionToolCallDeps<TContext>,
  toolRun: ToolRunFunction<TContext>,
): Promise<FunctionToolResult<TContext>> {
  const { agent } = deps;
  return withFunctionSpan(
    async (span) => {
      const response = 'Tool execution was not approved.';

      span.setError({
        message: response,
        data: {
          tool_name: toolRun.tool.name,
          error: `Tool execution for ${toolRun.toolCall.callId} was manually rejected by user.`,
        },
      });

      span.spanData.output = response;
      return {
        type: 'function_output' as const,
        tool: toolRun.tool,
        output: response,
        runItem: new RunToolCallOutputItem(
          getToolCallOutputItem(toolRun.toolCall, response),
          agent,
          response,
        ),
      };
    },
    {
      data: {
        name: toolRun.tool.name,
      },
    },
  );
}

async function handleFunctionApproval<TContext>(
  deps: FunctionToolCallDeps<TContext>,
  toolRun: ToolRunFunction<TContext>,
  parsedArgs: any,
): Promise<'approved' | FunctionToolResult<TContext>> {
  const { state } = deps;
  const needsApproval = await toolRun.tool.needsApproval(
    state._context,
    parsedArgs,
    toolRun.toolCall.callId,
  );

  if (!needsApproval) {
    return 'approved';
  }

  const approval = state._context.isToolApproved({
    toolName: toolRun.tool.name,
    callId: toolRun.toolCall.callId,
  });

  if (approval === false) {
    return await buildApprovalRejectionResult(deps, toolRun);
  }

  if (approval !== true) {
    return buildApprovalRequestResult(deps, toolRun);
  }

  return 'approved';
}

async function runApprovedFunctionTool<TContext>(
  deps: FunctionToolCallDeps<TContext>,
  toolRun: ToolRunFunction<TContext>,
): Promise<FunctionToolResult<TContext>> {
  const { agent, runner, state } = deps;
  return withFunctionSpan(
    async (span) => {
      if (runner.config.traceIncludeSensitiveData) {
        span.spanData.input = toolRun.toolCall.arguments;
      }

      try {
        const inputGuardrailResult = await runToolInputGuardrails({
          guardrails: toolRun.tool.inputGuardrails,
          context: state._context,
          agent,
          toolCall: toolRun.toolCall,
          onResult: (result) => {
            state._toolInputGuardrailResults.push(result);
          },
        });

        emitToolStart(
          runner,
          state._context,
          agent,
          toolRun.tool,
          toolRun.toolCall,
        );

        let toolOutput: unknown;
        if (inputGuardrailResult.type === 'reject') {
          toolOutput = inputGuardrailResult.message;
        } else {
          toolOutput = await toolRun.tool.invoke(
            state._context,
            toolRun.toolCall.arguments,
            { toolCall: toolRun.toolCall },
          );
          toolOutput = await runToolOutputGuardrails({
            guardrails: toolRun.tool.outputGuardrails,
            context: state._context,
            agent,
            toolCall: toolRun.toolCall,
            toolOutput,
            onResult: (result) => {
              state._toolOutputGuardrailResults.push(result);
            },
          });
        }
        const stringResult = toSmartString(toolOutput);

        emitToolEnd(
          runner,
          state._context,
          agent,
          toolRun.tool,
          stringResult,
          toolRun.toolCall,
        );

        if (runner.config.traceIncludeSensitiveData) {
          span.spanData.output = stringResult;
        }

        const functionResult: FunctionToolResult<TContext> = {
          type: 'function_output' as const,
          tool: toolRun.tool,
          output: toolOutput,
          runItem: new RunToolCallOutputItem(
            getToolCallOutputItem(toolRun.toolCall, toolOutput),
            agent,
            toolOutput,
          ),
        };

        const nestedRunResult = consumeAgentToolRunResult(toolRun.toolCall) as
          | RunResult<TContext, Agent<TContext, any>>
          | undefined;
        if (nestedRunResult) {
          functionResult.agentRunResult = nestedRunResult;
          const nestedInterruptions = nestedRunResult.interruptions;
          if (nestedInterruptions.length > 0) {
            functionResult.interruptions = nestedInterruptions;
          }
        }

        return functionResult;
      } catch (error) {
        span.setError({
          message: 'Error running tool',
          data: {
            tool_name: toolRun.tool.name,
            error: String(error),
          },
        });

        const errorResult = String(error);
        emitToolEnd(
          runner,
          state._context,
          agent,
          toolRun.tool,
          errorResult,
          toolRun.toolCall,
        );

        throw error;
      }
    },
    {
      data: {
        name: toolRun.tool.name,
      },
    },
  );
}

/**
 * @internal
 */
// Internal helper: dispatch a computer action and return a screenshot (sync/async)
async function _runComputerActionAndScreenshot(
  computer: Computer,
  toolCall: protocol.ComputerUseCallItem,
): Promise<string> {
  const action = toolCall.action;
  let screenshot: string | undefined;
  // Dispatch based on action type string (assume action.type exists)
  switch (action.type) {
    case 'click':
      await computer.click(action.x, action.y, action.button);
      break;
    case 'double_click':
      await computer.doubleClick(action.x, action.y);
      break;
    case 'drag':
      await computer.drag(action.path.map((p: any) => [p.x, p.y]));
      break;
    case 'keypress':
      await computer.keypress(action.keys);
      break;
    case 'move':
      await computer.move(action.x, action.y);
      break;
    case 'screenshot':
      screenshot = await computer.screenshot();
      break;
    case 'scroll':
      await computer.scroll(
        action.x,
        action.y,
        action.scroll_x,
        action.scroll_y,
      );
      break;
    case 'type':
      await computer.type(action.text);
      break;
    case 'wait':
      await computer.wait();
      break;
    default:
      action satisfies never; // ensures that we handle every action we know of
      // Unknown action, just take screenshot
      break;
  }
  if (typeof screenshot !== 'undefined') {
    return screenshot;
  }
  // Always return screenshot as base64 string
  if (typeof computer.screenshot === 'function') {
    screenshot = await computer.screenshot();
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

type ApprovalResolution = 'approved' | 'rejected' | 'pending';

async function resolveToolApproval(options: {
  runContext: RunContext;
  toolName: string;
  callId: string;
  approvalItem: RunToolApprovalItem;
  needsApproval: boolean;
  onApproval?:
    | ((
        runContext: RunContext,
        approvalItem: RunToolApprovalItem,
      ) => Promise<{ approve?: boolean }>)
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

  if (!needsApproval) {
    return 'approved';
  }

  if (onApproval) {
    const decision = await onApproval(runContext, approvalItem);
    if (decision.approve === true) {
      runContext.approveTool(approvalItem);
    } else if (decision.approve === false) {
      runContext.rejectTool(approvalItem);
    }
  }

  const approval = runContext.isToolApproved({
    toolName,
    callId,
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
  | { status: 'approved' }
  | { status: 'pending' | 'rejected'; item: RunItem };

async function handleToolApprovalDecision(options: {
  runContext: RunContext;
  toolName: string;
  callId: string;
  approvalItem: RunToolApprovalItem;
  needsApproval: boolean;
  onApproval?:
    | ((
        runContext: RunContext,
        approvalItem: RunToolApprovalItem,
      ) => Promise<{ approve?: boolean }>)
    | undefined;
  buildRejectionItem: () => RunItem;
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
    return { status: 'rejected', item: buildRejectionItem() };
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

export async function executeShellActions(
  agent: Agent<any, any>,
  actions: ToolRunShell[],
  runner: Runner,
  runContext: RunContext,
  customLogger: Logger | undefined = undefined,
): Promise<RunItem[]> {
  const _logger = customLogger ?? logger;
  const results: RunItem[] = [];

  for (const action of actions) {
    const shellTool = action.shell;
    const toolCall = action.toolCall;
    const approvalItem = new RunToolApprovalItem(
      toolCall,
      agent,
      shellTool.name,
    );
    const approvalDecision = await handleToolApprovalDecision({
      runContext,
      toolName: shellTool.name,
      callId: toolCall.callId,
      approvalItem,
      needsApproval: await shellTool.needsApproval(
        runContext,
        toolCall.action,
        toolCall.callId,
      ),
      onApproval: shellTool.onApproval,
      buildRejectionItem: () => {
        const response = TOOL_APPROVAL_REJECTION_MESSAGE;
        const rejectionOutput: protocol.ShellCallOutputContent = {
          stdout: '',
          stderr: response,
          outcome: { type: 'exit', exitCode: null },
        };
        return new RunToolCallOutputItem(
          {
            type: 'shell_call_output',
            callId: toolCall.callId,
            output: [rejectionOutput],
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
      shellOutputs = [
        {
          stdout: '',
          stderr: errorText,
          outcome: { type: 'exit', exitCode: null },
        },
      ];
      _logger.error('Failed to execute shell action:', err);
    }

    shellOutputs = shellOutputs ?? [];

    emitToolEnd(
      runner,
      runContext,
      agent,
      shellTool,
      JSON.stringify(shellOutputs),
      toolCall,
    );

    const rawItem: protocol.ShellCallResultItem = {
      type: 'shell_call_output',
      callId: toolCall.callId,
      output: shellOutputs ?? [],
    };

    if (typeof maxOutputLength === 'number') {
      rawItem.maxOutputLength = maxOutputLength;
    }

    if (Object.keys(providerMeta).length > 0) {
      rawItem.providerData = providerMeta;
    }

    results.push(new RunToolCallOutputItem(rawItem, agent, rawItem.output));
  }

  return results;
}

export async function executeApplyPatchOperations(
  agent: Agent<any, any>,
  actions: ToolRunApplyPatch[],
  runner: Runner,
  runContext: RunContext,
  customLogger: Logger | undefined = undefined,
): Promise<RunItem[]> {
  const _logger = customLogger ?? logger;
  const results: RunItem[] = [];

  for (const action of actions) {
    const applyPatchTool = action.applyPatch;
    const toolCall = action.toolCall;
    const approvalItem = new RunToolApprovalItem(
      toolCall,
      agent,
      applyPatchTool.name,
    );
    const approvalDecision = await handleToolApprovalDecision({
      runContext,
      toolName: applyPatchTool.name,
      callId: toolCall.callId,
      approvalItem,
      needsApproval: await applyPatchTool.needsApproval(
        runContext,
        toolCall.operation,
        toolCall.callId,
      ),
      onApproval: applyPatchTool.onApproval,
      buildRejectionItem: () => {
        const response = TOOL_APPROVAL_REJECTION_MESSAGE;
        return new RunToolCallOutputItem(
          {
            type: 'apply_patch_call_output',
            callId: toolCall.callId,
            status: 'failed',
            output: response,
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

    emitToolStart(runner, runContext, agent, applyPatchTool, toolCall);

    let status: 'completed' | 'failed' = 'completed';
    let output = '';

    try {
      let result: ApplyPatchResult | void;
      switch (toolCall.operation.type) {
        case 'create_file':
          result = await applyPatchTool.editor.createFile(toolCall.operation);
          break;
        case 'update_file':
          result = await applyPatchTool.editor.updateFile(toolCall.operation);
          break;
        case 'delete_file':
          result = await applyPatchTool.editor.deleteFile(toolCall.operation);
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
      _logger.error('Failed to execute apply_patch operation:', err);
    }

    emitToolEnd(runner, runContext, agent, applyPatchTool, output, toolCall);

    const rawItem: protocol.ApplyPatchCallResultItem = {
      type: 'apply_patch_call_output',
      callId: toolCall.callId,
      status,
    };

    if (output) {
      rawItem.output = output;
    }

    results.push(new RunToolCallOutputItem(rawItem, agent, output));
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
): Promise<RunItem[]> {
  const _logger = customLogger ?? logger;
  const results: RunItem[] = [];
  for (const action of actions) {
    const toolCall = action.toolCall;

    // Hooks: on_tool_start (global + agent)
    emitToolStart(runner, runContext, agent, action.computer, toolCall);

    // Run the action and get screenshot
    let output: string;
    try {
      const computer = await resolveComputer({
        tool: action.computer,
        runContext,
      });
      output = await _runComputerActionAndScreenshot(computer, toolCall);
    } catch (err) {
      _logger.error('Failed to execute computer action:', err);
      output = '';
    }

    // Hooks: on_tool_end (global + agent)
    emitToolEnd(runner, runContext, agent, action.computer, output, toolCall);

    // Return the screenshot as a data URL when available; fall back to an empty string on failures.
    const imageUrl = output ? `data:image/png;base64,${output}` : '';
    const rawItem: protocol.ComputerCallResultItem = {
      type: 'computer_call_result',
      callId: toolCall.callId,
      output: { type: 'computer_screenshot', data: imageUrl },
    };
    results.push(new RunToolCallOutputItem(rawItem, agent, imageUrl));
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
    // multiple handoffs. Ignoring all but the first one by adding reject responses for those
    const outputMessage = 'Multiple handoffs detected, ignoring this one.';
    for (let i = 1; i < runHandoffs.length; i++) {
      newStepItems.push(
        new RunToolCallOutputItem(
          getToolCallOutputItem(runHandoffs[i].toolCall, outputMessage),
          agent,
          outputMessage,
        ),
      );
    }
  }

  const actualHandoff = runHandoffs[0];

  return withHandoffSpan(
    async (handoffSpan) => {
      const handoff = actualHandoff.handoff;

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

      const inputFilter =
        handoff.inputFilter ?? runner.config.handoffInputFilter;
      if (inputFilter) {
        logger.debug('Filtering inputs for handoff');

        if (typeof inputFilter !== 'function') {
          handoffSpan.setError({
            message: 'Invalid input filter',
            data: {
              details: 'not callable',
            },
          });
        }

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

  if (agent.toolUseBehavior === 'run_llm_again') {
    return NOT_FINAL_OUTPUT;
  }

  const firstToolResult = toolResults[0];
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
    const stoppingTool = toolResults.find((r) =>
      toolUseBehavior.stopAtToolNames.includes(r.tool.name),
    );
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
    return toolUseBehavior(state._context, toolResults as FunctionToolResult[]);
  }

  throw new UserError(`Invalid toolUseBehavior: ${toolUseBehavior}`, state);
}

type StructuredToolOutput =
  | ToolOutputText
  | ToolOutputImage
  | ToolOutputFileContent;

/**
 * Accepts whatever the tool returned and attempts to coerce it into the structured protocol
 * shapes we expose to downstream model adapters (input_text/input_image/input_file). Tools are
 * allowed to return either a single structured object or an array of them; anything else falls
 * back to the legacy string pipeline.
 */
function normalizeStructuredToolOutputs(
  output: unknown,
): StructuredToolOutput[] | null {
  if (Array.isArray(output)) {
    const structured: StructuredToolOutput[] = [];
    for (const item of output) {
      const normalized = normalizeStructuredToolOutput(item);
      if (!normalized) {
        return null;
      }
      structured.push(normalized);
    }
    return structured;
  }
  const normalized = normalizeStructuredToolOutput(output);
  return normalized ? [normalized] : null;
}

/**
 * Best-effort normalization of a single tool output item. If the object already matches the
 * protocol shape we simply cast it; otherwise we copy the recognised fields into the canonical
 * structure. Returning null lets the caller know we should revert to plain-string handling.
 */
function normalizeStructuredToolOutput(
  value: unknown,
): StructuredToolOutput | null {
  if (!isRecord(value)) {
    return null;
  }
  const type = value.type;
  if (type === 'text' && typeof value.text === 'string') {
    const output: ToolOutputText = { type: 'text', text: value.text };
    if (isRecord(value.providerData)) {
      output.providerData = value.providerData;
    }
    return output;
  }

  if (type === 'image') {
    const output: ToolOutputImage = { type: 'image' };

    let imageString: string | undefined;
    let imageFileId: string | undefined;
    const fallbackImageMediaType = isNonEmptyString((value as any).mediaType)
      ? (value as any).mediaType
      : undefined;

    const imageField = value.image;
    if (typeof imageField === 'string' && imageField.length > 0) {
      imageString = imageField;
    } else if (isRecord(imageField)) {
      const imageObj = imageField as Record<string, any>;
      const inlineMediaType = isNonEmptyString(imageObj.mediaType)
        ? imageObj.mediaType
        : fallbackImageMediaType;
      if (isNonEmptyString(imageObj.url)) {
        imageString = imageObj.url;
      } else if (isNonEmptyString(imageObj.data)) {
        imageString = toInlineImageString(imageObj.data, inlineMediaType);
      } else if (
        imageObj.data instanceof Uint8Array &&
        imageObj.data.length > 0
      ) {
        imageString = toInlineImageString(imageObj.data, inlineMediaType);
      }

      if (!imageString) {
        const candidateId =
          (isNonEmptyString(imageObj.fileId) && imageObj.fileId) ||
          (isNonEmptyString(imageObj.id) && imageObj.id) ||
          undefined;
        if (candidateId) {
          imageFileId = candidateId;
        }
      }
    }

    if (
      !imageString &&
      typeof value.imageUrl === 'string' &&
      value.imageUrl.length > 0
    ) {
      imageString = value.imageUrl;
    }
    if (
      !imageFileId &&
      typeof value.fileId === 'string' &&
      value.fileId.length > 0
    ) {
      imageFileId = value.fileId;
    }

    if (
      !imageString &&
      typeof value.data === 'string' &&
      value.data.length > 0
    ) {
      imageString = fallbackImageMediaType
        ? toInlineImageString(value.data, fallbackImageMediaType)
        : value.data;
    } else if (
      !imageString &&
      value.data instanceof Uint8Array &&
      value.data.length > 0
    ) {
      imageString = toInlineImageString(value.data, fallbackImageMediaType);
    }
    if (typeof value.detail === 'string' && value.detail.length > 0) {
      output.detail = value.detail;
    }

    if (imageString) {
      output.image = imageString;
    } else if (imageFileId) {
      output.image = { fileId: imageFileId };
    } else {
      return null;
    }

    if (isRecord(value.providerData)) {
      output.providerData = value.providerData;
    }
    return output;
  }

  if (type === 'file') {
    const fileValue = normalizeFileValue(value);
    if (!fileValue) {
      return null;
    }

    const output: ToolOutputFileContent = { type: 'file', file: fileValue };

    if (isRecord(value.providerData)) {
      output.providerData = value.providerData;
    }
    return output;
  }

  return null;
}

/**
 * Translates the normalized tool output into the protocol `input_*` items. This is the last hop
 * before we hand the data to model-specific adapters, so we generate the exact schema expected by
 * the protocol definitions.
 */
function convertStructuredToolOutputToInputItem(
  output: StructuredToolOutput,
): ToolCallStructuredOutput {
  if (output.type === 'text') {
    const result: protocol.InputText = {
      type: 'input_text',
      text: output.text,
    };
    if (output.providerData) {
      result.providerData = output.providerData;
    }
    return result;
  }
  if (output.type === 'image') {
    const result: protocol.InputImage = { type: 'input_image' };
    if (typeof output.detail === 'string' && output.detail.length > 0) {
      result.detail = output.detail;
    }
    if (typeof output.image === 'string' && output.image.length > 0) {
      result.image = output.image;
    } else if (isRecord(output.image)) {
      const imageObj = output.image as Record<string, any>;
      const inlineMediaType = isNonEmptyString(imageObj.mediaType)
        ? imageObj.mediaType
        : undefined;
      if (isNonEmptyString(imageObj.url)) {
        result.image = imageObj.url;
      } else if (isNonEmptyString(imageObj.data)) {
        result.image =
          inlineMediaType && !imageObj.data.startsWith('data:')
            ? asDataUrl(imageObj.data, inlineMediaType)
            : imageObj.data;
      } else if (
        imageObj.data instanceof Uint8Array &&
        imageObj.data.length > 0
      ) {
        const base64 = encodeUint8ArrayToBase64(imageObj.data);
        result.image = asDataUrl(base64, inlineMediaType);
      } else {
        const referencedId =
          (isNonEmptyString(imageObj.fileId) && imageObj.fileId) ||
          (isNonEmptyString(imageObj.id) && imageObj.id) ||
          undefined;
        if (referencedId) {
          result.image = { id: referencedId };
        }
      }
    }
    if (output.providerData) {
      result.providerData = output.providerData;
    }
    return result;
  }

  if (output.type === 'file') {
    const result: protocol.InputFile = { type: 'input_file' };
    const fileValue = output.file;
    if (typeof fileValue === 'string') {
      result.file = fileValue;
    } else if (fileValue && typeof fileValue === 'object') {
      const record = fileValue as Record<string, any>;
      if ('data' in record && record.data) {
        const mediaType = record.mediaType ?? 'text/plain';
        if (typeof record.data === 'string') {
          result.file = asDataUrl(record.data, mediaType);
        } else {
          const base64 = encodeUint8ArrayToBase64(record.data);
          result.file = asDataUrl(base64, mediaType);
        }
      } else if (typeof record.url === 'string' && record.url.length > 0) {
        result.file = { url: record.url };
      } else {
        const referencedId =
          (typeof record.id === 'string' &&
            record.id.length > 0 &&
            record.id) ||
          (typeof record.fileId === 'string' && record.fileId.length > 0
            ? record.fileId
            : undefined);
        if (referencedId) {
          result.file = { id: referencedId };
        }
      }

      if (typeof record.filename === 'string' && record.filename.length > 0) {
        result.filename = record.filename;
      }
    }
    if (output.providerData) {
      result.providerData = output.providerData;
    }
    return result;
  }
  const exhaustiveCheck: never = output;
  return exhaustiveCheck;
}

type FileReferenceValue = ToolOutputFileContent['file'];

function normalizeFileValue(
  value: Record<string, any>,
): FileReferenceValue | null {
  const directFile = value.file;
  if (typeof directFile === 'string' && directFile.length > 0) {
    return directFile;
  }

  const normalizedObject = normalizeFileObjectCandidate(directFile);
  if (normalizedObject) {
    return normalizedObject;
  }

  const legacyValue = normalizeLegacyFileValue(value);
  if (legacyValue) {
    return legacyValue;
  }

  return null;
}

function normalizeFileObjectCandidate(
  value: unknown,
): FileReferenceValue | null {
  if (!isRecord(value)) {
    return null;
  }

  if ('data' in value && value.data !== undefined) {
    const dataValue = value.data;
    const hasStringData = typeof dataValue === 'string' && dataValue.length > 0;
    const hasBinaryData =
      dataValue instanceof Uint8Array && dataValue.length > 0;
    if (!hasStringData && !hasBinaryData) {
      return null;
    }

    if (
      !isNonEmptyString(value.mediaType) ||
      !isNonEmptyString(value.filename)
    ) {
      return null;
    }

    return {
      data:
        typeof dataValue === 'string' ? dataValue : new Uint8Array(dataValue),
      mediaType: value.mediaType,
      filename: value.filename,
    };
  }

  if (isNonEmptyString(value.url)) {
    const result: { url: string; filename?: string } = { url: value.url };
    if (isNonEmptyString(value.filename)) {
      result.filename = value.filename;
    }
    return result;
  }

  const referencedId =
    (isNonEmptyString(value.id) && value.id) ||
    (isNonEmptyString(value.fileId) && (value.fileId as string));
  if (referencedId) {
    const result: { id: string; filename?: string } = { id: referencedId };
    if (isNonEmptyString(value.filename)) {
      result.filename = value.filename;
    }
    return result;
  }

  return null;
}

function normalizeLegacyFileValue(
  value: Record<string, any>,
): FileReferenceValue | null {
  const filename =
    typeof value.filename === 'string' && value.filename.length > 0
      ? value.filename
      : undefined;
  const mediaType =
    typeof value.mediaType === 'string' && value.mediaType.length > 0
      ? value.mediaType
      : undefined;

  if (typeof value.fileData === 'string' && value.fileData.length > 0) {
    if (!mediaType || !filename) {
      return null;
    }
    return { data: value.fileData, mediaType, filename };
  }

  if (value.fileData instanceof Uint8Array && value.fileData.length > 0) {
    if (!mediaType || !filename) {
      return null;
    }
    return { data: new Uint8Array(value.fileData), mediaType, filename };
  }

  if (typeof value.fileUrl === 'string' && value.fileUrl.length > 0) {
    const result: { url: string; filename?: string } = { url: value.fileUrl };
    if (filename) {
      result.filename = filename;
    }
    return result;
  }

  if (typeof value.fileId === 'string' && value.fileId.length > 0) {
    const result: { id: string; filename?: string } = { id: value.fileId };
    if (filename) {
      result.filename = filename;
    }
    return result;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function toInlineImageString(
  data: string | Uint8Array,
  mediaType?: string,
): string {
  if (typeof data === 'string') {
    if (mediaType && !data.startsWith('data:')) {
      return asDataUrl(data, mediaType);
    }
    return data;
  }
  const base64 = encodeUint8ArrayToBase64(data);
  return asDataUrl(base64, mediaType);
}

function asDataUrl(base64: string, mediaType?: string): string {
  return mediaType ? `data:${mediaType};base64,${base64}` : base64;
}
