import { RuntimeEventEmitter, Usage, UserError } from '@openai/agents-core';
import { randomUUID } from '@openai/agents-core/_shims';
import { normalizeHostedMcpRequireApproval } from '@openai/agents-core/utils';
import {
  logModelActionError,
  logToolActionError,
} from '@openai/agents-core/utils/internal';
import type { MessageEvent as WebSocketMessageEvent } from 'ws';

import {
  RealtimeClientMessage,
  RealtimeSessionConfig,
  RealtimeSessionConfigDefinition,
  RealtimeTracingConfig,
  RealtimeTurnDetectionConfig,
  RealtimeTurnDetectionConfigAsIs,
  RealtimeUserInput,
  toNewSessionConfig,
} from './clientMessages';
import {
  RealtimeItem,
  RealtimeMessageItem,
  RealtimeToolCallItem,
  realtimeMcpCallApprovalRequestItem,
  RealtimeMcpCallApprovalRequestItem,
  realtimeMcpCallItem,
  realtimeMessageItemSchema,
  realtimeToolCallItem,
} from './items';
import logger from './logger';
import {
  parseRealtimeEvent,
  responseDoneEventSchema,
} from './openaiRealtimeEvents';
import {
  ApiKey,
  RealtimeTransportLayer,
  RealtimeTransportLayerConnectOptions,
} from './transportLayer';
import {
  RealtimeTransportEventTypes,
  TransportToolCallEvent,
} from './transportLayerEvents';
import { arrayBufferToBase64, diffRealtimeHistory } from './utils';
import { EventEmitterDelegate } from '@openai/agents-core/utils';

/**
 * The models that are supported by the OpenAI Realtime API.
 */
export type OpenAIRealtimeModels =
  | 'gpt-realtime'
  | 'gpt-realtime-1.5'
  | 'gpt-realtime-2'
  | 'gpt-realtime-2.1'
  | 'gpt-realtime-2.1-mini'
  | 'gpt-realtime-2025-08-28'
  | 'gpt-4o-realtime-preview'
  | 'gpt-4o-realtime-preview-2024-10-01'
  | 'gpt-4o-realtime-preview-2024-12-17'
  | 'gpt-4o-realtime-preview-2025-06-03'
  | 'gpt-4o-mini-realtime-preview'
  | 'gpt-4o-mini-realtime-preview-2024-12-17'
  | 'gpt-realtime-mini'
  | 'gpt-realtime-mini-2025-10-06'
  | 'gpt-realtime-mini-2025-12-15'
  | (string & {}); // ensures autocomplete works

/**
 * The default model that is used during the connection if no model is provided.
 */
export const DEFAULT_OPENAI_REALTIME_MODEL: OpenAIRealtimeModels =
  'gpt-realtime-2.1';

/**
 * The default session config that gets send over during session connection unless overridden
 * by the user.
 */
export const DEFAULT_OPENAI_REALTIME_SESSION_CONFIG: Partial<RealtimeSessionConfigDefinition> =
  {
    outputModalities: ['audio'],
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        transcription: { model: 'gpt-4o-mini-transcribe' },
        turnDetection: { type: 'semantic_vad' },
        noiseReduction: null,
      },
      output: {
        format: { type: 'audio/pcm', rate: 24000 },
        speed: 1,
      },
    },
  };

/**
 * The options for the OpenAI Realtime transport layer.
 */
export type OpenAIRealtimeBaseOptions = {
  /**
   * The model to used during the connection.
   */
  model?: OpenAIRealtimeModels;
  /**
   * The API key to use for the connection.
   */
  apiKey?: ApiKey;
};

/**
 * The events that are emitted by the OpenAI Realtime transport layer.
 */
export type OpenAIRealtimeEventTypes = {
  /**
   * Triggered when the connection is established.
   */
  connected: [];
  /**
   * Triggered when the connection is closed.
   */
  disconnected: [];
} & RealtimeTransportEventTypes;

/**
 * Shape of the payload that the Realtime API expects for session.create/update operations.
 * This closely mirrors the REST `CallAcceptParams` type so that callers can feed the payload
 * directly into the `openai.realtime.calls.accept` helper without casts.
 */
export type RealtimeSessionPayload = { type: 'realtime' } & Record<string, any>;

function normalizeRealtimeMessageContent(
  role: string | undefined,
  content: unknown,
): unknown {
  if (role !== 'assistant' || !Array.isArray(content)) {
    return content;
  }
  return content.map((part) => {
    if (
      part &&
      typeof part === 'object' &&
      'type' in part &&
      part.type === 'audio'
    ) {
      return {
        ...part,
        type: 'output_audio',
      };
    }
    return part;
  });
}

function cloneRealtimeEvent<T>(event: T): T {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(event);
  }

  return JSON.parse(JSON.stringify(event)) as T;
}

function createFunctionCallOutputItemId(): string {
  return `fco_${randomUUID().replace(/-/g, '').slice(0, 28)}`;
}

function createHistoryReplayEventId(): string {
  return `history_${randomUUID().replace(/-/g, '')}`;
}

function withoutFunctionCallOutput(
  item: RealtimeToolCallItem,
): RealtimeToolCallItem {
  const { outputItemId: _outputItemId, ...itemWithoutOutputId } = item;
  return realtimeToolCallItem.parse({
    ...itemWithoutOutputId,
    status: item.status === 'completed' ? 'in_progress' : item.status,
    output: null,
  });
}

function isFunctionCallOutputCompletion(
  oldItem: RealtimeItem | undefined,
  updatedItem: RealtimeItem,
): oldItem is RealtimeToolCallItem {
  return (
    oldItem?.type === 'function_call' &&
    updatedItem.type === 'function_call' &&
    oldItem.status === 'in_progress' &&
    oldItem.output === null &&
    oldItem.outputItemId === undefined &&
    updatedItem.status === 'completed' &&
    updatedItem.output !== null &&
    oldItem.itemId === updatedItem.itemId &&
    oldItem.previousItemId === updatedItem.previousItemId &&
    oldItem.callId === updatedItem.callId &&
    oldItem.name === updatedItem.name &&
    oldItem.arguments === updatedItem.arguments
  );
}

function assertUniqueFunctionCallOutputItemIds(
  history: RealtimeItem[],
  description: 'current' | 'updated',
  additionalOutputItems: Pick<
    RealtimeToolCallItem,
    'itemId' | 'outputItemId'
  >[] = [],
): void {
  const visibleItemIds = new Set(history.map((item) => item.itemId));
  const outputItemOwners = new Map<string, string>();
  const assertOutputItemId = (
    item: Pick<RealtimeToolCallItem, 'itemId' | 'outputItemId'>,
    allowExistingOwner: boolean,
  ) => {
    if (item.outputItemId === undefined) {
      return;
    }
    if (visibleItemIds.has(item.outputItemId)) {
      throw new UserError(
        `Function call output item ${item.outputItemId} conflicts with a visible item ID in the ${description} history.`,
      );
    }
    const existingOwner = outputItemOwners.get(item.outputItemId);
    if (existingOwner !== undefined) {
      if (allowExistingOwner && existingOwner === item.itemId) {
        return;
      }
      throw new UserError(
        `Function call output item ${item.outputItemId} appears more than once in the ${description} history.`,
      );
    }
    outputItemOwners.set(item.outputItemId, item.itemId);
  };
  for (const item of history) {
    if (item.type === 'function_call') {
      assertOutputItemId(item, false);
    }
  }
  for (const item of additionalOutputItems) {
    assertOutputItemId(item, true);
  }
}

