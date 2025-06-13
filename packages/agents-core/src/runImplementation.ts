import { FunctionCallResultItem } from './types/protocol';
import { Agent, AgentOutputType, ToolsToFinalOutputResult } from './agent';
import { ModelBehaviorError, ToolCallError, UserError } from './errors';
import { getTransferMessage, Handoff, HandoffInputData } from './handoff';
import {
  RunHandoffCallItem,
  RunHandoffOutputItem,
  RunMessageOutputItem,
  RunReasoningItem,
  RunItem,
  RunToolApprovalItem,
  RunToolCallItem,
  RunToolCallOutputItem,
} from './items';
import logger, { Logger } from './logger';
import { ModelResponse, ModelSettings } from './model';
import {
  ComputerTool,
  FunctionTool,
  Tool,
  FunctionToolResult,
  HostedMCPTool,
} from './tool';
import { AgentInputItem, UnknownContext } from './types';
import { Runner } from './run';
import { RunContext } from './runContext';
import { getLastTextFromOutputMessage } from './utils/messages';
import { withFunctionSpan, withHandoffSpan } from './tracing/createSpans';
import { getSchemaAndParserFromInputType } from './utils/tools';
import { safeExecute } from './utils/safeExecute';
import { addErrorToCurrentSpan } from './tracing/context';
import { RunItemStreamEvent, RunItemStreamEventName } from './events';
import { StreamedRunResult } from './result';
import { z } from '@openai/zod/v3';
import { toSmartString } from './utils/smartString';
import * as protocol from './types/protocol';
import { Computer } from './computer';
import { RunState } from './runState';
import { isZodObject } from './utils';
import * as ProviderData from './types/providerData';

type ToolRunHandoff = {
  toolCall: protocol.FunctionCallItem;
  handoff: Handoff;
};

type ToolRunFunction<TContext = UnknownContext> = {
  toolCall: protocol.FunctionCallItem;
  tool: FunctionTool<TContext>;
};

type ToolRunComputer = {
  toolCall: protocol.ComputerUseCallItem;
  computer: ComputerTool;
};

type ToolRunMCPApprovalRequest = {
  requestItem: RunToolApprovalItem;
  mcpTool: HostedMCPTool;
};

export type ProcessedResponse<TContext = UnknownContext> = {
  newItems: RunItem[];
  handoffs: ToolRunHandoff[];
  functions: ToolRunFunction<TContext>[];
  computerActions: ToolRunComputer[];
  mcpApprovalRequests: ToolRunMCPApprovalRequest[];
  toolsUsed: string[];
  hasToolsOrApprovalsToRun(): boolean;
};

/**
 * @internal
 */
