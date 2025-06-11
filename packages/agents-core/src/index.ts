import { addTraceProcessor } from './tracing';
import { defaultProcessor } from './tracing/processor';

export { RuntimeEventEmitter } from '@openai/agents-core/_shims';
export {
  Agent,
  AgentConfiguration,
  AgentConfigWithHandoffs,
  AgentOptions,
  AgentOutputType,
  ToolsToFinalOutputResult,
  ToolToFinalOutputFunction,
  ToolUseBehavior,
  ToolUseBehaviorFlags,
} from './agent';
export { Computer } from './computer';
export {
  AgentsError,
  GuardrailExecutionError,
  InputGuardrailTripwireTriggered,
  MaxTurnsExceededError,
  ModelBehaviorError,
  OutputGuardrailTripwireTriggered,
  ToolCallError,
  UserError,
  SystemError,
} from './errors';
export {
  RunAgentUpdatedStreamEvent,
  RunRawModelStreamEvent,
  RunItemStreamEvent,
  RunStreamEvent,
} from './events';
export {
  defineOutputGuardrail,
  GuardrailFunctionOutput,
  InputGuardrail,
  InputGuardrailFunction,
  InputGuardrailFunctionArgs,
  InputGuardrailMetadata,
  InputGuardrailResult,
  OutputGuardrail,
  OutputGuardrailDefinition,
  OutputGuardrailFunction,
  OutputGuardrailFunctionArgs,
  OutputGuardrailMetadata,
  OutputGuardrailResult,
} from './guardrail';
export {
  getHandoff,
  getTransferMessage,
  Handoff,
  handoff,
  HandoffInputData,
} from './handoff';
export { assistant, system, user } from './helpers/message';
export {
  extractAllTextOutput,
  RunHandoffCallItem,
  RunItem,
  RunMessageOutputItem,
  RunReasoningItem,
  RunToolApprovalItem,
  RunToolCallItem,
  RunToolCallOutputItem,
} from './items';
export { AgentHooks } from './lifecycle';
export { getLogger } from './logger';
export {
  getAllMcpTools,
  invalidateServerToolsCache,
  MCPServer,
  MCPServerStdio,
  MCPServerStreamableHttp,
} from './mcp';
export {
  Model,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelSettings,
  ModelSettingsToolChoice,
  SerializedHandoff,
  SerializedTool,
  SerializedOutputType,
} from './model';
export { setDefaultModelProvider } from './providers';
export { RunResult, StreamedRunResult } from './result';
export {
  IndividualRunOptions,
  NonStreamRunOptions,
  run,
  RunConfig,
  Runner,
  StreamRunOptions,
} from './run';
export { RunContext } from './runContext';
export { RunState } from './runState';
export {
  HostedTool,
  ComputerTool,
  computerTool,
  HostedMCPTool,
  hostedMcpTool,
  FunctionTool,
  FunctionToolResult,
  Tool,
  tool,
  ToolExecuteArgument,
} from './tool';
export * from './tracing';
export { getGlobalTraceProvider, TraceProvider } from './tracing/provider';
/* only export the types not the parsers */
export type {
  AgentInputItem,
  AgentOutputItem,
  AssistantMessageItem,
  HostedToolCallItem,
  ComputerCallResultItem,
  ComputerUseCallItem,
  FunctionCallItem,
  FunctionCallResultItem,
  JsonSchemaDefinition,
  ReasoningItem,
  ResponseStreamEvent,
  SystemMessageItem,
  TextOutput,
  UnknownContext,
  UnknownItem,
  UserMessageItem,
  StreamEvent,
  StreamEventTextStream,
  StreamEventResponseCompleted,
  StreamEventResponseStarted,
  StreamEventGenericItem,
} from './types';
export { Usage } from './usage';

/**
 * Exporting the whole protocol as an object here. This contains both the types
 * and the zod schemas for parsing the protocol.
 */
export * as protocol from './types/protocol';

/**
 * Add the default processor, which exports traces and spans to the backend in batches. You can
 * change the default behavior by either:
 * 1. calling addTraceProcessor, which adds additional processors, or
 * 2. calling setTraceProcessors, which sets the processors and discards the default one
 */
addTraceProcessor(defaultProcessor());