type PendingHistoryReplayCreate = {
  kind: 'create';
  itemId: string;
  item: RealtimeMessageItem | RealtimeToolCallItem;
  projected: boolean;
};

type PendingHistoryCallDeletion = {
  itemWithoutOutput: RealtimeToolCallItem;
};

type PendingHistoryReplayDelete = {
  kind: 'delete';
  itemId: string;
  projection:
    | { kind: 'item'; itemId: string }
    | { kind: 'call_output'; deletion: PendingHistoryCallDeletion }
    | { kind: 'call'; deletion: PendingHistoryCallDeletion };
};

type PendingHistoryReplayAck =
  PendingHistoryReplayCreate | PendingHistoryReplayDelete;

type PendingHistoryReplay = {
  message: RealtimeMessageItem | undefined;
  call: RealtimeToolCallItem | undefined;
  output: RealtimeToolCallItem | undefined;
};

export abstract class OpenAIRealtimeBase
  extends EventEmitterDelegate<OpenAIRealtimeEventTypes>
  implements RealtimeTransportLayer
{
  #model: string;
  #apiKey: ApiKey | undefined;
  #tracingConfig: RealtimeTracingConfig | null = null;
  #rawSessionConfig: Record<string, any> | null = null;
  #pendingHistoryReplayAcks = new Map<string, PendingHistoryReplayAck>();
  #pendingHistoryReplayCreates = new Map<string, string[]>();
  #pendingHistoryReplayDeletes = new Map<string, string[]>();
  #confirmedFunctionCallOutputIds = new Map<string, string>();

  protected eventEmitter: RuntimeEventEmitter<OpenAIRealtimeEventTypes> =
    new RuntimeEventEmitter<OpenAIRealtimeEventTypes>();

  constructor(options: OpenAIRealtimeBaseOptions = {}) {
    super();
    this.#model = options.model ?? DEFAULT_OPENAI_REALTIME_MODEL;
    this.#apiKey = options.apiKey;
  }

  /**
   * The current model that is being used by the transport layer.
   */
  get currentModel() {
    return this.#model;
  }

  /**
   * The current model that is being used by the transport layer.
   * **Note**: The model cannot be changed mid conversation.
   */
  set currentModel(model: OpenAIRealtimeModels) {
    this.#model = model;
  }

  abstract get status():
    'connected' | 'disconnected' | 'connecting' | 'disconnecting';

  abstract connect(
    options: RealtimeTransportLayerConnectOptions,
  ): Promise<void>;

  abstract sendEvent(event: RealtimeClientMessage): void;

  abstract mute(muted: boolean): void;

  abstract close(): void;

  abstract interrupt(): void;

  abstract readonly muted: boolean | null;

  /**
   * Hook for subclasses to clean up transport-specific state when audio
   * playback finishes. Defaults to a no-op.
   */
  protected _afterAudioDoneEvent(): void {
    // Intentionally empty.
  }

  protected get _rawSessionConfig(): Record<string, any> | null {
    return this.#rawSessionConfig ?? null;
  }

  protected async _getApiKey(options: RealtimeTransportLayerConnectOptions) {
    const apiKey = options.apiKey ?? this.#apiKey;

    if (typeof apiKey === 'function') {
      return await apiKey();
    }

    return apiKey;
  }

  protected _onMessage(event: MessageEvent | WebSocketMessageEvent): void {
    const result = parseRealtimeEvent(event);
    if (result.data === null) {
      return;
    }
    const { data: parsed, raw, isGeneric } = result;

    this.emit('*', cloneRealtimeEvent(raw));
    if (isGeneric) {
      return;
    }

    if (parsed.type === 'error') {
      const failedEventId =
        typeof parsed.error?.event_id === 'string'
          ? parsed.error.event_id
          : parsed.error?.code === 'invalid_tool_call_id'
            ? this.#getOldestPendingFunctionCallOutputEventId()
            : undefined;
      if (typeof failedEventId === 'string') {
        this.#rejectPendingHistoryReplayAck(failedEventId);
      }
      this.emit('error', { type: 'error', error: parsed });
    } else {
      this.emit(parsed.type, parsed);
    }

    if (parsed.type === 'response.created') {
      this.emit('turn_started', {
        type: 'response_started',
        providerData: {
          ...parsed,
        },
      });
      return;
    }

    if (parsed.type === 'session.updated') {
      this.#rawSessionConfig = parsed.session;
    }

    if (parsed.type === 'response.done') {
      const response = responseDoneEventSchema.safeParse(parsed);
      if (!response.success) {
        logModelActionError(
          logger,
          'Error parsing response done event',
          response.error,
        );
        return;
      }
      const inputTokens = response.data.response.usage?.input_tokens ?? 0;
      const outputTokens = response.data.response.usage?.output_tokens ?? 0;
      const totalTokens = inputTokens + outputTokens;
      const usage = new Usage({
        inputTokens,
        inputTokensDetails:
          response.data.response.usage?.input_token_details ?? {},
        outputTokens,
        outputTokensDetails:
          response.data.response.usage?.output_token_details ?? {},
        totalTokens,
      });
      this.emit('usage_update', usage);
      this.emit('turn_done', {
        type: 'response_done',
        response: {
          id: response.data.response.id ?? '',
          output: response.data.response.output ?? [],
          usage: {
            inputTokens,
            inputTokensDetails:
              response.data.response.usage?.input_token_details ?? {},
            outputTokens,
            outputTokensDetails:
              response.data.response.usage?.output_token_details ?? {},
            totalTokens,
          },
        },
      });
      return;
    }

    if (parsed.type === 'response.output_audio.done') {
      this.emit('audio_done');
      this._afterAudioDoneEvent();
      return;
    }

    if (parsed.type === 'conversation.item.deleted') {
      this.#forgetConfirmedFunctionCallOutput(parsed.item_id);
      if (this.#consumePendingHistoryReplayDelete(parsed.item_id)) {
        return;
      }
      this.emit('item_deleted', {
        itemId: parsed.item_id,
      });
      return;
    }

    if (
      parsed.type === 'conversation.item.input_audio_transcription.completed' ||
      parsed.type === 'conversation.item.truncated'
    ) {
      // right now rather than keeping track of partials and rebuilding the item we
      // will retrieve it instead which triggers the `conversation.item.retrieved` event below
      this.sendEvent({
        type: 'conversation.item.retrieve',
        item_id: parsed.item_id,
      });
      return;
    }

    if (
      parsed.type === 'conversation.item.input_audio_transcription.delta' ||
      parsed.type === 'response.output_text.delta' ||
      parsed.type === 'response.output_audio_transcript.delta' ||
      parsed.type === 'response.function_call_arguments.delta'
    ) {
      if (parsed.type === 'response.output_audio_transcript.delta') {
        this.emit('audio_transcript_delta', {
          type: 'transcript_delta',
          delta: parsed.delta,
          itemId: parsed.item_id,
          responseId: parsed.response_id,
        });
      } else if (parsed.type === 'response.output_text.delta') {
        this.emit('output_text_delta', {
          type: 'output_text_delta',
          delta: parsed.delta,
          itemId: parsed.item_id,
          responseId: parsed.response_id,
        });
      }
      // no support for partial transcripts yet.
      return;
    }

    if (
      parsed.type === 'conversation.item.added' ||
      parsed.type === 'conversation.item.done' ||
      parsed.type === 'conversation.item.retrieved'
    ) {
      if (
        parsed.type !== 'conversation.item.retrieved' &&
        typeof parsed.item.id === 'string' &&
        this.#consumePendingHistoryReplayCreate(parsed.item.id, parsed.type)
      ) {
        return;
      }
      // Handle MCP list tools items (only act when done to ensure tools are present)
      if (
        parsed.item.type === 'mcp_list_tools' &&
        parsed.type === 'conversation.item.done'
      ) {
        const serverLabel = parsed.item.server_label ?? '';
        const tools = (parsed.item.tools ?? []) as any[];
        try {
          this.emit('mcp_tools_listed', {
            serverLabel,
            tools,
          });
        } catch (err) {
          logToolActionError(
            logger,
            'Error emitting mcp_tools_listed',
            err,
            parsed.item,
          );
        }
        // We do not add this item to history; it's a transport-level side-channel.
        return;
      }
      if (parsed.item.type === 'message') {
        const previousItemId =
          parsed.type === 'conversation.item.added' ||
          parsed.type === 'conversation.item.done'
            ? parsed.previous_item_id
            : null;
        const item = realtimeMessageItemSchema.parse({
          itemId: parsed.item.id,
          previousItemId,
          type: parsed.item.type,
          role: parsed.item.role,
          content: normalizeRealtimeMessageContent(
            parsed.item.role,
            parsed.item.content,
          ),
          status:
            parsed.item.status ??
            (parsed.type === 'conversation.item.added'
              ? 'in_progress'
              : 'completed'),
        });
        this.emit('item_update', item);
        return;
      }

      if (
        parsed.item.type === 'mcp_approval_request' &&
        parsed.type === 'conversation.item.done'
      ) {
        const item = parsed.item;
        const mcpApprovalRequest = realtimeMcpCallApprovalRequestItem.parse({
          itemId: item.id,
          type: item.type,
          serverLabel: item.server_label,
          name: item.name,
          arguments: JSON.parse(item.arguments || '{}'),
          approved: item.approved,
        });
        this.emit('item_update', mcpApprovalRequest);
        this.emit('mcp_approval_request', mcpApprovalRequest);
        return;
      }

      if (
        parsed.item.type === 'mcp_tool_call' ||
        parsed.item.type === 'mcp_call'
      ) {
        const status =
          parsed.type === 'conversation.item.done'
            ? 'completed'
            : 'in_progress';
        const mcpCall = realtimeMcpCallItem.parse({
          itemId: parsed.item.id,
          type: parsed.item.type,
          status,
          arguments: parsed.item.arguments,
          name: parsed.item.name,
          output: parsed.item.output,
        });

        this.emit('item_update', mcpCall);
        if (parsed.type === 'conversation.item.done') {
          this.emit('mcp_tool_call_completed', mcpCall);
        }
        return;
      }
    }

    if (parsed.type === 'response.mcp_call.in_progress') {
      const item = parsed;
      this.sendEvent({
        type: 'conversation.item.retrieve',
        item_id: item.item_id,
      });
      return;
    }
    if (parsed.type === 'mcp_list_tools.in_progress') {
      const item = parsed;
      if (item.item_id) {
        this.sendEvent({
          type: 'conversation.item.retrieve',
          item_id: item.item_id,
        });
      }
      return;
    }

    if (
      parsed.type === 'response.output_item.done' ||
      parsed.type === 'response.output_item.added'
    ) {
      const item = parsed.item;
      if (item.type === 'function_call' && item.status === 'completed') {
        const toolCall = realtimeToolCallItem.parse({
          itemId: item.id,
          callId: item.call_id,
          type: item.type,
          status: 'in_progress', // we set it to in_progress for the UI as it will only be completed with the output
          arguments: item.arguments,
          name: item.name,
          output: null,
        });
        this.emit('item_update', toolCall);
        this.emit('function_call', {
          id: item.id,
          type: 'function_call',
          callId: item.call_id ?? '',
          arguments: item.arguments ?? '',
          name: item.name ?? '',
          responseId: parsed.response_id,
        });
        return;
      }

      if (item.type === 'mcp_tool_call' || item.type === 'mcp_call') {
        const mcpCall = realtimeMcpCallItem.parse({
          itemId: item.id,
          type: item.type,
          status:
            parsed.type === 'response.output_item.done'
              ? 'completed'
              : 'in_progress', // we set it to in_progress for the UI as it will only be completed with the output
          arguments: item.arguments,
          name: item.name,
          output: item.output,
        });
        this.emit('item_update', mcpCall);
        return;
      }

      if (item.type === 'message') {
        const realtimeItem = realtimeMessageItemSchema.parse({
          itemId: parsed.item.id,
          type: parsed.item.type,
          role: parsed.item.role,
          content: normalizeRealtimeMessageContent(
            parsed.item.role,
            parsed.item.content,
          ),
          status:
            parsed.type === 'response.output_item.done'
              ? (item.status ?? 'completed')
              : (item.status ?? 'in_progress'),
        });
        this.emit('item_update', realtimeItem);
        return;
      }
    }
  }

  protected _onError(error: any) {
    this.emit('error', {
      type: 'error',
      error,
    });
  }

  protected _onOpen() {
    this.emit('connected');
  }

  protected _onClose() {
    this.#clearPendingHistoryReplayAcks();
    this.emit('disconnected');
  }

  #registerPendingHistoryReplayAck(
    eventId: string,
    pendingAck: PendingHistoryReplayAck,
  ): void {
    this.#pendingHistoryReplayAcks.set(eventId, pendingAck);
    if (pendingAck.kind === 'create') {
      const pendingCreates =
        this.#pendingHistoryReplayCreates.get(pendingAck.itemId) ?? [];
      pendingCreates.push(eventId);
      this.#pendingHistoryReplayCreates.set(pendingAck.itemId, pendingCreates);
      return;
    }

    const pendingDeletes =
      this.#pendingHistoryReplayDeletes.get(pendingAck.itemId) ?? [];
    pendingDeletes.push(eventId);
    this.#pendingHistoryReplayDeletes.set(pendingAck.itemId, pendingDeletes);
  }

  #removePendingHistoryReplayAck(eventId: string): void {
    const pendingAck = this.#pendingHistoryReplayAcks.get(eventId);
    if (pendingAck === undefined) {
      return;
    }
    this.#pendingHistoryReplayAcks.delete(eventId);

    if (pendingAck.kind === 'create') {
      const pendingCreates = this.#pendingHistoryReplayCreates.get(
        pendingAck.itemId,
      );
      if (pendingCreates === undefined) {
        return;
      }
      const remainingCreates = pendingCreates.filter(
        (pendingCreateEventId) => pendingCreateEventId !== eventId,
      );
      if (remainingCreates.length === 0) {
        this.#pendingHistoryReplayCreates.delete(pendingAck.itemId);
      } else {
        this.#pendingHistoryReplayCreates.set(
          pendingAck.itemId,
          remainingCreates,
        );
      }
      return;
    }

    const pendingDeletes = this.#pendingHistoryReplayDeletes.get(
      pendingAck.itemId,
    );
    if (pendingDeletes === undefined) {
      return;
    }
    const remainingDeletes = pendingDeletes.filter(
      (pendingDeleteEventId) => pendingDeleteEventId !== eventId,
    );
    if (remainingDeletes.length === 0) {
      this.#pendingHistoryReplayDeletes.delete(pendingAck.itemId);
    } else {
      this.#pendingHistoryReplayDeletes.set(
        pendingAck.itemId,
        remainingDeletes,
      );
    }
  }

  #consumePendingHistoryReplayDelete(itemId: string): boolean {
    const pendingEventId = this.#pendingHistoryReplayDeletes.get(itemId)?.[0];
    if (pendingEventId === undefined) {
      return false;
    }
    const pendingAck = this.#pendingHistoryReplayAcks.get(pendingEventId);
    if (pendingAck?.kind !== 'delete') {
      return false;
    }
    this.#retireProjectedHistoryReplayCreates(itemId);
    if (pendingAck.projection.kind === 'item') {
      this.emit('item_deleted', { itemId: pendingAck.projection.itemId });
    } else if (pendingAck.projection.kind === 'call_output') {
      const deletion = pendingAck.projection.deletion;
      this.#removePendingHistoryReplayAck(pendingEventId);
      const callDeleteEvent = this.#registerPendingHistoryCallDelete(deletion);
      try {
        this.emit('item_update', deletion.itemWithoutOutput);
        this.sendEvent(callDeleteEvent);
      } catch (error) {
        this.#rejectPendingHistoryReplayAck(callDeleteEvent.event_id);
        throw error;
      }
      return true;
    } else {
      this.emit('item_deleted', {
        itemId: pendingAck.projection.deletion.itemWithoutOutput.itemId,
      });
    }
    this.#removePendingHistoryReplayAck(pendingEventId);
    return true;
  }

  #retireProjectedHistoryReplayCreates(itemId: string): void {
    const pendingEventIds = [
      ...(this.#pendingHistoryReplayCreates.get(itemId) ?? []),
    ];
    for (const eventId of pendingEventIds) {
      const pendingAck = this.#pendingHistoryReplayAcks.get(eventId);
      if (pendingAck?.kind === 'create' && pendingAck.projected) {
        this.#removePendingHistoryReplayAck(eventId);
      }
    }
  }

  #consumePendingHistoryReplayCreate(
    itemId: string,
    eventType: 'conversation.item.added' | 'conversation.item.done',
  ): boolean {
    const pendingEventId = this.#pendingHistoryReplayCreates.get(itemId)?.[0];
    if (pendingEventId === undefined) {
      return false;
    }
    const pendingAck = this.#pendingHistoryReplayAcks.get(pendingEventId);
    if (pendingAck?.kind !== 'create') {
      return false;
    }
    if (!pendingAck.projected) {
      pendingAck.projected = true;
      this.emit('item_update', pendingAck.item);
    }
    if (eventType === 'conversation.item.done') {
      if (
        pendingAck.item.type === 'function_call' &&
        pendingAck.item.output !== null &&
        pendingAck.item.outputItemId === pendingAck.itemId
      ) {
        this.#confirmedFunctionCallOutputIds.set(
          pendingAck.item.itemId,
          pendingAck.itemId,
        );
      }
      this.#removePendingHistoryReplayAck(pendingEventId);
    }
    return true;
  }

  #rejectPendingHistoryReplayAck(eventId: string): void {
    const pendingAck = this.#pendingHistoryReplayAcks.get(eventId);
    if (pendingAck === undefined) {
      return;
    }
    const rejectedFunctionCallOutput =
      pendingAck.kind === 'create' &&
      pendingAck.projected &&
      pendingAck.item.type === 'function_call' &&
      pendingAck.item.output !== null &&
      pendingAck.item.outputItemId === pendingAck.itemId
        ? pendingAck.item
        : undefined;
    this.#removePendingHistoryReplayAck(eventId);
    if (rejectedFunctionCallOutput !== undefined) {
      this.emit(
        'item_update',
        withoutFunctionCallOutput(rejectedFunctionCallOutput),
      );
    }
  }

  #clearPendingHistoryReplayAcks(): void {
    this.#pendingHistoryReplayAcks.clear();
    this.#pendingHistoryReplayCreates.clear();
    this.#pendingHistoryReplayDeletes.clear();
    this.#confirmedFunctionCallOutputIds.clear();
  }

  #hasOwnedFunctionCallOutput(itemId: string): boolean {
    if (this.#confirmedFunctionCallOutputIds.has(itemId)) {
      return true;
    }
    for (const pendingAck of this.#pendingHistoryReplayAcks.values()) {
      if (
        pendingAck.kind === 'create' &&
        pendingAck.item.type === 'function_call' &&
        pendingAck.item.itemId === itemId &&
        pendingAck.item.output !== null &&
        pendingAck.item.outputItemId === pendingAck.itemId
      ) {
        return true;
      }
    }
    return false;
  }

  #forgetConfirmedFunctionCallOutput(itemId: string): void {
    this.#confirmedFunctionCallOutputIds.delete(itemId);
    for (const [callItemId, outputItemId] of this
      .#confirmedFunctionCallOutputIds) {
      if (outputItemId === itemId) {
        this.#confirmedFunctionCallOutputIds.delete(callItemId);
        return;
      }
    }
  }

  #getPendingHistoryReplay(itemId: string): PendingHistoryReplay {
    let message: RealtimeMessageItem | undefined;
    let call: RealtimeToolCallItem | undefined;
    let output: RealtimeToolCallItem | undefined;
    for (const pendingAck of this.#pendingHistoryReplayAcks.values()) {
      if (pendingAck.kind !== 'create' || pendingAck.projected) {
        continue;
      }
      if (
        pendingAck.item.type === 'message' &&
        pendingAck.item.itemId === itemId
      ) {
        message ??= pendingAck.item;
      } else if (
        pendingAck.item.type === 'function_call' &&
        pendingAck.item.itemId === itemId
      ) {
        if (pendingAck.itemId === itemId && pendingAck.item.output === null) {
          call ??= pendingAck.item;
        } else if (
          pendingAck.item.output !== null &&
          pendingAck.item.outputItemId === pendingAck.itemId
        ) {
          output ??= pendingAck.item;
        }
      }
    }
    return { message, call, output };
  }

  #getOldestPendingFunctionCallOutputEventId(): string | undefined {
    for (const [eventId, pendingAck] of this.#pendingHistoryReplayAcks) {
      if (
        pendingAck.kind === 'create' &&
        pendingAck.item.type === 'function_call' &&
        pendingAck.item.output !== null &&
        pendingAck.item.outputItemId === pendingAck.itemId
      ) {
        return eventId;
      }
    }
    return undefined;
  }

  #hasPendingFunctionCallDeletion(itemId: string): boolean {
    const pendingEventId = this.#pendingHistoryReplayDeletes.get(itemId)?.[0];
    if (pendingEventId === undefined) {
      return false;
    }
    const pendingAck = this.#pendingHistoryReplayAcks.get(pendingEventId);
    return (
      pendingAck?.kind === 'delete' &&
      pendingAck.projection.kind === 'call' &&
      pendingAck.projection.deletion.itemWithoutOutput.itemId === itemId
    );
  }

  #sendHistoryReplayEvent(
    event: RealtimeClientMessage & { event_id: string },
    pendingAck: PendingHistoryReplayAck,
  ): void {
    this.#registerPendingHistoryReplayAck(event.event_id, pendingAck);
    try {
      this.sendEvent(event);
    } catch (error) {
      this.#rejectPendingHistoryReplayAck(event.event_id);
      throw error;
    }
  }

  #registerPendingHistoryCallDelete(
    deletion: PendingHistoryCallDeletion,
  ): RealtimeClientMessage & { event_id: string } {
    const eventId = createHistoryReplayEventId();
    const itemId = deletion.itemWithoutOutput.itemId;
    const event = {
      type: 'conversation.item.delete' as const,
      event_id: eventId,
      item_id: itemId,
    };
    this.#registerPendingHistoryReplayAck(eventId, {
      kind: 'delete',
      itemId,
      projection: { kind: 'call', deletion },
    });
    return event;
  }

  requestResponse(response?: Record<string, any>): void {
    this.sendEvent({
      type: 'response.create',
      ...(response ? { response } : {}),
    });
  }

  /**
   * Send a message to the Realtime API. This will create a new item in the conversation and
   * trigger a response.
   *
   * @param message - The message to send.
   * @param otherEventData - Additional event data to send.
   */
  sendMessage(
    message: RealtimeUserInput,
    otherEventData: Record<string, any>,
    { triggerResponse = true }: { triggerResponse?: boolean } = {},
  ) {
    const content =
      typeof message === 'string'
        ? [
            {
              type: 'input_text',
              text: message,
            },
          ]
        : message.content.map((content) => {
            if (content.type === 'input_image') {
              return {
                type: 'input_image',
                image_url: content.image,
                ...(content.providerData ?? {}),
              };
            }
            return content;
          });

    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content,
      },
      ...otherEventData,
    });

    if (triggerResponse) {
      this.requestResponse();
    }
  }

  addImage(
    image: string,
    { triggerResponse = true }: { triggerResponse?: boolean } = {},
  ) {
    this.sendMessage(
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image }],
      },
      {},
      { triggerResponse },
    );
  }

  protected _getMergedSessionConfig(
    config: Partial<RealtimeSessionConfig>,
  ): RealtimeSessionPayload {
    const newConfig = toNewSessionConfig(config);

    const noiseReductionOverride = newConfig.audio?.input?.noiseReduction;
    const transcriptionOverride = newConfig.audio?.input?.transcription;
    const turnDetectionOverride = OpenAIRealtimeBase.buildTurnDetectionConfig(
      newConfig.audio?.input?.turnDetection,
    );

    const sessionData: RealtimeSessionPayload = {
      type: 'realtime',
      instructions: newConfig.instructions,
      model: newConfig.model ?? this.#model,
      output_modalities:
        newConfig.outputModalities ??
        DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.outputModalities,
      audio: {
        input: {
          format:
            newConfig.audio?.input?.format ??
            DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.audio?.input?.format,
          noise_reduction:
            noiseReductionOverride === undefined
              ? DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.audio?.input
                  ?.noiseReduction
              : noiseReductionOverride,
          transcription:
            transcriptionOverride === undefined
              ? DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.audio?.input
                  ?.transcription
              : transcriptionOverride,
          turn_detection:
            turnDetectionOverride === undefined
              ? DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.audio?.input
                  ?.turnDetection
              : turnDetectionOverride,
        },
        output: {
          format:
            newConfig.audio?.output?.format ??
            DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.audio?.output?.format,
          voice:
            newConfig.audio?.output?.voice ??
            DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.audio?.output?.voice,
          speed:
            newConfig.audio?.output?.speed ??
            DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.audio?.output?.speed,
        },
      },
      tool_choice:
        newConfig.toolChoice ??
        DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.toolChoice,
      ...(typeof newConfig.parallelToolCalls === 'undefined'
        ? {}
        : { parallel_tool_calls: newConfig.parallelToolCalls }),
      ...(newConfig.reasoning ? { reasoning: newConfig.reasoning } : {}),
      // We don't set tracing here to make sure that we don't try to override it on every
      // session.update as it might lead to errors
      ...(newConfig.providerData ?? {}),
    };

    if (newConfig.prompt) {
      sessionData.prompt = {
        id: newConfig.prompt.promptId,
        version: newConfig.prompt.version,
        variables: newConfig.prompt.variables,
      };
    }

    if (newConfig.tools && newConfig.tools.length > 0) {
      sessionData.tools = newConfig.tools.map((tool: any) => {
        const pickDefined = (obj: Record<string, any>) =>
          Object.fromEntries(
            Object.entries(obj).filter(
              ([, value]) => typeof value !== 'undefined',
            ),
          );

        if (tool.type === 'mcp') {
          // Realtime API MCP tool shape: session.update properties and MCP tool headers
          return pickDefined({
            type: 'mcp',
            server_label: tool.server_label,
            server_url: tool.server_url,
            server_description: tool.server_description,
            connector_id: tool.connector_id,
            authorization: tool.authorization,
            headers: tool.headers,
            allowed_tools: tool.allowed_tools,
            require_approval:
              typeof tool.require_approval === 'undefined'
                ? undefined
                : normalizeHostedMcpRequireApproval(tool.require_approval),
          });
        }

        // Realtime API function tool shape: keep only documented fields for session.update.
        return pickDefined({
          type: tool.type,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        });
      });
    }

    return sessionData;
  }

  /**
   * Build the payload object expected by the Realtime API when creating or updating a session.
   *
   * The helper centralises the conversion from camelCase runtime config to the snake_case payload
   * required by the Realtime API so transports that need a one-off payload (for example SIP call
   * acceptance) can reuse the same logic without duplicating private state.
   *
   * @param config - The session config to merge with defaults.
   */
  buildSessionPayload(
    config: Partial<RealtimeSessionConfig>,
  ): RealtimeSessionPayload {
    return this._getMergedSessionConfig(config);
  }

  private static buildTurnDetectionConfig(
    c: RealtimeTurnDetectionConfig | null | undefined,
  ): RealtimeTurnDetectionConfigAsIs | null | undefined {
    if (typeof c === 'undefined') {
      return undefined;
    }
    if (c === null) {
      return null;
    }
    const {
      type,
      createResponse,
      create_response,
      eagerness,
      interruptResponse,
      interrupt_response,
      prefixPaddingMs,
      prefix_padding_ms,
      silenceDurationMs,
      silence_duration_ms,
      threshold,
      idleTimeoutMs,
      idle_timeout_ms,
      modelVersion,
      model_version,
      ...rest
    } = c;

    const config: RealtimeTurnDetectionConfigAsIs & Record<string, any> = {
      type,
      create_response: createResponse ?? create_response,
      eagerness,
      interrupt_response: interruptResponse ?? interrupt_response,
      prefix_padding_ms: prefixPaddingMs ?? prefix_padding_ms,
      silence_duration_ms: silenceDurationMs ?? silence_duration_ms,
      idle_timeout_ms: idleTimeoutMs ?? idle_timeout_ms,
      model_version: modelVersion ?? model_version,
      threshold,
      ...rest,
    };
    // Remove undefined values from the config
    Object.keys(config).forEach((key) => {
      if (config[key] === undefined) delete config[key];
    });
    return Object.keys(config).length > 0 ? config : undefined;
  }

  /**
   * Sets the internal tracing config. This is used to track the tracing config that has been set
   * during the session.create event.
   */
  set _tracingConfig(tracingConfig: RealtimeTracingConfig | null) {
    this.#tracingConfig = tracingConfig;
  }

  /**
   * Sets the tracing config for the session. This will send the tracing config to the Realtime API.
   *
   * @param tracingConfig - The tracing config to set. We don't support 'auto' here as the SDK will always configure a Workflow Name unless it exists
   */
  protected _updateTracingConfig(tracingConfig: RealtimeTracingConfig | null) {
    if (typeof this.#tracingConfig === 'undefined') {
      // treating it as default value
      this.#tracingConfig = null;
    }

    if (tracingConfig === 'auto') {
      // turn on tracing in auto mode
      this.sendEvent({
        type: 'session.update',
        session: {
          type: 'realtime',
          tracing: 'auto',
        },
      });
      return;
    }

    if (
      this.#tracingConfig !== null &&
      typeof this.#tracingConfig !== 'string' &&
      typeof tracingConfig !== 'string'
    ) {
      // tracing is already set, we can't change it
      logger.warn(
        'Tracing config is already set, skipping setting it again. This likely happens when you already set a tracing config on session creation.',
      );
      return;
    }

    if (tracingConfig === null) {
      logger.debug(
        'Disabling tracing for this session. It cannot be turned on for this session from this point on.',
      );

      this.sendEvent({
        type: 'session.update',
        session: {
          type: 'realtime',
          tracing: null,
        },
      });
      return;
    }

    if (
      this.#tracingConfig === null ||
      typeof this.#tracingConfig === 'string'
    ) {
      // tracing is currently not set so we can set it to the new value
      this.sendEvent({
        type: 'session.update',
        session: {
          type: 'realtime',
          tracing: tracingConfig,
        },
      });
      return;
    }

    if (
      tracingConfig?.group_id !== this.#tracingConfig?.group_id ||
      tracingConfig?.metadata !== this.#tracingConfig?.metadata ||
      tracingConfig?.workflow_name !== this.#tracingConfig?.workflow_name
    ) {
      logger.warn(
        'Mismatch in tracing config. Ignoring the new tracing config. This likely happens when you already set a tracing config on session creation. Current tracing config: %s, new tracing config: %s',
        JSON.stringify(this.#tracingConfig),
        JSON.stringify(tracingConfig),
      );
      return;
    }

    this.sendEvent({
      type: 'session.update',
      session: {
        type: 'realtime',
        tracing: tracingConfig,
      },
    });
  }

  /**
   * Updates the session config. This will merge it with the current session config with the default
   * values and send it to the Realtime API.
   *
   * @param config - The session config to update.
   */
  updateSessionConfig(config: Partial<RealtimeSessionConfig>): void {
    const sessionData = this.buildSessionPayload(config);

    this.sendEvent({
      type: 'session.update',
      session: sessionData,
    });
  }

  /**
   * Send the output of a function call to the Realtime API.
   *
   * @param toolCall - The tool call to send the output for.
   * @param output - The output of the function call.
   * @param startResponse - Whether to start a new response after sending the output.
   */
  sendFunctionCallOutput(
    toolCall: TransportToolCallEvent,
    output: string,
    startResponse: boolean = true,
  ): void {
    const outputItemId = createFunctionCallOutputItemId();
    const eventId = createHistoryReplayEventId();
    const event = {
      type: 'conversation.item.create',
      event_id: eventId,
      ...(typeof toolCall.id === 'string'
        ? { previous_item_id: toolCall.id }
        : {}),
      item: {
        id: outputItemId,
        type: 'function_call_output',
        output,
        call_id: toolCall.callId,
      },
    } as const;

    let item: RealtimeToolCallItem | undefined;
    try {
      item = realtimeToolCallItem.parse({
        itemId: toolCall.id,
        previousItemId: toolCall.previousItemId,
        callId: toolCall.callId,
        outputItemId,
        type: 'function_call',
        status: 'completed',
        arguments: toolCall.arguments,
        name: toolCall.name,
        output,
      });
    } catch (error) {
      logToolActionError(
        logger,
        'Error parsing tool call item',
        error,
        toolCall,
      );
    }

    if (item === undefined) {
      this.sendEvent(event);
    } else {
      if (
        this.#hasOwnedFunctionCallOutput(item.itemId) ||
        this.#hasPendingFunctionCallDeletion(item.itemId)
      ) {
        throw new UserError(
          `Function call ${item.itemId} already has an output pending or confirmed by the Realtime API.`,
        );
      }
      const pendingAck: PendingHistoryReplayCreate = {
        kind: 'create',
        itemId: outputItemId,
        item,
        projected: false,
      };
      this.#sendHistoryReplayEvent(event, pendingAck);
      if (
        !pendingAck.projected &&
        this.#pendingHistoryReplayAcks.get(eventId) === pendingAck
      ) {
        pendingAck.projected = true;
        try {
          this.emit('item_update', item);
        } catch (error) {
          logToolActionError(
            logger,
            'Error parsing tool call item',
            error,
            toolCall,
          );
        }
      }
    }

    if (startResponse) {
      this.requestResponse();
    }
  }

  /**
   * Send an audio buffer to the Realtime API. If `{ commit: true }` is passed, the audio buffer
   * will be committed and the model will start processing it. This is necessary if you have
   * disabled turn detection / voice activity detection (VAD).
   *
   * @param audio - The audio buffer to send.
   * @param options - The options for the audio buffer.
   */
  sendAudio(
    audio: ArrayBuffer,
    { commit = false }: { commit?: boolean } = {},
  ): void {
    this.sendEvent({
      type: 'input_audio_buffer.append',
      audio: arrayBufferToBase64(audio),
    });

    if (commit) {
      this.sendEvent({
        type: 'input_audio_buffer.commit',
      });
    }
  }

  /**
   * Reset the history of the conversation. This will create a diff between the old and new history
   * and send the necessary events to the Realtime API to update the history.
   *
   * @param oldHistory - The old history of the conversation.
   * @param newHistory - The new history of the conversation.
   */
  resetHistory(oldHistory: RealtimeItem[], newHistory: RealtimeItem[]): void {
    assertUniqueFunctionCallOutputItemIds(oldHistory, 'current');
    const oldItemsById = new Map(oldHistory.map((item) => [item.itemId, item]));
    const normalizedNewHistory = newHistory.map((item) => {
      const oldItem = oldItemsById.get(item.itemId);
      if (item.type === 'message') {
        return cloneRealtimeEvent(item);
      }
      if (item.type !== 'function_call') {
        return item;
      }
      const normalizedItem =
        item.output === null ? withoutFunctionCallOutput(item) : item;
      const pendingReplay = this.#getPendingHistoryReplay(
        normalizedItem.itemId,
      );
      const identitySource =
        oldItem?.type === 'function_call'
          ? oldItem
          : (pendingReplay.output ?? pendingReplay.call);
      if (identitySource === undefined) {
        return normalizedItem;
      }
      return realtimeToolCallItem.parse({
        ...normalizedItem,
        ...(normalizedItem.callId === undefined &&
        identitySource.callId !== undefined
          ? { callId: identitySource.callId }
          : {}),
        ...(normalizedItem.outputItemId === undefined &&
        identitySource.outputItemId !== undefined
          ? { outputItemId: identitySource.outputItemId }
          : {}),
      });
    });
    assertUniqueFunctionCallOutputItemIds(normalizedNewHistory, 'updated');
    for (const item of normalizedNewHistory) {
      if (
        item.type === 'function_call' &&
        item.output !== null &&
        item.status !== 'completed'
      ) {
        throw new UserError(
          `Function call history item ${item.itemId} must be completed when it has an output.`,
        );
      }
      if (item.type === 'message' || item.type === 'function_call') {
        const pendingReplay = this.#getPendingHistoryReplay(item.itemId);
        const pendingVisibleItem = pendingReplay.message ?? pendingReplay.call;
        if (
          pendingVisibleItem !== undefined &&
          pendingVisibleItem.type !== item.type
        ) {
          throw new UserError(
            `History item ${item.itemId} cannot change type while its creation is awaiting acknowledgement.`,
          );
        }
      }
    }

    const newHistoryIds = new Set<string>();
    for (const item of normalizedNewHistory) {
      if (newHistoryIds.has(item.itemId)) {
        throw new UserError(
          `History item ${item.itemId} appears more than once in the updated history.`,
        );
      }
      newHistoryIds.add(item.itemId);
    }

    const { removals, additions, updates } = diffRealtimeHistory(
      oldHistory,
      normalizedNewHistory,
    );
    const functionCallOutputCompletionIds = new Set(
      updates
        .filter((update) =>
          isFunctionCallOutputCompletion(
            oldItemsById.get(update.itemId),
            update,
          ),
        )
        .map((update) => update.itemId),
    );
    const pendingFunctionCallDeletionCompletionIds = new Set(
      [...functionCallOutputCompletionIds].filter((itemId) =>
        this.#hasPendingFunctionCallDeletion(itemId),
      ),
    );

    for (const update of updates) {
      const oldItem = oldItemsById.get(update.itemId);
      if (functionCallOutputCompletionIds.has(update.itemId)) {
        continue;
      }
      if (
        update.type === 'function_call' ||
        oldItem?.type === 'function_call'
      ) {
        throw new UserError(
          `Function call history item ${update.itemId} cannot be updated in place. Remove it in one updateHistory() call, then add the replacement in a later call.`,
        );
      }
    }

    for (const item of removals) {
      if (
        item.type === 'function_call' &&
        item.output !== null &&
        item.outputItemId === undefined
      ) {
        throw new UserError(
          `Function call history item ${item.itemId} cannot be removed because its output item ID is unavailable.`,
        );
      }
    }

    const preparedAdditions = additions.map((addition) => {
      if (addition.type !== 'function_call') {
        return addition;
      }
      const parsedAddition = realtimeToolCallItem.parse(addition);
      const preparedAddition = realtimeToolCallItem.parse({
        ...parsedAddition,
        callId: parsedAddition.callId ?? parsedAddition.itemId,
        outputItemId:
          parsedAddition.output === null
            ? undefined
            : (parsedAddition.outputItemId ?? createFunctionCallOutputItemId()),
      });
      const pendingReplay = this.#getPendingHistoryReplay(
        preparedAddition.itemId,
      );
      if (
        pendingReplay.call !== undefined &&
        JSON.stringify(pendingReplay.call) !==
          JSON.stringify(withoutFunctionCallOutput(preparedAddition))
      ) {
        throw new UserError(
          `Function call history item ${preparedAddition.itemId} cannot change while its call creation is awaiting acknowledgement.`,
        );
      }
      if (
        pendingReplay.output !== undefined &&
        JSON.stringify(pendingReplay.output) !==
          JSON.stringify(preparedAddition)
      ) {
        throw new UserError(
          `Function call history item ${preparedAddition.itemId} cannot change its output while the previous output is awaiting acknowledgement.`,
        );
      }
      return preparedAddition;
    });
    const preparedOutputCompletions = updates
      .filter(
        (update): update is RealtimeToolCallItem =>
          update.type === 'function_call' &&
          functionCallOutputCompletionIds.has(update.itemId) &&
          !pendingFunctionCallDeletionCompletionIds.has(update.itemId),
      )
      .map((completion) => {
        const confirmedOutputItemId = this.#confirmedFunctionCallOutputIds.get(
          completion.itemId,
        );
        if (confirmedOutputItemId !== undefined) {
          throw new UserError(
            `Function call history item ${completion.itemId} cannot replay its output because output item ${confirmedOutputItemId} is already confirmed by the Realtime API.`,
          );
        }
        const pendingOutput = this.#getPendingHistoryReplay(
          completion.itemId,
        ).output;
        if (
          pendingOutput !== undefined &&
          (pendingOutput.output !== completion.output ||
            (completion.outputItemId !== undefined &&
              completion.outputItemId !== pendingOutput.outputItemId))
        ) {
          throw new UserError(
            `Function call history item ${completion.itemId} cannot change its output while the previous output is awaiting acknowledgement.`,
          );
        }
        return realtimeToolCallItem.parse({
          ...completion,
          outputItemId:
            completion.outputItemId ??
            pendingOutput?.outputItemId ??
            createFunctionCallOutputItemId(),
        });
      });

    const itemsToRemove = [
      ...removals,
      ...updates
        .filter((update) => !functionCallOutputCompletionIds.has(update.itemId))
        .map((update) => oldItemsById.get(update.itemId)!),
    ].filter((item): item is RealtimeItem => Boolean(item));

    const pendingFunctionCallOutputs = [
      ...this.#pendingHistoryReplayAcks.values(),
    ]
      .filter(
        (
          pendingAck,
        ): pendingAck is PendingHistoryReplayCreate & {
          item: RealtimeToolCallItem;
        } =>
          pendingAck.kind === 'create' &&
          pendingAck.item.type === 'function_call' &&
          pendingAck.item.output !== null &&
          pendingAck.item.outputItemId === pendingAck.itemId,
      )
      .map((pendingAck) => pendingAck.item);
    assertUniqueFunctionCallOutputItemIds(normalizedNewHistory, 'updated', [
      ...preparedAdditions.filter(
        (item): item is RealtimeToolCallItem => item.type === 'function_call',
      ),
      ...preparedOutputCompletions,
      ...pendingFunctionCallOutputs,
      ...itemsToRemove.filter(
        (item): item is RealtimeToolCallItem => item.type === 'function_call',
      ),
      ...[...this.#confirmedFunctionCallOutputIds].map(
        ([itemId, outputItemId]) => ({ itemId, outputItemId }),
      ),
    ]);

    const desiredItemsById = new Map(
      normalizedNewHistory.map((item) => [item.itemId, item]),
    );
    const preparedFunctionCallReplayItemsById = new Map(
      [...preparedAdditions, ...preparedOutputCompletions]
        .filter(
          (item): item is RealtimeToolCallItem => item.type === 'function_call',
        )
        .map((item) => [item.itemId, item]),
    );
    for (const item of [...preparedAdditions, ...preparedOutputCompletions]) {
      desiredItemsById.set(item.itemId, item);
    }

    const replayItemIds = new Set(
      [
        ...additions,
        ...updates.filter(
          (update) =>
            !pendingFunctionCallDeletionCompletionIds.has(update.itemId),
        ),
      ].map((item) => item.itemId),
    );
    const replayItems = normalizedNewHistory
      .filter((item) => replayItemIds.has(item.itemId))
      .map(
        (item) => preparedFunctionCallReplayItemsById.get(item.itemId) ?? item,
      );
    const pendingMessageReplayIds = new Set<string>();
    for (const item of replayItems) {
      if (item.type !== 'message') {
        continue;
      }
      const pendingMessage = this.#getPendingHistoryReplay(item.itemId).message;
      if (pendingMessage === undefined) {
        continue;
      }
      if (JSON.stringify(pendingMessage) !== JSON.stringify(item)) {
        throw new UserError(
          `History message ${item.itemId} cannot change while its creation is awaiting acknowledgement.`,
        );
      }
      pendingMessageReplayIds.add(item.itemId);
    }
    const replayPreviousItemIds = new Map<string, string | undefined>();
    for (const item of replayItems) {
      if (item.type !== 'message' && item.type !== 'function_call') {
        continue;
      }
      let previousItemId =
        typeof item.previousItemId === 'string'
          ? item.previousItemId
          : undefined;
      const previousItem =
        previousItemId === undefined || previousItemId === 'root'
          ? undefined
          : desiredItemsById.get(previousItemId);
      if (
        previousItem?.type === 'function_call' &&
        previousItem.output !== null
      ) {
        if (previousItem.outputItemId === undefined) {
          const itemDescription =
            item.type === 'function_call'
              ? 'Function call history item'
              : 'History item';
          throw new UserError(
            `${itemDescription} ${item.itemId} cannot follow function call ${previousItem.itemId} because its output item ID is unavailable.`,
          );
        }
        previousItemId = previousItem.outputItemId;
      }
      replayPreviousItemIds.set(item.itemId, previousItemId);
    }

    const pendingDeletes = new Map<string, PendingHistoryReplayDelete>();
    for (const item of itemsToRemove) {
      let deletionItem = item;
      if (item.type === 'function_call' && item.outputItemId === undefined) {
        const pendingOutput = this.#getPendingHistoryReplay(item.itemId).output;
        if (pendingOutput !== undefined) {
          if (
            JSON.stringify(withoutFunctionCallOutput(pendingOutput)) !==
            JSON.stringify(item)
          ) {
            throw new UserError(
              `Function call history item ${item.itemId} cannot be removed while a conflicting output is awaiting acknowledgement.`,
            );
          }
          deletionItem = pendingOutput;
        }
      }
      if (
        deletionItem.type === 'function_call' &&
        deletionItem.outputItemId !== undefined
      ) {
        const deletion: PendingHistoryCallDeletion = {
          itemWithoutOutput: withoutFunctionCallOutput(deletionItem),
        };
        pendingDeletes.set(deletionItem.outputItemId, {
          kind: 'delete',
          itemId: deletionItem.outputItemId,
          projection: { kind: 'call_output', deletion },
        });
      } else {
        pendingDeletes.set(deletionItem.itemId, {
          kind: 'delete',
          itemId: deletionItem.itemId,
          projection: { kind: 'item', itemId: deletionItem.itemId },
        });
      }
    }

    for (const pendingDelete of pendingDeletes.values()) {
      if (this.#pendingHistoryReplayDeletes.has(pendingDelete.itemId)) {
        continue;
      }
      const eventId = createHistoryReplayEventId();
      this.#sendHistoryReplayEvent(
        {
          type: 'conversation.item.delete',
          event_id: eventId,
          item_id: pendingDelete.itemId,
        },
        pendingDelete,
      );
    }

    for (const item of replayItems) {
      if (item.type === 'message') {
        if (pendingMessageReplayIds.has(item.itemId)) {
          continue;
        }
        const itemEntry: Record<string, any> = {
          type: 'message',
          role: item.role,
          content: item.content,
          id: item.itemId,
        };
        if (item.role !== 'system' && item.status) {
          itemEntry.status = item.status;
        }
        const previousItemId = replayPreviousItemIds.get(item.itemId);
        const eventId = createHistoryReplayEventId();
        this.#sendHistoryReplayEvent(
          {
            type: 'conversation.item.create',
            event_id: eventId,
            ...(previousItemId !== undefined
              ? { previous_item_id: previousItemId }
              : {}),
            item: itemEntry,
          },
          {
            kind: 'create',
            itemId: item.itemId,
            item,
            projected: false,
          },
        );
      } else if (item.type === 'function_call') {
        if (functionCallOutputCompletionIds.has(item.itemId)) {
          this.#replayFunctionCallOutputHistoryItem(item);
        } else {
          this.#replayFunctionCallHistoryItem(
            item,
            replayPreviousItemIds.get(item.itemId),
          );
        }
      }
    }
  }

  #replayFunctionCallHistoryItem(
    item: RealtimeToolCallItem,
    previousItemId: string | undefined,
  ): void {
    const callId = item.callId ?? item.itemId;
    const outputItemId = item.outputItemId;
    const pendingCall = this.#getPendingHistoryReplay(item.itemId).call;

    if (pendingCall === undefined) {
      const callEventId = createHistoryReplayEventId();
      this.#sendHistoryReplayEvent(
        {
          type: 'conversation.item.create',
          event_id: callEventId,
          ...(previousItemId !== undefined
            ? { previous_item_id: previousItemId }
            : {}),
          item: {
            id: item.itemId,
            type: 'function_call',
            name: item.name,
            arguments: item.arguments,
            call_id: callId,
          },
        },
        {
          kind: 'create',
          itemId: item.itemId,
          item: item.output === null ? item : withoutFunctionCallOutput(item),
          projected: false,
        },
      );
    }

    if (item.output !== null && outputItemId !== undefined) {
      this.#replayFunctionCallOutputHistoryItem(item);
    }
  }

  #replayFunctionCallOutputHistoryItem(item: RealtimeToolCallItem): void {
    if (item.output === null || item.outputItemId === undefined) {
      return;
    }
    const pendingOutput = this.#getPendingHistoryReplay(item.itemId).output;
    if (pendingOutput?.outputItemId === item.outputItemId) {
      return;
    }
    const outputEventId = createHistoryReplayEventId();
    this.#sendHistoryReplayEvent(
      {
        type: 'conversation.item.create',
        event_id: outputEventId,
        previous_item_id: item.itemId,
        item: {
          id: item.outputItemId,
          type: 'function_call_output',
          call_id: item.callId ?? item.itemId,
          output: item.output,
        },
      },
      {
        kind: 'create',
        itemId: item.outputItemId,
        item,
        projected: false,
      },
    );
  }

  sendMcpResponse(
    approvalRequest: RealtimeMcpCallApprovalRequestItem,
    approved: boolean,
    reason?: string,
  ): void {
    this.sendEvent({
      type: 'conversation.item.create',
      previous_item_id: approvalRequest.itemId,
      item: {
        type: 'mcp_approval_response',
        approval_request_id: approvalRequest.itemId,
        approve: approved,
        ...(reason !== undefined ? { reason } : {}),
      },
    });
  }
}