export function processModelResponse<TContext>(
  modelResponse: ModelResponse,
  agent: Agent<any, any>,
  tools: Tool<TContext>[],
  handoffs: Handoff[],
): ProcessedResponse<TContext> {
  const items: RunItem[] = [];
  const runHandoffs: ToolRunHandoff[] = [];
  const runFunctions: ToolRunFunction<TContext>[] = [];
  const runComputerActions: ToolRunComputer[] = [];
  const runMCPApprovalRequests: ToolRunMCPApprovalRequest[] = [];
  const toolsUsed: string[] = [];
  const handoffMap = new Map(handoffs.map((h) => [h.toolName, h]));
  const functionMap = new Map(
    tools.filter((t) => t.type === 'function').map((t) => [t.name, t]),
  );
  const computerTool = tools.find((t) => t.type === 'computer');
  const mcpToolMap = new Map(
    tools
      .filter((t) => t.type === 'hosted_tool' && t.providerData?.type === 'mcp')
      .map((t) => t as HostedMCPTool)
      .map((t) => [t.providerData.server_label, t]),
  );

  for (const output of modelResponse.output) {
    if (output.type === 'message') {
      if (output.role === 'assistant') {
        items.push(new RunMessageOutputItem(output, agent));
      }
    } else if (output.type === 'hosted_tool_call') {
      items.push(new RunToolCallItem(output, agent));
      const toolName = output.name;
      toolsUsed.push(toolName);

      if (
        output.providerData?.type === 'mcp_approval_request' ||
        output.name === 'mcp_approval_request'
      ) {
        // Hosted remote MCP server's approval process
        const providerData =
          output.providerData as ProviderData.HostedMCPApprovalRequest;

        const mcpServerLabel = providerData.server_label;
        const mcpServerTool = mcpToolMap.get(mcpServerLabel);
        if (typeof mcpServerTool === 'undefined') {
          const message = `MCP server (${mcpServerLabel}) not found in Agent (${agent.name})`;
          addErrorToCurrentSpan({
            message,
            data: { mcp_server_label: mcpServerLabel },
          });
          throw new ModelBehaviorError(message);
        }

        // Do this approval later:
        // We support both onApproval callback (like the Python SDK does) and HITL patterns.
        const approvalItem = new RunToolApprovalItem(
          {
            type: 'hosted_tool_call',
            // We must use this name to align with the name sent from the servers
            name: providerData.name,
            id: providerData.id,
            status: 'in_progress',
            providerData,
          },
          agent,
        );
        runMCPApprovalRequests.push({
          requestItem: approvalItem,
          mcpTool: mcpServerTool,
        });
        if (!mcpServerTool.providerData.on_approval) {
          // When onApproval function exists, it confirms the approval right after this.
          // Thus, this approval item must be appended only for the next turn interrpution patterns.
          items.push(approvalItem);
        }
      }
    } else if (output.type === 'reasoning') {
      items.push(new RunReasoningItem(output, agent));
    } else if (output.type === 'computer_call') {
      items.push(new RunToolCallItem(output, agent));
      toolsUsed.push('computer_use');
      if (!computerTool) {
        addErrorToCurrentSpan({
          message: 'Model produced computer action without a computer tool.',
          data: {
            agent_name: agent.name,
          },
        });
        throw new ModelBehaviorError(
          'Model produced computer action without a computer tool.',
        );
      }
      runComputerActions.push({
        toolCall: output,
        computer: computerTool,
      });
    }

    if (output.type !== 'function_call') {
      continue;
    }

    toolsUsed.push(output.name);

    const handoff = handoffMap.get(output.name);
    if (handoff) {
      items.push(new RunHandoffCallItem(output, agent));
      runHandoffs.push({
        toolCall: output,
        handoff: handoff,
      });
    } else {
      const functionTool = functionMap.get(output.name);
      if (!functionTool) {
        addErrorToCurrentSpan({
          message: `Tool ${output.name} not found in agent ${agent.name}.`,
          data: {
            tool_name: output.name,
            agent_name: agent.name,
          },
        });

        throw new ModelBehaviorError(
          `Tool ${output.name} not found in agent ${agent.name}.`,
        );
      }
      items.push(new RunToolCallItem(output, agent));
      runFunctions.push({
        toolCall: output,
        tool: functionTool,
      });
    }
  }

  return {
    newItems: items,
    handoffs: runHandoffs,
    functions: runFunctions,
    computerActions: runComputerActions,
    mcpApprovalRequests: runMCPApprovalRequests,
    toolsUsed: toolsUsed,
    hasToolsOrApprovalsToRun(): boolean {
      return (
        runHandoffs.length > 0 ||
        runFunctions.length > 0 ||
        runMCPApprovalRequests.length > 0 ||
        runComputerActions.length > 0
      );
    },
  };
}

export const nextStepSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('next_step_handoff'),
    newAgent: z.any(),
  }),
  z.object({
    type: z.literal('next_step_final_output'),
    output: z.string(),
  }),
  z.object({
    type: z.literal('next_step_run_again'),
  }),
  z.object({
    type: z.literal('next_step_interruption'),
    data: z.record(z.string(), z.any()),
  }),
]);

export type NextStep = z.infer<typeof nextStepSchema>;

class SingleStepResult {
  constructor(
    /**
     * The input items i.e. the items before run() was called. May be muted by handoff input filters
     */
    public originalInput: string | AgentInputItem[],
    /**
     * The model response for the current step
     */
    public modelResponse: ModelResponse,
    /**
     * The items before the current step was executed
     */
    public preStepItems: RunItem[],
    /**
     * The items after the current step was executed
     */
    public newStepItems: RunItem[],
    /**
     * The next step to execute
     */
    public nextStep: NextStep,
  ) {}

