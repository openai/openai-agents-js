import type { RunStreamEvent, StreamedRunResult } from '@openai/agents';
import type { ChatKitResponseStreamConverter } from './converter';

export type ChatKitSourceBase = {
  title: string;
  description?: string | null;
  timestamp?: string | null;
  group?: string | null;
};

export type ChatKitFileSource = ChatKitSourceBase & {
  type: 'file';
  filename: string;
};

export type ChatKitUrlSource = ChatKitSourceBase & {
  type: 'url';
  url: string;
  attribution?: string | null;
};

export type ChatKitEntitySource = ChatKitSourceBase & {
  type: 'entity';
  id: string;
  icon?: string | null;
  label?: string | null;
  inline_label?: string | null;
  interactive?: boolean;
  data?: Record<string, unknown>;
};

export type ChatKitSource =
  | ChatKitFileSource
  | ChatKitUrlSource
  | ChatKitEntitySource;

export type ChatKitAnnotation = {
  type: 'annotation';
  source: ChatKitSource;
  index?: number | null;
};

export type ChatKitAssistantMessageContent = {
  type: 'output_text';
  text: string;
  annotations: ChatKitAnnotation[];
};

export type ChatKitAssistantMessageItem = {
  type: 'assistant_message';
  id: string;
  thread_id: string;
  created_at: string;
  content: ChatKitAssistantMessageContent[];
};

export type ChatKitUserMessageTextContent = {
  type: 'input_text';
  text: string;
};

export type ChatKitUserMessageTagContent = {
  type: 'input_tag';
  id: string;
  text: string;
  data: Record<string, unknown>;
  group?: string | null;
  interactive?: boolean;
};

export type ChatKitUserMessageContent =
  | ChatKitUserMessageTextContent
  | ChatKitUserMessageTagContent;

export type ChatKitToolChoice = {
  id: string;
};

export type ChatKitInferenceOptions = {
  tool_choice?: ChatKitToolChoice | null;
  model?: string | null;
};

export type ChatKitUserMessageInput = {
  content: ChatKitUserMessageContent[];
  attachments: string[];
  quoted_text?: string | null;
  inference_options: ChatKitInferenceOptions;
};

export type ChatKitUserMessageItem = {
  type: 'user_message';
  id: string;
  thread_id: string;
  created_at: string;
  content: ChatKitUserMessageContent[];
  attachments: Record<string, unknown>[];
  quoted_text?: string | null;
  inference_options: ChatKitInferenceOptions;
};

export type ChatKitFeedbackKind = 'positive' | 'negative';

export type ChatKitRequestBase = {
  metadata?: Record<string, unknown>;
};

export type ChatKitThreadGetByIdParams = {
  thread_id: string;
};

export type ChatKitThreadsGetByIdRequest = ChatKitRequestBase & {
  type: 'threads.get_by_id';
  params: ChatKitThreadGetByIdParams;
};

export type ChatKitThreadCreateParams = {
  input: ChatKitUserMessageInput;
};

export type ChatKitThreadsCreateRequest = ChatKitRequestBase & {
  type: 'threads.create';
  params: ChatKitThreadCreateParams;
};

export type ChatKitThreadListParams = {
  limit?: number | null;
  order?: 'asc' | 'desc';
  after?: string | null;
};

export type ChatKitThreadsListRequest = ChatKitRequestBase & {
  type: 'threads.list';
  params: ChatKitThreadListParams;
};

export type ChatKitThreadAddUserMessageParams = {
  input: ChatKitUserMessageInput;
  thread_id: string;
};

export type ChatKitThreadsAddUserMessageRequest = ChatKitRequestBase & {
  type: 'threads.add_user_message';
  params: ChatKitThreadAddUserMessageParams;
};

export type ChatKitThreadAddClientToolOutputParams = {
  thread_id: string;
  result: unknown;
};

export type ChatKitThreadsAddClientToolOutputRequest = ChatKitRequestBase & {
  type: 'threads.add_client_tool_output';
  params: ChatKitThreadAddClientToolOutputParams;
};

export type ChatKitAction = {
  type: string;
  payload?: unknown;
};

