export type AGUIEventType =
  | 'RUN_STARTED'
  | 'RUN_FINISHED'
  | 'RUN_ERROR'
  | 'STEP_STARTED'
  | 'STEP_FINISHED'
  | 'TEXT_MESSAGE_START'
  | 'TEXT_MESSAGE_CONTENT'
  | 'TEXT_MESSAGE_END'
  | 'TOOL_CALL_START'
  | 'TOOL_CALL_ARGS'
  | 'TOOL_CALL_END'
  | 'STATE_SNAPSHOT'
  | 'STATE_DELTA'
  | 'MESSAGES_SNAPSHOT'
  | 'RAW'
  | 'CUSTOM';

export interface BaseAGUIEvent {
  type: AGUIEventType;
  timestamp?: number;
  rawEvent?: any;
}

export interface RunStartedEvent extends BaseAGUIEvent {
  type: 'RUN_STARTED';
  thread_id: string;
  run_id: string;
  agentName?: string;
}

export interface RunFinishedEvent extends BaseAGUIEvent {
  type: 'RUN_FINISHED';
  thread_id: string;
  run_id: string;
  finalOutput?: any;
}

export interface RunErrorEvent extends BaseAGUIEvent {
  type: 'RUN_ERROR';
  error: string;
  thread_id: string;
  run_id: string;
}

export interface StepStartedEvent extends BaseAGUIEvent {
  type: 'STEP_STARTED';
  stepId?: string;
  agentName?: string;
}

export interface StepFinishedEvent extends BaseAGUIEvent {
  type: 'STEP_FINISHED';
  stepId?: string;
  agentName?: string;
}

export interface TextMessageStartEvent extends BaseAGUIEvent {
  type: 'TEXT_MESSAGE_START';
  message_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'developer';
  name?: string;
}

export interface TextMessageContentEvent extends BaseAGUIEvent {
  type: 'TEXT_MESSAGE_CONTENT';
  message_id: string;
  delta: string;
}

export interface TextMessageEndEvent extends BaseAGUIEvent {
  type: 'TEXT_MESSAGE_END';
  message_id: string;
}

export interface ToolMessageEvent extends BaseAGUIEvent {
  type: 'TOOL_MESSAGE';
  message_id: string;
  role: 'tool';
  content: string;
  tool_call_id: string;
}

export interface ToolCallStartEvent extends BaseAGUIEvent {
  type: 'TOOL_CALL_START';
  tool_call_id: string;
  tool_name: string;
}

export interface ToolCallArgsEvent extends BaseAGUIEvent {
  type: 'TOOL_CALL_ARGS';
  tool_call_id: string;
  args: any;
}

export interface ToolCallEndEvent extends BaseAGUIEvent {
  type: 'TOOL_CALL_END';
  tool_call_id: string;
  result: any;
  success: boolean;
}

export interface StateSnapshotEvent extends BaseAGUIEvent {
  type: 'STATE_SNAPSHOT';
  state: any;
}

export interface JsonPatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: any;
  from?: string;
}

export interface StateDeltaEvent extends BaseAGUIEvent {
  type: 'STATE_DELTA';
  delta: JsonPatchOperation[];
}

export interface MessagesSnapshotEvent extends BaseAGUIEvent {
  type: 'MESSAGES_SNAPSHOT';
  messages: any[];
}

export interface RawEvent extends BaseAGUIEvent {
  type: 'RAW';
  data: any;
}

export interface CustomEvent extends BaseAGUIEvent {
  type: 'CUSTOM';
  data: any;
}

export type AGUIEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolMessageEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | MessagesSnapshotEvent
  | RawEvent
  | CustomEvent;
