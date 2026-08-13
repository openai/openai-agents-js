import type { Handoff } from '../handoff';
import type { RunItem, RunToolApprovalItem } from '../items';
import type {
  Model,
  ModelSettings,
  Prompt,
  SerializedHandoff,
  SerializedTool,
} from '../model';
import type {
  ApplyPatchTool,
  ComputerTool,
  FunctionTool,
  HostedMCPTool,
  ShellTool,
} from '../tool';
import type { Tool } from '../tool';
import type { AgentInputItem, UnknownContext } from '../types';
import type * as protocol from '../types/protocol';
import type { ModelInputData } from './conversation';
import type { Span } from '../tracing/spans';
import type { Trace } from '../tracing/traces';
import type { ToolNameCollisionPolicy } from './runConfig';

export type ToolRunHandoff = {
  toolCall: protocol.FunctionCallItem;
  handoff: Handoff<any, any>;
};

export type ToolRunFunction<TContext = UnknownContext> = {
  toolCall: protocol.FunctionCallItem;
  tool: FunctionTool<TContext>;
  /** @internal Exact prepared function-tool snapshot used to resolve this call. */
  availableFunctionTools?: FunctionTool<TContext>[];
  /** @internal Preserve a trusted runtime-loaded handler during sandbox tool rebinding. */
  preserveToolOnExecutionRehydration?: boolean;
};

/** @internal */
export function createToolRunFunction<TContext>(args: {
  toolCall: protocol.FunctionCallItem;
  tool: FunctionTool<TContext>;
  availableFunctionTools: FunctionTool<TContext>[];
  preserveToolOnExecutionRehydration?: boolean;
}): ToolRunFunction<TContext> {
  const toolRun: ToolRunFunction<TContext> = {
    toolCall: args.toolCall,
    tool: args.tool,
  };
  Object.defineProperty(toolRun, 'availableFunctionTools', {
    value: args.availableFunctionTools,
    enumerable: false,
  });
  if (args.preserveToolOnExecutionRehydration) {
    Object.defineProperty(toolRun, 'preserveToolOnExecutionRehydration', {
      value: true,
      enumerable: false,
    });
  }
  return toolRun;
}

export type ToolRunFunctionNotFound = {
  toolCall: protocol.FunctionCallItem;
  toolName: string;
};

export type ToolRunComputer = {
  toolCall: protocol.ComputerUseCallItem;
  computer: ComputerTool<any, any>;
};

export type ToolRunShell = {
  toolCall: protocol.ShellCallItem;
  shell: ShellTool;
};

export type ToolRunApplyPatch = {
  toolCall: protocol.ApplyPatchCallItem;
  applyPatch: ApplyPatchTool;
};

export type ToolRunMCPApprovalRequest = {
  requestItem: RunToolApprovalItem;
  mcpTool: HostedMCPTool;
};

export type ProcessedResponse<TContext = UnknownContext> = {
  newItems: RunItem[];
  handoffs: ToolRunHandoff[];
  functions: ToolRunFunction<TContext>[];
  functionToolsNotFound?: ToolRunFunctionNotFound[];
  computerActions: ToolRunComputer[];
  shellActions: ToolRunShell[];
  applyPatchActions: ToolRunApplyPatch[];
  mcpApprovalRequests: ToolRunMCPApprovalRequest[];
  toolsUsed: string[];
  hasToolsOrApprovalsToRun(): boolean;
};

export type AgentArtifacts<TContext = UnknownContext> = {
  handoffs: Handoff<any, any>[];
  tools: Tool<TContext>[];
  serializedHandoffs: SerializedHandoff[];
  serializedTools: SerializedTool[];
  toolsExplicitlyProvided: boolean;
};

export type PreparedModelCall<TContext = UnknownContext> =
  AgentArtifacts<TContext> & {
    model: Model;
    explicitlyModelSet: boolean;
    modelRequestInternal: {
      reasoningEffortImplicit: boolean;
      tracingParent?: Span<any> | Trace;
      toolNameCollisionPolicy: ToolNameCollisionPolicy;
    };
    modelSettings: ModelSettings;
    modelInput: ModelInputData;
    prompt?: Prompt;
    allowPromptSuppliedTools: boolean;
    previousResponseId?: string;
    conversationId?: string;
    sourceItems: (AgentInputItem | undefined)[];
    persistedItems: AgentInputItem[];
    sourceMatchKinds: Array<'identity' | 'content' | 'fallback' | 'injected'>;
    filterApplied: boolean;
    preserveInputIdentity: boolean;
    turnInput: AgentInputItem[];
  };

export type {
  CallModelInputFilter,
  CallModelInputFilterArgs,
  FilterApplicationResult,
} from './conversation';
export type { ModelInputData };
export type { AgentInputItemPool } from './items';
export type {
  PreparedInputWithSessionResult,
  SessionPersistenceTracker,
} from './sessionPersistence';