  /**
   * The items generated during the agent run (i.e. everything generated after originalInput)
   */
  get generatedItems(): RunItem[] {
    return this.preStepItems.concat(this.newStepItems);
  }
}

/**
 * @internal
 */
export function maybeResetToolChoice(
  agent: Agent<any, any>,
  toolUseTracker: AgentToolUseTracker,
  modelSettings: ModelSettings,
) {
  if (agent.resetToolChoice && toolUseTracker.hasUsedTools(agent)) {
    return { ...modelSettings, toolChoice: undefined };
  }
  return modelSettings;
}

/**
 * @internal
 */
export async function executeInterruptedToolsAndSideEffects<TContext>(
  agent: Agent<TContext, any>,
  originalInput: string | AgentInputItem[],
  originalPreStepItems: RunItem[],
  newResponse: ModelResponse,
  processedResponse: ProcessedResponse,
  runner: Runner,
  state: RunState<TContext, Agent<TContext, any>>,
): Promise<SingleStepResult> {
  // call_ids for function tools
  const functionCallIds = originalPreStepItems
    .filter(
      (item) =>
        item instanceof RunToolApprovalItem &&
        'callId' in item.rawItem &&
        item.rawItem.type === 'function_call',
    )
    .map((item) => (item.rawItem as protocol.FunctionCallItem).callId);
  // Run function tools that require approval after they get their approval results
  const functionToolRuns = processedResponse.functions.filter((run) => {
    return functionCallIds.includes(run.toolCall.callId);
  });

  const functionResults = await executeFunctionToolCalls(
    agent,
    functionToolRuns,
    runner,
    state,
  );

  // Create the initial set of the output items
  const newItems: RunItem[] = functionResults.map((r) => r.runItem);

  // Run MCP tools that require approval after they get their approval results
  const mcpApprovalRuns = processedResponse.mcpApprovalRequests.filter(
    (run) => {
      return (
        run.requestItem.type === 'tool_approval_item' &&
        run.requestItem.rawItem.type === 'hosted_tool_call' &&
        run.requestItem.rawItem.providerData?.type === 'mcp_approval_request'
      );
    },
  );
  for (const run of mcpApprovalRuns) {
    // the approval_request_id "mcpr_123..."
    const approvalRequestId = run.requestItem.rawItem.id!;
    const approved = state._context.isToolApproved({
      // Since this item name must be the same with the one sent from Responses API server
      toolName: run.requestItem.rawItem.name,
      callId: approvalRequestId,
    });
    if (typeof approved !== 'undefined') {
      const providerData: ProviderData.HostedMCPApprovalResponse = {
        approve: approved,
        approval_request_id: approvalRequestId,
        reason: undefined,
      };
      // Tell Responses API server the approval result in the next turn
      newItems.push(
        new RunToolCallItem(
          {
            type: 'hosted_tool_call',
            name: 'mcp_approval_response',
            providerData,
          },
          agent as Agent<unknown, 'text'>,
        ),
      );
    }
  }

  const checkToolOutput = await checkForFinalOutputFromTools(
    agent,
    functionResults,
    state,
  );

  // Exclude the tool approval items, which should not be sent to Responses API,
  // from the SingleStepResult's preStepItems
  const preStepItems = originalPreStepItems.filter((item) => {
    return !(item instanceof RunToolApprovalItem);
  });

  if (checkToolOutput.isFinalOutput) {
    runner.emit(
      'agent_end',
      state._context,
      agent,
      checkToolOutput.finalOutput,
    );
    agent.emit('agent_end', state._context, checkToolOutput.finalOutput);

    return new SingleStepResult(
      originalInput,
      newResponse,
      preStepItems,
      newItems,
      {
        type: 'next_step_final_output',
        output: checkToolOutput.finalOutput,
      },
    );
  } else if (checkToolOutput.isInterrupted) {
    return new SingleStepResult(
      originalInput,
      newResponse,
      preStepItems,
      newItems,
      {
        type: 'next_step_interruption',
        data: {
          interruptions: checkToolOutput.interruptions,
        },
      },
    );
  }

  // we only ran new tools and side effects. We need to run the rest of the agent
  return new SingleStepResult(
    originalInput,
    newResponse,
    preStepItems,
    newItems,
    { type: 'next_step_run_again' },
  );
}