export type ChatKitThreadCustomActionParams = {
  thread_id: string;
  item_id?: string | null;
  action: ChatKitAction;
};

export type ChatKitThreadsCustomActionRequest = ChatKitRequestBase & {
  type: 'threads.custom_action';
  params: ChatKitThreadCustomActionParams;
};

export type ChatKitThreadRetryAfterItemParams = {
  thread_id: string;
  item_id: string;
};

export type ChatKitThreadsRetryAfterItemRequest = ChatKitRequestBase & {
  type: 'threads.retry_after_item';
  params: ChatKitThreadRetryAfterItemParams;
};

export type ChatKitItemFeedbackParams = {
  thread_id: string;
  item_ids: string[];
  kind: ChatKitFeedbackKind;
};

export type ChatKitItemsFeedbackRequest = ChatKitRequestBase & {
  type: 'items.feedback';
  params: ChatKitItemFeedbackParams;
};

export type ChatKitAttachmentCreateParams = {
  name: string;
  size: number;
  mime_type: string;
};

export type ChatKitAttachmentsCreateRequest = ChatKitRequestBase & {
  type: 'attachments.create';
  params: ChatKitAttachmentCreateParams;
};

export type ChatKitAttachmentDeleteParams = {
  attachment_id: string;
};

export type ChatKitAttachmentsDeleteRequest = ChatKitRequestBase & {
  type: 'attachments.delete';
  params: ChatKitAttachmentDeleteParams;
};

export type ChatKitInputTranscribeParams = {
  audio_base64: string;
  mime_type: string;
};

export type ChatKitInputTranscribeRequest = ChatKitRequestBase & {
  type: 'input.transcribe';
  params: ChatKitInputTranscribeParams;
};

export type ChatKitItemsListParams = {
  thread_id: string;
  limit?: number | null;
  order?: 'asc' | 'desc';
  after?: string | null;
};

export type ChatKitItemsListRequest = ChatKitRequestBase & {
  type: 'items.list';
  params: ChatKitItemsListParams;
};

export type ChatKitThreadUpdateParams = {
  thread_id: string;
  title: string;
};

export type ChatKitThreadsUpdateRequest = ChatKitRequestBase & {
  type: 'threads.update';
  params: ChatKitThreadUpdateParams;
};

export type ChatKitThreadDeleteParams = {
  thread_id: string;
};

export type ChatKitThreadsDeleteRequest = ChatKitRequestBase & {
  type: 'threads.delete';
  params: ChatKitThreadDeleteParams;
};

export type ChatKitStreamingRequest =
  | ChatKitThreadsCreateRequest
  | ChatKitThreadsAddUserMessageRequest
  | ChatKitThreadsAddClientToolOutputRequest
  | ChatKitThreadsRetryAfterItemRequest
  | ChatKitThreadsCustomActionRequest;

export type ChatKitNonStreamingRequest =
  | ChatKitThreadsGetByIdRequest
  | ChatKitThreadsListRequest
  | ChatKitItemsListRequest
  | ChatKitItemsFeedbackRequest
  | ChatKitAttachmentsCreateRequest
  | ChatKitAttachmentsDeleteRequest
  | ChatKitThreadsUpdateRequest
  | ChatKitThreadsDeleteRequest
  | ChatKitInputTranscribeRequest;

export type ChatKitRequest =
  | ChatKitStreamingRequest
  | ChatKitNonStreamingRequest;

export type ChatKitClientToolCallItem = {
  type: 'client_tool_call';
  id: string;
  thread_id: string;
  created_at: string;
  status: 'pending' | 'completed';
  call_id: string;
  name: string;
  arguments: Record<string, unknown>;
  output?: unknown;
};

export type ChatKitWidgetRoot = Record<string, unknown>;

export type ChatKitWidgetItem = {
  type: 'widget';
  id: string;
  thread_id: string;
  created_at: string;
  widget: ChatKitWidgetRoot;
  copy_text?: string | null;
};

export type ChatKitGeneratedImage = {
  id: string;
  url: string;
};

export type ChatKitGeneratedImageItem = {
  type: 'generated_image';
  id: string;
  thread_id: string;
  created_at: string;
  image: ChatKitGeneratedImage | null;
};

