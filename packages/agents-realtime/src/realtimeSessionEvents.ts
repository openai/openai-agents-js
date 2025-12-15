import {
  type FunctionTool,
  OutputGuardrailTripwireTriggered,
  RunContext,
  RunToolApprovalItem,
  AgentInputItem,
} from '@openai/agents-core';
import { RealtimeGuardrailMetadata } from './guardrail';
import { RealtimeItem, RealtimeMcpCallItem } from './items';
import { RealtimeAgent } from './realtimeAgent';
import { TransportEvent, TransportLayerAudio } from './transportLayerEvents';
import { RealtimeContextData } from './realtimeSession';
import { protocol } from '@openai/agents-core';
import type { RealtimeMcpToolInfo } from './clientMessages';

type AgentWithOrWithoutHistory<TContext> =
  | RealtimeAgent<TContext>
  | RealtimeAgent<RealtimeContextData<TContext>>;

export type RealtimeToolApprovalRequest = {
  type: 'function_approval';
  tool: FunctionTool<RealtimeContextData<any>>;
  approvalItem: RunToolApprovalItem;
};

export type RealtimeMcpApprovalRequest = {
  type: 'mcp_approval_request';
  approvalItem: RunToolApprovalItem;
};

export type RealtimeSessionError = {
  type: 'error';
  error: unknown;
};

export type RealtimeSessionEventTypes<TContext = unknown> = {
  /**
   * Triggered when an agent starts its work on a response.
   */
  agent_start: [
    context: RunContext<RealtimeContextData<TContext>>,
    agent: AgentWithOrWithoutHistory<TContext>,
    turnInput?: AgentInputItem[],
  ];

  /**
   * Triggered when an agent ends its work on a response.
   */
  agent_end: [
    context: RunContext<RealtimeContextData<TContext>>,
    agent: AgentWithOrWithoutHistory<TContext>,
    output: string,
  ];

  /**
   * Triggered when an agent hands off to another agent.
   */
  agent_handoff: [
    context: RunContext<RealtimeContextData<TContext>>,
    fromAgent: AgentWithOrWithoutHistory<TContext>,
    toAgent: AgentWithOrWithoutHistory<TContext>,
  ];

  /**
   * Triggered when an agent starts a tool call.
   */
  agent_tool_start: [
    context: RunContext<RealtimeContextData<TContext>>,
    agent: AgentWithOrWithoutHistory<TContext>,
    tool: FunctionTool<RealtimeContextData<TContext>>,
    details: { toolCall: protocol.ToolCallItem },
  ];

  /**
   * Triggered when an agent ends a tool call.
   */
  agent_tool_end: [
    context: RunContext<RealtimeContextData<TContext>>,
    agent: AgentWithOrWithoutHistory<TContext>,
    tool: FunctionTool<RealtimeContextData<TContext>>,
    result: string,
    details: { toolCall: protocol.ToolCallItem },
  ];

  /**
   * Emits all the raw events from the transport layer.
   */
  transport_event: [event: TransportEvent];

  /**
   * Triggered when the agent starts generating audio.
   */
  audio_start: [
    context: RunContext<RealtimeContextData<TContext>>,
    agent: AgentWithOrWithoutHistory<TContext>,
  ];

  /**
   * Triggered when the agent stops generating audio.
   */
  audio_stopped: [
    context: RunContext<RealtimeContextData<TContext>>,
    agent: AgentWithOrWithoutHistory<TContext>,
  ];

  /**
   * Triggered when there is new audio data available for playing to the user.
   */
  audio: [event: TransportLayerAudio];

  /**
   * Triggered when the agent is interrupted. Can be listened to by the user to stop audio playback
   * or give visual indicators to the user.
   */
  audio_interrupted: [
    context: RunContext<RealtimeContextData<TContext>>,
    agent: AgentWithOrWithoutHistory<TContext>,
  ];

  /**
   * Triggered when an output guardrail is tripped.
   */
  guardrail_tripped: [
    context: RunContext<RealtimeContextData<TContext>>,
    agent: AgentWithOrWithoutHistory<TContext>,
    error: OutputGuardrailTripwireTriggered<RealtimeGuardrailMetadata>,
    details: { itemId: string },
  ];

  /**
   * Triggered when the history got updated. Contains the full history of the conversation.
   */
  history_updated: [history: RealtimeItem[]];

  /**
   * Triggered when a new item is added to the history. At this point the transcript/response
   * might still be in progress.
   */
  history_added: [item: RealtimeItem];

  /**
   * Triggered when an error occurs.
   */
  error: [error: RealtimeSessionError];

  /**
   * Triggered when a tool approval is requested.
   */
  tool_approval_requested: [
    context: RunContext<RealtimeContextData<TContext>>,
    agent: AgentWithOrWithoutHistory<TContext>,
    approvalRequest: RealtimeToolApprovalRequest | RealtimeMcpApprovalRequest,
  ];

  /**
   * Triggered when an MCP tool call is completed.
   */
  mcp_tool_call_completed: [
    context: RunContext<RealtimeContextData<TContext>>,
    agent: AgentWithOrWithoutHistory<TContext>,
    toolCall: RealtimeMcpCallItem,
  ];
  /**
   * Triggered when the set of currently available MCP tools changes
   * (e.g. after a list-tools result arrives, or when the active agent changes).
   * Carries the list of available tools filtered by the active agent's server_labels.
   */
  mcp_tools_changed: [tools: RealtimeMcpToolInfo[]];
};