/**
 * @internal
 */
export async function executeToolsAndSideEffects<TContext>(
  agent: Agent<TContext, any>,
  originalInput: string | AgentInputItem[],
  originalPreStepItems: RunItem[],
  newResponse: ModelResponse,
  processedResponse: ProcessedResponse<TContext>,
  runner: Runner,
  state: RunState<TContext, Agent<TContext, any>>,
): Promise<SingleStepResult> {
  const preStepItems = originalPreStepItems;
  let newItems = processedResponse.newItems;

  const [functionResults, computerResults] = await Promise.all([
    executeFunctionToolCalls(
      agent,
      processedResponse.functions as ToolRunFunction<unknown>[],
      runner,
      state,
    ),
    executeComputerActions(
      agent,
      processedResponse.computerActions,
      runner,
      state._context,
    ),
  ]);

  newItems = newItems.concat(functionResults.map((r) => r.runItem));
  newItems = newItems.concat(computerResults);

  // run hosted MCP approval requests
  if (processedResponse.mcpApprovalRequests.length > 0) {
    for (const approvalRequest of processedResponse.mcpApprovalRequests) {
      const toolData = approvalRequest.mcpTool
        .providerData as ProviderData.HostedMCPTool<TContext>;
      const requestData = approvalRequest.requestItem.rawItem
        .providerData as ProviderData.HostedMCPApprovalRequest;
      if (toolData.on_approval) {
        // synchronously handle the approval process here
        const approvalResult = await toolData.on_approval(
          state._context,
          approvalRequest.requestItem,
        );
        const approvalResponseData: ProviderData.HostedMCPApprovalResponse = {
          approve: approvalResult.approve,
          approval_request_id: requestData.id,
          reason: approvalResult.reason,
        };
        newItems.push(
          new RunToolCallItem(
            {
              type: 'hosted_tool_call',
              name: 'mcp_approval_response',
              providerData: approvalResponseData,
            },
            agent as Agent<unknown, 'text'>,
          ),
        );
      } else {
        // receive a user's approval on the next turn
        newItems.push(approvalRequest.requestItem);
        const approvalItem = {
          type: 'hosted_mcp_tool_approval' as const,
          tool: approvalRequest.mcpTool,
          runItem: new RunToolApprovalItem(
            {
              type: 'hosted_tool_call',
              name: requestData.name,
              id: requestData.id,
              arguments: requestData.arguments,
              status: 'in_progress',
              providerData: requestData,
            },
            agent,
          ),
        };
        functionResults.push(approvalItem);
        // newItems.push(approvalItem.runItem);
      }
    }
  }

  // process handoffs
  if (processedResponse.handoffs.length > 0) {
    return await executeHandoffCalls(
      agent,
      originalInput,
      preStepItems,
      newItems,
      newResponse,
      processedResponse.handoffs,
      runner,
      state._context,
    );
  }

  const checkToolOutput = await checkForFinalOutputFromTools(
    agent,
    functionResults,
    state,
  );

  if (checkToolOutput.isFinalOutput) {
    runner.emit(
      'agent_end',
      state._context,
      agent,
      checkToolOutput.finalOutput,
    );
    agent.emit('agent_end', state._context, checkToolOutput.finalOutput);

    return new SingleStepResult(
      originalInput,
      newResponse,
      preStepItems,
      newItems,
      {
        type: 'next_step_final_output',
        output: checkToolOutput.finalOutput,
      },
    );
  } else if (checkToolOutput.isInterrupted) {
    return new SingleStepResult(
      originalInput,
      newResponse,
      preStepItems,
      newItems,
      {
        type: 'next_step_interruption',
        data: {
          interruptions: checkToolOutput.interruptions,
        },
      },
    );
  }

  // check if the agent produced any messages
  const messageItems = newItems.filter(
    (item) => item instanceof RunMessageOutputItem,
  );

  // we will use the last content output as the final output
  const potentialFinalOutput =
    messageItems.length > 0
      ? getLastTextFromOutputMessage(
          messageItems[messageItems.length - 1].rawItem,
        )
      : undefined;

  // if there is no output we just run again
  if (!potentialFinalOutput) {
    return new SingleStepResult(
      originalInput,
      newResponse,
      preStepItems,
      newItems,
      { type: 'next_step_run_again' },
    );
  }

  if (
    agent.outputType === 'text' &&
    !processedResponse.hasToolsOrApprovalsToRun()
  ) {
    return new SingleStepResult(
      originalInput,
      newResponse,
      preStepItems,
      newItems,
      {
        type: 'next_step_final_output',
        output: potentialFinalOutput,
      },
    );
  } else if (agent.outputType !== 'text' && potentialFinalOutput) {
    // Structured output schema => always leads to a final output if we have text
    const { parser } = getSchemaAndParserFromInputType(
      agent.outputType,
      'final_output',
    );
    const [error] = await safeExecute(() => parser(potentialFinalOutput));
    if (error) {
      addErrorToCurrentSpan({
        message: 'Invalid output type',
        data: {
          error: String(error),
        },
      });
      throw new ModelBehaviorError('Invalid output type');
    }

    return new SingleStepResult(
      originalInput,
      newResponse,
      preStepItems,
      newItems,
      { type: 'next_step_final_output', output: potentialFinalOutput },
    );
  }

  return new SingleStepResult(
    originalInput,
    newResponse,
    preStepItems,
    newItems,
    { type: 'next_step_run_again' },
  );
}