export type ChatKitTaskBase = {
  status_indicator?: 'none' | 'loading' | 'complete';
  title?: string | null;
};

export type ChatKitCustomTask = ChatKitTaskBase & {
  type: 'custom';
  icon?: string | null;
  content?: string | null;
};

export type ChatKitSearchTask = ChatKitTaskBase & {
  type: 'web_search';
  title_query?: string | null;
  queries: string[];
  sources: ChatKitUrlSource[];
};

export type ChatKitThoughtTask = ChatKitTaskBase & {
  type: 'thought';
  content: string;
};

export type ChatKitFileTask = ChatKitTaskBase & {
  type: 'file';
  sources: ChatKitFileSource[];
};

export type ChatKitImageTask = ChatKitTaskBase & {
  type: 'image';
};

export type ChatKitTask =
  | ChatKitCustomTask
  | ChatKitSearchTask
  | ChatKitThoughtTask
  | ChatKitFileTask
  | ChatKitImageTask;

export type ChatKitWorkflowSummary =
  | { title: string; icon?: string | null }
  | { duration: number };

export type ChatKitWorkflow = {
  type: 'custom' | 'reasoning';
  tasks: ChatKitTask[];
  summary?: ChatKitWorkflowSummary | null;
  expanded?: boolean;
};

export type ChatKitWorkflowItem = {
  type: 'workflow';
  id: string;
  thread_id: string;
  created_at: string;
  workflow: ChatKitWorkflow;
};

export type ChatKitTaskItem = {
  type: 'task';
  id: string;
  thread_id: string;
  created_at: string;
  task: ChatKitTask;
};

export type ChatKitEndOfTurnItem = {
  type: 'end_of_turn';
  id: string;
  thread_id: string;
  created_at: string;
};

export type ChatKitThreadItem =
  | ChatKitUserMessageItem
  | ChatKitAssistantMessageItem
  | ChatKitClientToolCallItem
  | ChatKitWidgetItem
  | ChatKitGeneratedImageItem
  | ChatKitWorkflowItem
  | ChatKitTaskItem
  | ChatKitEndOfTurnItem;

export type ChatKitThreadStatus = {
  type: 'active' | 'locked' | 'closed';
  reason?: string | null;
};

export type ChatKitThreadMetadata = {
  id: string;
  created_at: string;
  title?: string | null;
  status: ChatKitThreadStatus;
  metadata: Record<string, unknown>;
};

export type ChatKitPage<T> = {
  data: T[];
  has_more: boolean;
  after?: string | null;
};

export type ChatKitThread = ChatKitThreadMetadata & {
  items: ChatKitPage<ChatKitThreadItem>;
};

export type ChatKitAssistantMessageContentPartAdded = {
  type: 'assistant_message.content_part.added';
  content_index: number;
  content: ChatKitAssistantMessageContent;
};

export type ChatKitAssistantMessageContentPartTextDelta = {
  type: 'assistant_message.content_part.text_delta';
  content_index: number;
  delta: string;
};

export type ChatKitAssistantMessageContentPartAnnotationAdded = {
  type: 'assistant_message.content_part.annotation_added';
  content_index: number;
  annotation_index: number;
  annotation: ChatKitAnnotation;
};

export type ChatKitAssistantMessageContentPartDone = {
  type: 'assistant_message.content_part.done';
  content_index: number;
  content: ChatKitAssistantMessageContent;
};

export type ChatKitWorkflowTaskAdded = {
  type: 'workflow.task.added';
  task_index: number;
  task: ChatKitTask;
};

export type ChatKitWorkflowTaskUpdated = {
  type: 'workflow.task.updated';
  task_index: number;
  task: ChatKitTask;
};

export type ChatKitGeneratedImageUpdated = {
  type: 'generated_image.updated';
  image: ChatKitGeneratedImage;
  progress?: number | null;
};

export type ChatKitWidgetStreamingTextValueDelta = {
  type: 'widget.streaming_text.value_delta';
  component_id: string;
  delta: string;
  done: boolean;
};

export type ChatKitWidgetRootUpdated = {
  type: 'widget.root.updated';
  widget: ChatKitWidgetRoot;
};

export type ChatKitWidgetComponentUpdated = {
  type: 'widget.component.updated';
  component_id: string;
  component: Record<string, unknown>;
};

export type ChatKitThreadItemUpdate =
  | ChatKitAssistantMessageContentPartAdded
  | ChatKitAssistantMessageContentPartTextDelta
  | ChatKitAssistantMessageContentPartAnnotationAdded
  | ChatKitAssistantMessageContentPartDone
  | ChatKitWidgetStreamingTextValueDelta
  | ChatKitWidgetRootUpdated
  | ChatKitWidgetComponentUpdated
  | ChatKitWorkflowTaskAdded
  | ChatKitWorkflowTaskUpdated
  | ChatKitGeneratedImageUpdated;

export type ChatKitThreadCreatedEvent = {
  type: 'thread.created';
  thread: Record<string, unknown>;
};

export type ChatKitThreadUpdatedEvent = {
  type: 'thread.updated';
  thread: Record<string, unknown>;
};

export type ChatKitThreadItemAddedEvent = {
  type: 'thread.item.added';
  item: ChatKitThreadItem;
};

export type ChatKitThreadItemUpdatedEvent = {
  type: 'thread.item.updated';
  item_id: string;
  update: ChatKitThreadItemUpdate;
};

export type ChatKitThreadItemDoneEvent = {
  type: 'thread.item.done';
  item: ChatKitThreadItem;
};

export type ChatKitThreadItemRemovedEvent = {
  type: 'thread.item.removed';
  item_id: string;
};

export type ChatKitThreadItemReplacedEvent = {
  type: 'thread.item.replaced';
  item: ChatKitThreadItem;
};

export type ChatKitStreamOptionsEvent = {
  type: 'stream_options';
  stream_options: {
    allow_cancel: boolean;
  };
};

export type ChatKitProgressUpdateEvent = {
  type: 'progress_update';
  icon?: string | null;
  text: string;
};

export type ChatKitClientEffectEvent = {
  type: 'client_effect';
  name: string;
  data?: Record<string, unknown>;
};

export type ChatKitErrorEvent = {
  type: 'error';
  code?: string;
  message?: string | null;
  allow_retry?: boolean;
};

export type ChatKitNoticeEvent = {
  type: 'notice';
  level: 'info' | 'warning' | 'danger';
  message: string;
  title?: string | null;
};

export type ChatKitThreadStreamEvent =
  | ChatKitThreadCreatedEvent
  | ChatKitThreadUpdatedEvent
  | ChatKitThreadItemDoneEvent
  | ChatKitThreadItemAddedEvent
  | ChatKitThreadItemUpdatedEvent
  | ChatKitThreadItemRemovedEvent
  | ChatKitThreadItemReplacedEvent
  | ChatKitStreamOptionsEvent
  | ChatKitProgressUpdateEvent
  | ChatKitClientEffectEvent
  | ChatKitErrorEvent
  | ChatKitNoticeEvent;

export type ChatKitStreamSource =
  | StreamedRunResult<any, any>
  | AsyncIterable<RunStreamEvent>
  | ReadableStream<RunStreamEvent>
  | { toStream: () => ReadableStream<RunStreamEvent> };

export type ChatKitSseSource =
  | AsyncIterable<ChatKitThreadStreamEvent>
  | ReadableStream<ChatKitThreadStreamEvent>
  | { toStream: () => ReadableStream<ChatKitThreadStreamEvent> };

export type ChatKitTextMessageOptions = {
  threadId?: string;
  itemId?: string;
  createdAt?: string | Date;
  annotations?: ChatKitAnnotation[];
};

export type ChatKitStreamOptions = {
  threadId?: string;
  createdAt?: string | Date;
  includeStreamOptions?: boolean;
  allowCancel?: boolean;
  converter?: ChatKitResponseStreamConverter;
};

export type ChatKitSseResponseOptions = {
  headers?: Headers | Record<string, string> | Array<[string, string]>;
  status?: number;
  statusText?: string;
};