/**
 * @internal
 */
export function getToolCallOutputItem(
  toolCall: protocol.FunctionCallItem,
  output: string | unknown,
): FunctionCallResultItem {
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
 */
export async function executeFunctionToolCalls<TContext = UnknownContext>(
  agent: Agent<any, any>,
  toolRuns: ToolRunFunction<unknown>[],
  runner: Runner,
  state: RunState<TContext, Agent<any, any>>,
): Promise<FunctionToolResult[]> {
  async function runSingleTool(toolRun: ToolRunFunction<unknown>) {
    let parsedArgs: any = toolRun.toolCall.arguments;
    if (toolRun.tool.parameters) {
      if (isZodObject(toolRun.tool.parameters)) {
        parsedArgs = toolRun.tool.parameters.parse(parsedArgs);
      } else {
        parsedArgs = JSON.parse(parsedArgs);
      }
    }
    const needsApproval = await toolRun.tool.needsApproval(
      state._context,
      parsedArgs,
      toolRun.toolCall.callId,
    );

    if (needsApproval) {
      const approval = state._context.isToolApproved({
        toolName: toolRun.tool.name,
        callId: toolRun.toolCall.callId,
      });

      if (approval === false) {
        // rejected
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

      if (approval !== true) {
        // this approval process needs to be done in the next turn
        return {
          type: 'function_approval' as const,
          tool: toolRun.tool,
          runItem: new RunToolApprovalItem(toolRun.toolCall, agent),
        };
      }
    }

    return withFunctionSpan(
      async (span) => {
        if (runner.config.traceIncludeSensitiveData) {
          span.spanData.input = toolRun.toolCall.arguments;
        }

        try {
          runner.emit('agent_tool_start', state._context, agent, toolRun.tool, {
            toolCall: toolRun.toolCall,
          });
          agent.emit('agent_tool_start', state._context, toolRun.tool, {
            toolCall: toolRun.toolCall,
          });
          const result = await toolRun.tool.invoke(
            state._context,
            toolRun.toolCall.arguments,
          );
          // Use string data for tracing and event emitter
          const stringResult = toSmartString(result);

          runner.emit(
            'agent_tool_end',
            state._context,
            agent,
            toolRun.tool,
            stringResult,
            { toolCall: toolRun.toolCall },
          );
          agent.emit(
            'agent_tool_end',
            state._context,
            toolRun.tool,
            stringResult,
            { toolCall: toolRun.toolCall },
          );

          if (runner.config.traceIncludeSensitiveData) {
            span.spanData.output = stringResult;
          }

          return {
            type: 'function_output' as const,
            tool: toolRun.tool,
            output: result,
            runItem: new RunToolCallOutputItem(
              getToolCallOutputItem(toolRun.toolCall, result),
              agent,
              result,
            ),
          };
        } catch (error) {
          span.setError({
            message: 'Error running tool',
            data: {
              tool_name: toolRun.tool.name,
              error: String(error),
            },
          });
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

  try {
    const results = await Promise.all(toolRuns.map(runSingleTool));
    return results;
  } catch (e: unknown) {
    throw new ToolCallError(
      `Failed to run function tools: ${e}`,
      e as Error,
      state,
    );
  }
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

/**
 * @internal
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
    const computer = action.computer.computer;
    const toolCall = action.toolCall;

    // Hooks: on_tool_start (global + agent)
    runner.emit('agent_tool_start', runContext, agent, action.computer, {
      toolCall,
    });
    if (typeof agent.emit === 'function') {
      agent.emit('agent_tool_start', runContext, action.computer, { toolCall });
    }

    // Run the action and get screenshot
    let output: string;
    try {
      output = await _runComputerActionAndScreenshot(computer, toolCall);
    } catch (err) {
      _logger.error('Failed to execute computer action:', err);
      output = '';
    }

    // Hooks: on_tool_end (global + agent)
    runner.emit('agent_tool_end', runContext, agent, action.computer, output, {
      toolCall,
    });
    if (typeof agent.emit === 'function') {
      agent.emit('agent_tool_end', runContext, action.computer, output, {
        toolCall,
      });
    }

    // Always return a screenshot as a base64 data URL
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
): Promise<SingleStepResult> {
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
    const outputMessage = 'Multiple handoffs detected, ignorning this one.';
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
 * @internal
 */
export async function checkForFinalOutputFromTools<
  TContext,
  TOutput extends AgentOutputType,
>(
  agent: Agent<TContext, TOutput>,
  toolResults: FunctionToolResult[],
  state: RunState<TContext, Agent<TContext, TOutput>>,
): Promise<ToolsToFinalOutputResult> {
  if (toolResults.length === 0) {
    return NOT_FINAL_OUTPUT;
  }

  const interruptions: RunToolApprovalItem[] = toolResults
    .filter((r) => r.runItem instanceof RunToolApprovalItem)
    .map((r) => r.runItem as RunToolApprovalItem);

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
    return toolUseBehavior(state._context, toolResults);
  }

  throw new UserError(`Invalid toolUseBehavior: ${toolUseBehavior}`, state);
}

export function addStepToRunResult(
  result: StreamedRunResult<any, any>,
  step: SingleStepResult,
): void {
  for (const item of step.newStepItems) {
    let itemName: RunItemStreamEventName;
    if (item instanceof RunMessageOutputItem) {
      itemName = 'message_output_created';
    } else if (item instanceof RunHandoffCallItem) {
      itemName = 'handoff_requested';
    } else if (item instanceof RunHandoffOutputItem) {
      itemName = 'handoff_occurred';
    } else if (item instanceof RunToolCallItem) {
      itemName = 'tool_called';
    } else if (item instanceof RunToolCallOutputItem) {
      itemName = 'tool_output';
    } else if (item instanceof RunReasoningItem) {
      itemName = 'reasoning_item_created';
    } else if (item instanceof RunToolApprovalItem) {
      itemName = 'tool_approval_requested';
    } else {
      logger.warn('Unknown item type: ', item);
      continue;
    }

    result._addItem(new RunItemStreamEvent(itemName, item));
  }
}

export class AgentToolUseTracker {
  #agentToTools = new Map<Agent<any, any>, string[]>();

  addToolUse(agent: Agent<any, any>, toolNames: string[]): void {
    this.#agentToTools.set(agent, toolNames);
  }

  hasUsedTools(agent: Agent<any, any>): boolean {
    return this.#agentToTools.has(agent);
  }

  toJSON(): Record<string, string[]> {
    return Object.fromEntries(
      Array.from(this.#agentToTools.entries()).map(([agent, toolNames]) => {
        return [agent.name, toolNames];
      }),
    );
  }
}
