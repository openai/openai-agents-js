import {
  resolveRealtimePolicy,
  type NativeRealtimePolicyContext,
  type NativeRealtimeTool,
  type NativeRealtimeToolErrorContext,
} from './realtime-policy';
import {
  addRealtimeUsage,
  reportedRealtimeUsage,
  type NativeRealtimeUsage,
} from './realtime-usage';
import {
  captureRealtimeGuardrails,
  NativeRealtimeGuardrails,
  type NativeRealtimeOutputGuardrail,
  type NativeRealtimeGuardrailEvent,
  type NativeRealtimeGuardrailWork,
} from './realtime-guardrails';
import type { FunctionTool } from './tools';
import {
  VoiceConversationHistory,
  type VoiceHistoryItem,
} from '../voice/conversation-history';
import {
  VoiceEventObservers,
  detachVoiceObservation,
} from '../voice/event-observers';
import {
  NativeRealtimeAdapterDriver,
  type NativeRealtimeAdapter,
  type NativeRealtimeAdapterBridge,
} from './realtime-adapter';
import {
  NativeRealtimePlayback,
  playbackPayload,
  type NativeRealtimeAudioInput,
  type NativeRealtimeAudioFormat,
  type NativeRealtimePlaybackPosition,
} from './realtime-playback';
export type {
  NativeRealtimeAudioInput,
  NativeRealtimeAudioFormat,
  NativeRealtimePlaybackPosition,
} from './realtime-playback';

/** User-only text and inline image references; provider fields and file IDs are unsupported. */
export type NativeRealtimeUserInput =
  | string
  | {
      readonly type: 'message';
      readonly role: 'user';
      readonly content: readonly (
        | { readonly type: 'input_text'; readonly text: string }
        | {
            readonly type: 'input_image';
            readonly image: string;
            readonly detail?: 'auto' | 'low' | 'high';
          }
      )[];
    };

export type NativeRealtimeTransport =
  | { readonly type: 'webrtc'; readonly offerSdp: string }
  | { readonly type: 'sip'; readonly callId: string };

import { NativeRealtimeToolBatch } from './realtime-tool-batch';
import {
  serializeRealtimeSettings,
  serializeRealtimeSessionUpdate,
  type NativeRealtimeSettings,
  type NativeRealtimeSessionUpdate,
} from './realtime-settings';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { Agent, Session as PublicSession } from './public-agent';
import { resolveRealtimeAgentConfiguration } from './realtime-agent-config';
import { TurnAborted, type Turn, type Session } from './session';
import type { NativeEvent } from './events';
import { copyJsonValue, type JsonObject, type JsonValue } from './binding';
import {
  NativeSessionVoiceWorkflow,
  voiceWorkflowGraphClosed,
} from '../voice/workflow';

/** Provider declarations can omit a string index signature; runtime validates JSON. */
type RealtimeProviderObject = JsonObject | { readonly type: string };

function realtimeProfileKey(value: unknown): string {
  if (value == null || typeof value !== 'object') return '';
  const receipt = value as Record<string, unknown>;
  return JSON.stringify([receipt.profile_id, String(receipt.epoch)]);
}

export interface NativeRealtimeOptions {
  model?: string;
  voice?: string;
  instructions?:
    | string
    | ((context: NativeRealtimePolicyContext) => string | Promise<string>);
  /** Narrow captured function and handoff availability before advertisement and dispatch. */
  isToolEnabled?: (
    context: NativeRealtimePolicyContext,
    tool: NativeRealtimeTool,
  ) => boolean | Promise<boolean>;
  /** Format only an implicit approval rejection; explicit per-call reasons win. */
  toolErrorFormatter?: (
    input: NativeRealtimeToolErrorContext,
  ) => string | null | undefined | Promise<string | null | undefined>;
  /** Initial provider output modality; defaults to audio. */
  outputModality?: 'audio' | 'text';
  /** Resolve once per connection without changing the Session provider's auth. */
  apiKey?: string | ((signal?: AbortSignal) => string | Promise<string>);
  signal?: AbortSignal;
  settings?: NativeRealtimeSettings;
  /** Omit for server WebSocket media; calls keep their native sideband owner. */
  transport?: NativeRealtimeTransport;
  /** Supply application I/O instead of a built-in transport. */
  adapter?: NativeRealtimeAdapter;
  /** Omit to inherit the captured active Agent catalog, including its handoffs. */
  tools?: readonly FunctionTool<any>[];
  outputGuardrails?: readonly NativeRealtimeOutputGuardrail[];
  /** Check full text at this length interval; null checks only final output. */
  guardrailTextThreshold?: number | null;
  /** Hosted MCP tool results request a follow-up response by default. */
  automaticallyTriggerResponseForMcpToolCalls?: boolean;
  /** Observe provider JSON frames before their native projections. */
  includeRawProviderEvents?: boolean;
  /** Retain up to the first 8 MiB of output audio in local provider history. */
  historyStoreAudio?: boolean;
}
/** Session configuration for accepting an inbound SIP call before attaching sideband media. */
export type NativeRealtimeSipConfigOptions = Pick<
  NativeRealtimeOptions,
  | 'model'
  | 'voice'
  | 'instructions'
  | 'isToolEnabled'
  | 'outputModality'
  | 'settings'
  | 'tools'
>;

/** Overrides for one response; the accepted Session configuration remains unchanged. */
export type NativeRealtimeResponseOptions = {
  readonly instructions?: string;
  readonly outputModality?: 'audio' | 'text';
  readonly maxOutputTokens?: number | 'inf';
};

/** @internal Both connection admission and SIP acceptance use Core's config builder. */
export function realtimePrepareParams(
  options: Omit<NativeRealtimeOptions, 'instructions'> & {
    instructions?: string;
  },
  transport: JsonObject,
  settings: JsonObject | null,
  functionTools: JsonObject[] | null,
  expectedSelectionId: string | null = null,
): JsonObject {
  return {
    function_tools: functionTools,
    hosted_mcp_auto_response:
      options.automaticallyTriggerResponseForMcpToolCalls ?? true,
    ...(options.includeRawProviderEvents
      ? { include_raw_provider_events: true }
      : {}),
    expected_selection_id: expectedSelectionId,
    settings,
    params: {
      client_managed_handoffs: true,
      delegation_ack_filler: null,
      flush_transcript_tail_on_session_end: true,
      codex_responses_as_items: false,
      codex_response_item_prefix: null,
      codex_response_handoff_mode: 'thinking',
      backend_reasoning_status: false,
      codex_response_handoff_channel_prefixes: null,
      model: options.model ?? null,
      output_modality: options.outputModality ?? 'audio',
      include_startup_context: false,
      initial_items: [],
      realtime_start_instructions: null,
      realtime_end_instructions: null,
      ...(options.instructions === undefined
        ? {}
        : { prompt: options.instructions }),
      realtime_session_id: null,
      transport,
      version: 'v2',
      voice: options.voice ?? null,
    },
  };
}

export interface NativeRealtimeHistoryItem {
  readonly id: string;
  readonly realtimeSessionId: string;
  readonly kind: string;
  readonly role?: string;
  readonly text?: string;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly providerItemId?: string;
  readonly outcome?: string;
  readonly presentation?: string;
  readonly presentationIndex?: number;
}
/** An issued, one-shot hosted MCP approval capability belonging to this media owner. */
export interface NativeRealtimeHostedMcpApprovalRequest {
  readonly type: 'hosted_mcp_approval_requested';
  readonly requestId: string;
  readonly serverLabel: string;
  readonly toolName: string;
  readonly arguments: string;
  readonly responseId?: string;
}
export interface NativeRealtimeHostedMcpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
}
export type NativeRealtimeEvent =
  | NativeRealtimeGuardrailEvent
  | NativeRealtimeHostedMcpApprovalRequest
  | { readonly type: 'raw_provider_event'; readonly event: JsonObject }
  | {
      readonly type: 'provider_request_error';
      readonly code?: string;
      readonly eventId?: string;
    }
  | {
      readonly type: 'hosted_mcp_tools_listed';
      readonly itemId: string;
      readonly serverLabel: string;
      readonly tools: readonly NativeRealtimeHostedMcpToolDefinition[];
      readonly responseId?: string;
    }
  | {
      readonly type: 'hosted_mcp_call_completed';
      readonly itemId: string;
      readonly serverLabel: string;
      readonly toolName: string;
      readonly arguments: string;
      readonly responseId?: string;
      readonly output?: string;
      readonly error?: JsonValue;
    }
  | {
      type: 'audio';
      data: Uint8Array;
      sampleRate: number;
      channels: number;
      itemId?: string;
      responseId?: string;
      format?: NativeRealtimeAudioFormat;
      contentIndex?: number;
      outputIndex?: number;
      outOfBand?: true;
    }
  | {
      type: 'playback_interrupted';
      retiredResponseIds: readonly string[];
      cancelledResponseId?: string;
      responseId?: string;
      playback?: NativeRealtimePlaybackPosition;
    }
  | {
      type: 'text';
      role: 'user' | 'assistant';
      text: string;
      final: boolean;
      responseId?: string;
      itemId?: string;
      contentIndex?: number;
      outputIndex?: number;
      outputKind?: 'text' | 'audio_transcript';
      outOfBand?: true;
    }
  | {
      type: 'lifecycle';
      status:
        'started' | 'updated' | 'speech_started' | 'speech_stopped' | 'closed';
      sessionId?: string;
      reason?: string;
    }
  | {
      type: 'response';
      status: 'created' | 'done' | 'cancelled';
      responseId?: string;
      outOfBand?: true;
      usage?: NativeRealtimeUsage;
      /** Connection total at this event, including this accepted response. */
      cumulativeUsage?: NativeRealtimeUsage;
    }
  | {
      type: 'delegation';
      handoffId: string;
      status: 'started' | 'completed' | 'failed';
      /** Original application-side failure; never sent to the speech provider. */
      error?: unknown;
    }
  | {
      readonly type: 'conversation_item';
      readonly itemId: string;
      readonly kind: string;
      readonly status: 'added' | 'done';
      readonly role?: string;
      readonly callId?: string;
    }
  | { readonly type: 'conversation_item_deleted'; readonly itemId: string }
  | { type: 'history'; item: NativeRealtimeHistoryItem; completed: boolean }
  | {
      type: 'detached_function_call';
      responseId: string;
      itemId: string;
      callId: string;
      name: string;
      arguments: string;
    }
  | {
      type: 'function_call';
      callId: string;
      name: string;
      status: 'started' | 'completed' | 'failed';
      error?: Error;
    }
  | {
      type: 'tool_batch_error';
      responseId: string;
      callIds: readonly string[];
      error: unknown;
    };

type Command =
  | 'start'
  | 'prepare'
  | 'activate'
  | 'hosted_mcp_approval'
  | 'update'
  | 'audio'
  | 'audio_commit'
  | 'input'
  | 'response'
  | 'send_event'
  | 'delete_item'
  | 'update_history'
  | 'retrieve_item'
  | 'retrieve_history'
  | 'text'
  | 'complete'
  | 'fail'
  | 'interrupt'
  | 'close';
export type NativeRealtimeCall = (
  operation: `realtime_conversation_${Command}_sdk`,
  params: JsonObject,
) => Promise<unknown>;
interface ToolsRoot {
  turn: Turn<unknown>;
  monitor: Promise<void>;
  settled: boolean;
  failure?: { error: unknown };
}
interface Delegation {
  workflow: NativeSessionVoiceWorkflow;
  retired: boolean;
  responseId?: string;
  sdkOwnershipId?: string;
  task?: Promise<void>;
}
const KINDS = new Set([
  'realtime_conversation_started',
  'realtime_conversation_realtime',
  'realtime_conversation_closed',
  'realtime_conversation_sdp',
]);
const EVENT_LIMIT = 128;
const SDP_BYTES_LIMIT = 1024 * 1024;
const USER_INPUT_BYTES_LIMIT = 1024 * 1024;
const USER_INPUT_PARTS_LIMIT = 1024;
const INPUT_QUEUE_COUNT_LIMIT = 128;
const INPUT_QUEUE_BYTES_LIMIT = 8 * 1024 * 1024;
const AUDIO_LIMIT = 2 * 1024 * 1024;
const HISTORY_LIMIT = 8 * 1024 * 1024;
// One full snapshot can contain provider rows and base64-encoded retained audio.
const CALL_HISTORY_LIMIT = 3 * HISTORY_LIMIT;
const HISTORY_TRANSCRIPT_WORK_LIMIT = 256 * 1024 * 1024;

function historyAllocationBytes(item: NativeRealtimeHistoryItem): number {
  let bytes = 256;
  for (const value of Object.values(item))
    if (typeof value === 'string') bytes += value.length * 4;
  return bytes;
}
const HANDOFF_LIMIT = 1024;
const PENDING_LIMIT = 16;
const MAX_HOSTED_MCP_TOOLS = 1024;

/** Estimate structured JSON allocations before cloning or serializing them. */
function jsonAllocationBytes(
  value: unknown,
  remaining: number,
  budgetErrorMessage = 'Hosted MCP structured JSON exceeds the event buffer budget',
  utf8Strings = false,
): number {
  let bytes = 0;
  const charge = (amount: number) => {
    bytes += amount;
    if (bytes > remaining) throw new RangeError(budgetErrorMessage);
  };
  const string = (value: unknown) => {
    if (typeof value === 'string')
      charge(
        4 * (utf8Strings ? Buffer.byteLength(value, 'utf8') : value.length),
      );
  };
  const json = (value: unknown, depth: number): void => {
    if (depth > 128)
      throw new RangeError('Hosted MCP structured JSON exceeds 128 levels');
    charge(256);
    if (typeof value === 'string') string(value);
    else if (Array.isArray(value)) {
      for (const child of value) json(child, depth + 1);
    } else if (value && typeof value === 'object') {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        charge(128);
        string(key);
        json((value as Record<string, unknown>)[key], depth + 1);
      }
    }
  };
  json(value, 0);
  return bytes;
}

/** Bound the retained catalog allocation before copying provider-owned schemas. */
function hostedMcpCatalogBytes(
  tools: readonly any[],
  itemId: string,
  serverLabel: string,
  responseId: string | undefined,
  remaining: number,
): number {
  if (tools.length > MAX_HOSTED_MCP_TOOLS)
    throw new RangeError('Hosted MCP tool catalog exceeds 1024 tools');
  let bytes = 512;
  const charge = (amount: number) => {
    bytes += amount;
    if (bytes > remaining)
      throw new RangeError(
        'Hosted MCP tool catalog exceeds the event buffer budget',
      );
  };
  const string = (value: unknown) => {
    if (typeof value === 'string') charge(4 * value.length);
  };
  charge(0);
  string(itemId);
  string(serverLabel);
  string(responseId);
  for (const tool of tools) {
    charge(256);
    string(tool.name);
    string(tool.description);
    charge(
      jsonAllocationBytes(
        tool.input_schema ?? tool.inputSchema,
        remaining - bytes,
      ),
    );
  }
  return bytes;
}

function userInputBytes(
  text: string,
  remaining = USER_INPUT_BYTES_LIMIT,
): number {
  if (text.length > remaining)
    throw new RangeError('Realtime user input exceeds the 1 MiB UTF-8 limit');
  const bytes = Buffer.byteLength(text);
  if (bytes > remaining)
    throw new RangeError('Realtime user input exceeds the 1 MiB UTF-8 limit');
  return bytes;
}

function resolveRealtimeApiKey(
  source: NativeRealtimeOptions['apiKey'],
  signal: AbortSignal,
): Promise<string | null> {
  signal.throwIfAborted();
  if (source === undefined) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    let pending: Promise<string>;
    try {
      pending = Promise.resolve(
        typeof source === 'function' ? source(signal) : source,
      );
    } catch (error) {
      signal.removeEventListener('abort', abort);
      reject(error);
      return;
    }
    // These observers retain no media owner or native preparation receipt.
    // Late application results remain observed after cancellation wins.
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) return;
        if (typeof value !== 'string' || !value.trim())
          reject(
            new TypeError(
              'Realtime credential source must return a nonempty string',
            ),
          );
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        if (!signal.aborted) reject(error);
      },
    );
  });
}

/** Native media owned by Session.realtime; closing it leaves the caller's Session open. */
class NativeRealtimeOwner {
  readonly #generation = randomUUID();
  readonly #context = AsyncLocalStorage.snapshot();
  private readonly ready = Promise.withResolvers<void>();
  private readonly terminal = Promise.withResolvers<void>();
  private readonly queue: NativeRealtimeEvent[] = [];
  private readonly seen = new Set<string>();
  private readonly delegations = new Map<string, Delegation>();
  private readonly canonical = new Map<string, NativeRealtimeHistoryItem>();
  private readonly conversation: VoiceConversationHistory;
  private readonly observers = new VoiceEventObservers<NativeRealtimeEvent>(
    (event) =>
      event.type === 'hosted_mcp_approval_requested'
        ? event
        : detachVoiceObservation(event),
  );
  private historyBytes = 0;
  private historyTranscriptWork = 0;
  private readonly functions = new Map<
    string,
    {
      name: string;
      itemId?: string;
      history: Buffer;
      sourceProfile?: unknown;
      error?: Error;
      responseId?: string;
      batch?: NativeRealtimeToolBatch;
      retired: boolean;
    }
  >();
  private readonly toolBatches = new Set<NativeRealtimeToolBatch>();
  private readonly toolsRoots = new WeakMap<Turn<unknown>, ToolsRoot>();
  private readonly toolsRootMonitors = new Set<ToolsRoot>();
  private readonly toolsGraphClosed = Promise.withResolvers<void>();
  private functionBytes = 0;
  private functionHistoryBytes = 0;
  private readonly hostedApprovals = new WeakMap<
    NativeRealtimeHostedMcpApprovalRequest,
    string
  >();
  private readonly seenHostedApprovals = new Set<string>();
  private readonly pendingHostedApprovals = new Map<
    string,
    { responseId?: string; inFlight: boolean; retired: boolean }
  >();
  private readonly profileUpdates = new Set<Promise<void>>();
  private profileSource?: JsonObject | null;
  private voiceGraphAdmitted = false;
  private retargetTail: Promise<void> = Promise.resolve();
  private settingsTail: Promise<void> = Promise.resolve();
  private readonly profileGuardrails = new Map<
    string,
    readonly NativeRealtimeOutputGuardrail[]
  >();
  private readonly retiredResponses = new Set<string>();
  private changed = Promise.withResolvers<void>();
  private preparation?: Promise<unknown>;
  private admission?: Promise<unknown>;
  private readonly startupAbort = new AbortController();
  private readonly credentialSource: NativeRealtimeOptions['apiKey'];
  private readonly adapterSource: NativeRealtimeOptions['adapter'];
  private adapterDriver?: NativeRealtimeAdapterDriver;
  private closing?: Promise<void>;
  private live = true;
  private ended = false;
  private failure?: { error: unknown };
  private nativeClosed = false;
  private startupFailed = false;
  private sessionClosing = false;
  private consuming = false;
  private pullAcquired = false;
  private queuedBytes = 0;
  private inputTail: Promise<void> = Promise.resolve();
  private inputCount = 0;
  private inputBytes = 0;
  private pendingCommittedAudio = 0;
  private readonly nativeEnded = Promise.withResolvers<void>();
  private responseId?: string;
  private readonly playback = new NativeRealtimePlayback(HANDOFF_LIMIT);
  private readonly guardrails: NativeRealtimeGuardrails;
  private readonly transport: JsonObject;
  private readonly selectedTools: readonly FunctionTool<any>[] | undefined;
  private admittedCallId?: string;
  private admittedAnswerSdp?: string;
  get callId(): string | undefined {
    return this.admittedCallId;
  }
  get answerSdp(): string | undefined {
    return this.admittedAnswerSdp;
  }
  private readonly initialSettings: JsonObject | null;
  private readonly profileOverrides: JsonObject = {};
  private closeNative = () => this.call('close');

  /** @internal Session installs the route before starting admission. */
  constructor(
    private readonly session: Session<any, any>,
    private readonly nativeCall: NativeRealtimeCall,
    private readonly release: () => void,
    private readonly options: NativeRealtimeOptions,
    private readonly closeAfterGraph: (generation: string) => Promise<void>,
    private readonly adapterBridge?: NativeRealtimeAdapterBridge,
  ) {
    this.options = { ...options };
    if (
      options.historyStoreAudio !== undefined &&
      typeof options.historyStoreAudio !== 'boolean'
    )
      throw new TypeError('historyStoreAudio must be a boolean');
    this.conversation = new VoiceConversationHistory({
      storeAudio: options.historyStoreAudio,
    });
    this.credentialSource = options.apiKey;
    this.adapterSource = options.adapter;
    if (options.adapter !== undefined) {
      if (!options.adapter || typeof options.adapter.connect !== 'function')
        throw new TypeError('adapter must provide an async connect method');
      if (options.transport !== undefined)
        throw new TypeError(
          'adapter cannot be combined with a built-in call transport',
        );
    }
    if (options.apiKey !== undefined) {
      if (
        typeof options.apiKey !== 'string' &&
        typeof options.apiKey !== 'function'
      )
        throw new TypeError('apiKey must be a string or credential callback');
      if (typeof options.apiKey === 'string' && !options.apiKey.trim())
        throw new TypeError('apiKey must be nonempty');
    }
    if (options.tools !== undefined && !Array.isArray(options.tools))
      throw new TypeError(
        'Realtime tools must be an array of captured function declarations',
      );
    if (
      options.automaticallyTriggerResponseForMcpToolCalls !== undefined &&
      typeof options.automaticallyTriggerResponseForMcpToolCalls !== 'boolean'
    )
      throw new TypeError('Hosted MCP automatic response must be a boolean');
    if (
      options.includeRawProviderEvents !== undefined &&
      typeof options.includeRawProviderEvents !== 'boolean'
    )
      throw new TypeError('includeRawProviderEvents must be a boolean');
    this.selectedTools =
      options.tools === undefined
        ? undefined
        : Object.freeze([...options.tools]);
    // Bound the offer before trimming or native JSON/multipart serialization.
    if (
      options.transport?.type === 'webrtc' &&
      typeof options.transport.offerSdp === 'string' &&
      (options.transport.offerSdp.length > SDP_BYTES_LIMIT ||
        Buffer.byteLength(options.transport.offerSdp, 'utf8') > SDP_BYTES_LIMIT)
    )
      throw new RangeError(
        `offerSdp must not exceed ${SDP_BYTES_LIMIT} UTF-8 bytes`,
      );
    if (options.transport === undefined) this.transport = { type: 'websocket' };
    else if (
      options.transport.type === 'webrtc' &&
      typeof options.transport.offerSdp === 'string' &&
      options.transport.offerSdp.trim()
    )
      this.transport = { type: 'webrtc', sdp: options.transport.offerSdp };
    else if (
      options.transport.type === 'sip' &&
      typeof options.transport.callId === 'string' &&
      options.transport.callId.trim()
    ) {
      this.transport = {
        type: 'existing_call',
        call_id: options.transport.callId,
      };
    } else
      throw new TypeError(
        'Realtime transport requires a WebRTC offerSdp or SIP callId',
      );
    this.initialSettings = options.settings
      ? serializeRealtimeSettings(options.settings)
      : null;
    const hasConnectionGuardrails = options.outputGuardrails !== undefined;
    this.guardrails = new NativeRealtimeGuardrails({
      guardrails: options.outputGuardrails ?? [],
      guardrailsFor: (receipt) =>
        !hasConnectionGuardrails
          ? this.profileGuardrails.get(realtimeProfileKey(receipt))
          : undefined,
      threshold: options.guardrailTextThreshold,
      fingerprint: (value) =>
        createHash('sha256').update(value, 'utf16le').digest('hex'),
      source: (receipt) => this.session._realtimeGuardrailSource(receipt),
      invoke: (callback) =>
        this.#context(() => this.session._runVoiceCallback(callback)),
      trip: (input, feedback, worker) =>
        this.interruptOwned(
          input.responseId,
          {
            feedback: input.outOfBand ? undefined : feedback,
            playback:
              input.outOfBand || input.contentIndex === undefined
                ? undefined
                : this.playback.position(
                    input.responseId,
                    input.itemId,
                    input.contentIndex,
                  ),
          },
          worker,
        ),
      emit: (event) => this.emit(event),
      fail: (error) => this.finish(error),
    });
    this.ready.promise.catch(() => {});
    this.terminal.promise.catch(() => {});
  }
  /** @internal The existing response callback owner supplies its source and signal. */
  /** @internal Attach a diagnostic to the already-owned call record. */
  _markToolUnavailable(callId: string): void {
    const call = this.functions.get(callId);
    if (call) call.error = new Error(`Tool ${call.name} not found`);
  }

  async _toolEnabled(
    agent: import('./public-agent').Agent<any, any> | undefined,
    context: unknown,
    name: string,
    signal: AbortSignal,
    type: 'function' | 'handoff' = 'function',
    recheckAgent?: () => Promise<boolean>,
  ): Promise<boolean> {
    const predicate = this.options.isToolEnabled;
    if (predicate === undefined) return true;
    if (!agent) throw new Error('Realtime tool policy has no captured Agent');
    signal.throwIfAborted();
    this.checkLive();
    let asynchronous = false;
    const result = await this.#context(() =>
      this.session._runVoiceCallback(() => {
        const result = predicate(
          Object.freeze({ agent, context, realtimeUsage: this.usage, signal }),
          Object.freeze({ type, name }),
        );
        asynchronous = typeof result !== 'boolean';
        return result;
      }),
    );
    signal.throwIfAborted();
    this.checkLive();
    if (typeof result !== 'boolean')
      throw new TypeError('Realtime tool predicate must return a boolean');
    // The connection grant applies to this call. Agent policy can change
    // while the connection callback is waiting for its decision.
    if (result && asynchronous && recheckAgent) return recheckAgent();
    return result;
  }

  /** @internal Formatting cannot grant an approval or replace the native writer. */
  async _formatApprovalRejection(
    agent: import('./public-agent').Agent<any, any> | undefined,
    context: unknown,
    toolName: string,
    callId: string,
    defaultMessage: string,
    signal: AbortSignal,
  ): Promise<string> {
    const formatter = this.options.toolErrorFormatter;
    if (formatter === undefined) return defaultMessage;
    if (!agent)
      throw new Error('Realtime approval formatter has no captured Agent');
    signal.throwIfAborted();
    this.checkLive();
    let result: unknown;
    try {
      result = await this.#context(() =>
        this.session._runVoiceCallback(() =>
          formatter(
            Object.freeze({
              kind: 'approval_rejected' as const,
              toolType: 'function' as const,
              toolName,
              callId,
              defaultMessage,
              runContext: Object.freeze({
                agent,
                context,
                realtimeUsage: this.usage,
                signal,
              }),
            }),
          ),
        ),
      );
    } catch {
      // Application formatter errors retain the default rejection. Admission stays outside this catch.
    }
    signal.throwIfAborted();
    this.checkLive();
    if (result != null && typeof result !== 'string')
      throw new TypeError(
        'Realtime tool error formatter must return a string, null or undefined',
      );
    return result == null ? defaultMessage : result;
  }

  /** @internal Allow a later public opening to retry failed startup cleanup. */
  get _startupFailed(): boolean {
    return this.startupFailed;
  }
  private usageTotals?: ReturnType<typeof reportedRealtimeUsage>;
  /** Sum of observed speech-model counts; excludes backend thread usage.
   * May be partial when responses omit usage or close precedes a terminal event.
   */
  get usage(): NativeRealtimeUsage | undefined {
    return this.usageTotals === undefined
      ? undefined
      : (structuredClone(this.usageTotals) as NativeRealtimeUsage);
  }
  get history(): readonly NativeRealtimeHistoryItem[] {
    return Object.freeze(
      [...this.canonical.values()].map((item) => Object.freeze({ ...item })),
    );
  }
  /** Detached local provider view; retained observations remain readable after close. */
  providerHistory(): readonly VoiceHistoryItem[] {
    return this.conversation.snapshot();
  }
  /** @internal Record native-selected linked provider observations without writes. */
  _observeProviderFrame(value: unknown): void {
    this.conversation.observe(value);
  }
  /** @internal The source history captured when this exact native call was issued. */
  _realtimeToolContext<Context>(
    source: unknown,
    context: Context,
  ): {
    context: Context;
    history?: readonly VoiceHistoryItem[];
  } {
    if (!source || typeof source !== 'object') return { context };
    const identity = source as Record<string, unknown>;
    if (
      identity.generation !== this.#generation ||
      typeof identity.provider_call_id !== 'string'
    )
      return { context };
    const call = this.functions.get(identity.provider_call_id);
    if (
      !call ||
      call.retired ||
      call.itemId !== (identity.provider_item_id ?? undefined) ||
      call.responseId !== (identity.provider_response_id ?? undefined)
    )
      return { context };
    const history = JSON.parse(
      call.history.toString('utf8'),
    ) as readonly VoiceHistoryItem[];
    return { context, history };
  }
  /** Passive subscriptions do not consume the media iterator or grant execution authority. */
  on<Type extends NativeRealtimeEvent['type'] | 'event'>(
    type: Type,
    listener: (
      event: Type extends 'event'
        ? NativeRealtimeEvent
        : Extract<NativeRealtimeEvent, { type: Type }>,
    ) => unknown,
  ): () => void {
    return this.observers.on(
      type,
      listener as (event: NativeRealtimeEvent) => unknown,
    );
  }
  private call(operation: Command, params: JsonObject = {}): Promise<unknown> {
    return this.nativeCall(`realtime_conversation_${operation}_sdk`, {
      generation: this.#generation,
      ...params,
    });
  }
  /** @internal Admission remains retained if cancellation wins publication. */
  async _start(): Promise<this> {
    this.checkLive();
    const signal = this.options.signal;
    signal?.throwIfAborted();
    const aborted = Promise.withResolvers<never>();
    const abort = () => {
      this.startupAbort.abort(signal?.reason);
      aborted.reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const start = async (prepareParams: JsonObject) => {
        this.checkLive();
        let nativePreparation: Promise<unknown>;
        if (this.adapterSource) {
          if (!this.adapterBridge)
            throw new Error('Native adapter binding is unavailable');
          const handle = this.adapterBridge.create(this.#generation);
          this.adapterDriver = new NativeRealtimeAdapterDriver(
            this.adapterSource,
            handle,
            (callback) =>
              this.#context(() =>
                this.session._runVoiceCallback(callback, this),
              ),
          );
          nativePreparation = this.adapterBridge.prepare(
            { generation: this.#generation, ...prepareParams },
            handle,
          );
        } else nativePreparation = this.call('prepare', prepareParams);
        this.preparation = nativePreparation;
        const prepared = await nativePreparation;
        const receipt =
          typeof prepared === 'string' ? JSON.parse(prepared) : prepared;
        if (
          !receipt ||
          typeof receipt !== 'object' ||
          receipt.generation !== this.#generation
        )
          throw new Error(
            'Native Realtime preparation returned a different generation',
          );
        this.checkLive();
        const apiKey = await resolveRealtimeApiKey(
          this.credentialSource,
          this.startupAbort.signal,
        );
        this.checkLive();
        const admission = this.call('activate', { api_key: apiKey });
        this.admission = admission;
        return admission.then((raw) => {
          const receipt = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (receipt && typeof receipt === 'object') {
            if (typeof receipt.call_id === 'string')
              this.admittedCallId = receipt.call_id;
            if (typeof receipt.sdp === 'string')
              this.admittedAnswerSdp = receipt.sdp;
          }
          if (this.transport.type === 'webrtc' && !this.admittedAnswerSdp)
            throw new Error('Native WebRTC admission returned no SDP answer');
          return raw;
        });
      };
      const mcpPreparation =
        this.selectedTools === undefined
          ? this.session._prepareRealtimeMcp()
          : Promise.resolve();
      const preparation = mcpPreparation.then(async () => {
        signal?.throwIfAborted();
        this.checkLive();
        const hasConfig = this.session._hasRealtimeAgentConfiguration?.();
        const raw =
          hasConfig ||
          (this.selectedTools !== undefined &&
            (typeof this.options.instructions === 'function' ||
              this.options.isToolEnabled !== undefined))
            ? await this.session._realtimeSourceSnapshot()
            : undefined;
        const policyPreparation = this.#context(() =>
          resolveRealtimePolicy(
            this.session,
            this.options,
            this.startupAbort.signal,
            () => this.checkLive(),
            this.usage,
            raw,
          ),
        );
        this.preparation = policyPreparation;
        const policy = await policyPreparation;
        this.checkLive();
        const selection =
          this.selectedTools === undefined
            ? undefined
            : await this.session._realtimeFunctionTools(this.selectedTools, {
                snapshot: raw,
              });
        let config:
          | Awaited<ReturnType<typeof resolveRealtimeAgentConfiguration>>
          | undefined;
        if (hasConfig && raw) {
          const exact = this.session._realtimeConfigurationSource(
            raw.profile_receipt,
          );
          config = await this.#context(() =>
            this.session._runVoiceCallback(() =>
              resolveRealtimeAgentConfiguration({
                ...exact,
                selection: raw,
                selectedTools: selection?.tools,
                instructions: policy.instructions,
                settings: this.initialSettings ?? {},
                signal: this.startupAbort.signal,
              }),
            ),
          );
          this.checkLive();
          this.profileSource =
            raw.profile_receipt == null
              ? null
              : this.session._realtimeProfileTarget(raw.profile_receipt);
          this.setProfileGuardrails(this.profileSource, config.guardrails);
        }
        signal?.throwIfAborted();
        const prepareParams = realtimePrepareParams(
          {
            ...this.options,
            instructions: config ? config.instructions : policy.instructions,
          },
          this.transport,
          config?.settings ?? this.initialSettings,
          config?.tools ?? selection?.tools ?? null,
          config?.selectionId ??
            policy.selectionId ??
            selection?.selectionId ??
            null,
        );
        if (policy.disabledToolNames !== undefined)
          prepareParams.disabled_tool_names = policy.disabledToolNames;
        return start(prepareParams);
      });
      await Promise.race([preparation, aborted.promise, this.terminal.promise]);
      await Promise.race([
        this.ready.promise,
        aborted.promise,
        this.terminal.promise,
      ]);
      this.checkLive();
      return this;
    } catch (error) {
      const primary = this.adapterDriver?.failure
        ? this.adapterDriver.failure.error
        : error;
      this.startupFailed = true;
      this.finish(primary);
      try {
        await this.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [primary, cleanupError],
          'Native Realtime admission and cleanup failed',
          { cause: primary },
        );
      }
      throw primary;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  private checkLive(): void {
    if (!this.live || this.ended)
      throw this.failure
        ? this.failure.error
        : new Error('Native Realtime session is not open');
  }
  /**
   * Change supplied provider settings only; omitted fields retain their current values.
   * Call this outside this session's adapter callbacks.
   */
  async update(update: NativeRealtimeSessionUpdate): Promise<void> {
    this.checkLive();
    this.session._checkVoiceAdapterOperation(
      this,
      'update its own Realtime session',
    );
    const snapshot = serializeRealtimeSessionUpdate(update);
    await this.publishSettings(async () => {
      this.checkLive();
      await this.call('update', { update: snapshot });
      this.retainProfileOverrides(snapshot);
    });
  }

  private retainProfileOverrides(update: JsonObject): void {
    if (typeof update.instructions === 'string')
      this.profileOverrides.instructions = update.instructions;
    if (Object.hasOwn(update, 'prompt'))
      this.profileOverrides.prompt = copyJsonValue(update.prompt);
  }

  private publishSettings<T>(publish: () => Promise<T>): Promise<T> {
    const task = this.settingsTail.then(publish);
    this.settingsTail = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  /** Switch the voice agent on this connection after the provider accepts its configuration. */
  async updateAgent(agent: Agent<any, any>): Promise<void> {
    this.checkLive();
    this.session._checkVoiceOperation('change the Realtime agent in');
    return this.queueProfileUpdate(async () => {
      this.checkLive();
      const expected =
        this.profileSource === undefined
          ? await this.session._realtimeCurrentProfile()
          : this.profileSource;
      const previouslyAdmitted = this.voiceGraphAdmitted;
      const selection = await this.session._admitRealtimeGraph(
        this.#generation,
        agent,
        expected,
      );
      const target = this.session._realtimeProfileTarget(
        selection.profile_receipt,
      );
      this.voiceGraphAdmitted = true;
      let updateInvoked = false;
      try {
        await this.applyProfile(target, selection, undefined, true, () => {
          updateInvoked = true;
        });
      } catch (error) {
        if (!updateInvoked) {
          try {
            await this.session._discardRealtimeGraph(this.#generation, target);
            this.voiceGraphAdmitted = previouslyAdmitted;
          } catch (discardError) {
            this.finish(discardError);
            throw discardError;
          }
        } else {
          this.finish(error);
        }
        throw error;
      }
    });
  }

  private queueProfileUpdate(update: () => Promise<void>): Promise<void> {
    const task = this.retargetTail.then(update);
    this.retargetTail = task.catch(() => {});
    return task;
  }

  /** Return the Agent whose configuration the provider has accepted for this voice. */
  async getActiveAgent(): Promise<Agent<any, any>> {
    this.checkLive();
    const source =
      this.profileSource === undefined
        ? await this.session._realtimeCurrentProfile()
        : this.profileSource;
    this.checkLive();
    return this.session._realtimeConfigurationSource(source).agent;
  }

  private setProfileGuardrails(
    target: unknown,
    guardrails: readonly NativeRealtimeOutputGuardrail[],
  ): void {
    this.profileGuardrails.set(
      realtimeProfileKey(target),
      captureRealtimeGuardrails(guardrails),
    );
  }

  private async applyProfile(
    target: JsonObject | null,
    snapshot:
      Awaited<ReturnType<Session['_realtimeSourceSnapshot']>> | undefined,
    bound?:
      | {
          responseId: string;
          target: unknown;
          delegationId?: never;
          work?: NativeRealtimeToolBatch;
        }
      | { delegationId: string; responseId?: never; target?: never },
    resetPrompt = false,
    beforeNativeUpdate?: () => void,
  ): Promise<void> {
    await this.settingsTail;
    this.checkLive();
    const source =
      snapshot || this.session._hasRealtimeAgentConfiguration(target)
        ? this.session._realtimeConfigurationSource(target)
        : undefined;
    const raw =
      snapshot ??
      (source
        ? await this.session._realtimeSourceSnapshot(this.#generation, target)
        : undefined);
    const selection =
      this.selectedTools === undefined ||
      (this.voiceGraphAdmitted &&
        this.session._hasRetainedRealtimeProfile(target))
        ? undefined
        : await this.session._realtimeFunctionTools(this.selectedTools, {
            allowMissing: true,
            snapshot: raw,
          });
    const settings: JsonObject = Object.hasOwn(this.profileOverrides, 'prompt')
      ? { prompt: this.profileOverrides.prompt }
      : this.initialSettings?.prompt === undefined
        ? {}
        : { prompt: this.initialSettings.prompt };
    const policy = await this.#context(() =>
      resolveRealtimePolicy(
        this.session,
        {
          instructions:
            typeof this.profileOverrides.instructions === 'string'
              ? this.profileOverrides.instructions
              : typeof this.options.instructions === 'function'
                ? this.options.instructions
                : undefined,
          isToolEnabled: this.options.isToolEnabled,
        },
        this.startupAbort.signal,
        () => this.checkLive(),
        this.usage,
        raw,
      ),
    );
    const config =
      raw && source
        ? await this.#context(() =>
            this.session._runVoiceCallback(() =>
              resolveRealtimeAgentConfiguration({
                ...source,
                selection: raw,
                selectedTools: selection?.tools,
                instructions:
                  policy.instructions ??
                  (typeof this.options.instructions === 'string'
                    ? this.options.instructions
                    : undefined),
                settings,
                signal: this.startupAbort.signal,
              }),
            ),
          )
        : undefined;
    this.checkLive();
    if (
      bound?.responseId !== undefined &&
      this.retiredResponses.has(bound.responseId) &&
      (!bound.work ||
        bound.work.retired ||
        bound.work.responseId !== bound.responseId)
    )
      return;
    const update: JsonObject = { ...config?.settings };
    const instructions = config ? config.instructions : policy.instructions;
    if (instructions !== undefined) update.instructions = instructions;
    if (resetPrompt && update.prompt === undefined) update.prompt = null;
    await this.publishSettings(async () => {
      this.checkLive();
      if (
        bound?.responseId !== undefined &&
        this.retiredResponses.has(bound.responseId) &&
        (!bound.work ||
          bound.work.retired ||
          bound.work.responseId !== bound.responseId)
      )
        return;
      Object.assign(update, this.profileOverrides);
      if (config) this.setProfileGuardrails(target, config.guardrails);
      beforeNativeUpdate?.();
      const receipt = await this.call('update', {
        update,
        profile: {
          response_id: bound?.responseId ?? null,
          ...(bound?.delegationId === undefined
            ? {}
            : { delegation_id: bound.delegationId }),
          target,
          function_tools: config?.tools ?? selection?.tools ?? null,
          expected_selection_id:
            config?.selectionId ??
            selection?.selectionId ??
            policy.selectionId ??
            null,
          disabled_tool_names: policy.disabledToolNames ?? null,
        },
      });
      if (
        bound?.responseId !== undefined &&
        receipt &&
        typeof receipt === 'object' &&
        'applied' in receipt &&
        receipt.applied === false
      )
        return;
      this.profileSource = target;
    });
  }
  /**
   * Decide only an original issued request; clones, cross-owner objects and replay fail.
   * Call this outside this session's adapter callbacks.
   */
  async approveHostedMcp(
    request: NativeRealtimeHostedMcpApprovalRequest,
    decision: { readonly approve: boolean; readonly reason?: string },
  ): Promise<void> {
    this.checkLive();
    this.session._checkVoiceAdapterOperation(
      this,
      'approve hosted MCP in its own Realtime session',
    );
    const id = this.hostedApprovals.get(request);
    const pending = id ? this.pendingHostedApprovals.get(id) : undefined;
    if (!id || !pending || pending.retired)
      throw new TypeError(
        'Hosted MCP approval was not issued here or has already been submitted',
      );
    if (
      !decision ||
      typeof decision.approve !== 'boolean' ||
      (decision.reason !== undefined && typeof decision.reason !== 'string')
    )
      throw new TypeError(
        'Hosted MCP approval requires a boolean decision and optional string reason',
      );
    this.hostedApprovals.delete(request);
    pending.inFlight = true;
    try {
      await this.call('hosted_mcp_approval', {
        approval_id: id,
        approve: decision.approve,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      });
      this.pendingHostedApprovals.delete(id);
    } catch (error) {
      // Native consumes before a provider write; a live rejected admission can
      // be corrected and retried. Native still rejects an actually consumed ID.
      pending.inFlight = false;
      if (this.live && !this.ended && !pending.retired)
        this.hostedApprovals.set(request, id);
      else this.pendingHostedApprovals.delete(id);
      throw error;
    }
  }

  private retireHostedApprovals(responseIds?: ReadonlySet<string>): void {
    for (const [id, pending] of this.pendingHostedApprovals) {
      if (
        responseIds &&
        (pending.responseId === undefined ||
          !responseIds.has(pending.responseId))
      )
        continue;
      pending.retired = true;
      if (!pending.inFlight) this.pendingHostedApprovals.delete(id);
    }
  }

  /** @internal Refresh an authoritative source; Core owns provider ACK and continuation. */
  async _syncProfile(
    includeMono = false,
    bound?:
      | {
          responseId: string;
          target: unknown;
          delegationId?: never;
          work?: NativeRealtimeToolBatch;
        }
      | { delegationId: string; responseId?: never; target?: never },
  ): Promise<void> {
    this.checkLive();
    try {
      await this.queueProfileUpdate(async () => {
        this.checkLive();
        const retained =
          this.voiceGraphAdmitted &&
          this.session._hasRetainedRealtimeProfile(this.profileSource);
        if (retained && !bound) return;
        if (includeMono && this.selectedTools === undefined) {
          await this.session._prepareRealtimeMcp();
          this.checkLive();
        }
        const target =
          bound?.responseId !== undefined
            ? this.session._realtimeProfileTarget(bound.target)
            : retained
              ? (this.profileSource ?? null)
              : await this.session._realtimeCurrentProfile();
        if (
          target === null &&
          !includeMono &&
          bound?.delegationId === undefined
        )
          return;
        const targetRetained =
          this.voiceGraphAdmitted &&
          this.session._hasRetainedRealtimeProfile(target);
        const snapshot = targetRetained
          ? await this.session._realtimeSourceSnapshot(this.#generation, target)
          : undefined;
        await this.applyProfile(
          target,
          snapshot,
          bound,
          retained || targetRetained,
        );
      });
    } catch (error) {
      if (this.live) this.finish(error);
      throw error;
    }
  }

  private enqueueInput(
    send: () => Promise<void | { completion: Promise<void> }>,
    bytes = 0,
    capture?: () => void,
  ): Promise<void> {
    if (this.pendingCommittedAudio)
      this.session._checkVoiceAdapterOperation(
        this,
        'queue input while committed audio is pending',
      );
    if (
      this.inputCount >= INPUT_QUEUE_COUNT_LIMIT ||
      bytes > INPUT_QUEUE_BYTES_LIMIT - this.inputBytes
    )
      throw new RangeError(
        'Realtime input queue exceeds its 128 operation or 8 MiB limit',
      );
    this.inputCount++;
    this.inputBytes += bytes;
    try {
      capture?.();
    } catch (error) {
      this.inputCount--;
      this.inputBytes -= bytes;
      throw error;
    }
    const dispatched = this.inputTail.then(() => {
      this.checkLive();
      return send();
    });
    // A cancellation can join host callbacks that enqueue their own input.
    // Keep its allocation reserved while allowing that input after dispatch.
    this.inputTail = dispatched.then(
      () => {},
      () => {},
    );
    return dispatched
      .then((result) => (result ? result.completion : undefined))
      .finally(() => {
        this.inputCount--;
        this.inputBytes -= bytes;
      });
  }
  /** Send nonempty text within the 1 MiB UTF-8 user input limit. */
  async sendText(text: string): Promise<void> {
    this.checkLive();
    if (typeof text !== 'string')
      throw new TypeError('Realtime text must be nonempty');
    const bytes = userInputBytes(text);
    if (!text.trim()) throw new TypeError('Realtime text must be nonempty');
    await this.enqueueInput(async () => {
      await this.call('text', { text, role: 'user' });
    }, bytes);
  }
  /** Append up to 1024 parts and 1 MiB aggregate UTF-8 text/image input, then optionally respond. */
  async sendMessage(
    message: NativeRealtimeUserInput,
    options: { triggerResponse?: boolean } = {},
  ): Promise<void> {
    this.checkLive();
    if (
      typeof options !== 'object' ||
      options === null ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => key !== 'triggerResponse')
    )
      throw new TypeError(
        'Realtime message options only support triggerResponse',
      );
    const triggerResponse = options.triggerResponse;
    if (triggerResponse !== undefined && typeof triggerResponse !== 'boolean')
      throw new TypeError('Realtime triggerResponse must be a boolean');
    let content: JsonObject[];
    let bytes = 0;
    if (typeof message === 'string') {
      if (!message.length)
        throw new TypeError('Realtime user text must be nonempty');
      bytes = userInputBytes(message);
      content = [{ type: 'input_text', text: message }];
    } else {
      if (
        !message ||
        typeof message !== 'object' ||
        Array.isArray(message) ||
        Object.keys(message).some(
          (key) => !['type', 'role', 'content'].includes(key),
        )
      )
        throw new TypeError('Realtime input must be a user message');
      const { type, role, content: parts } = message;
      if (
        type !== 'message' ||
        role !== 'user' ||
        !Array.isArray(parts) ||
        !parts.length
      )
        throw new TypeError('Realtime input requires nonempty user content');
      if (parts.length > USER_INPUT_PARTS_LIMIT)
        throw new RangeError(
          'Realtime user content exceeds the 1024 part limit',
        );
      let remaining = USER_INPUT_BYTES_LIMIT;
      content = parts.map((part): JsonObject => {
        if (!part || typeof part !== 'object' || Array.isArray(part))
          throw new TypeError(
            'Realtime user content must be text or an inline image',
          );
        const type = part.type;
        if (type === 'input_text') {
          const text = part.text;
          if (
            Object.keys(part).some((key) => !['type', 'text'].includes(key)) ||
            typeof text !== 'string' ||
            !text.length
          )
            throw new TypeError('Realtime user text must be a nonempty string');
          remaining -= userInputBytes(text, remaining);
          return { type, text };
        }
        if (type === 'input_image') {
          const { image, detail } = part;
          if (
            Object.keys(part).some(
              (key) => !['type', 'image', 'detail'].includes(key),
            ) ||
            typeof image !== 'string' ||
            !image.length ||
            (detail !== undefined && !['auto', 'low', 'high'].includes(detail))
          )
            throw new TypeError(
              'Realtime input requires an inline image and supported detail',
            );
          remaining -= userInputBytes(image, remaining);
          return {
            type,
            image_url: image,
            ...(detail === undefined ? {} : { detail }),
          };
        }
        throw new TypeError(
          'Realtime user content must be text or an inline image',
        );
      });
      bytes = USER_INPUT_BYTES_LIMIT - remaining;
    }
    await this.enqueueInput(async () => {
      await this.call('input', {
        content,
        trigger_response: triggerResponse ?? true,
      });
    }, bytes);
  }
  /** Append an inline image within the 1 MiB UTF-8 input limit, optionally without a response. */
  async addImage(
    image: string,
    options: { triggerResponse?: boolean } = {},
  ): Promise<void> {
    await this.sendMessage(
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image }],
      },
      options,
    );
  }
  /** Request one response, optionally overriding the accepted configuration for this response. */
  async requestResponse(
    response?: NativeRealtimeResponseOptions,
  ): Promise<void> {
    this.checkLive();
    let captured: JsonObject | undefined;
    let bytes = 0;
    if (response !== undefined) {
      if (
        typeof response !== 'object' ||
        response === null ||
        Array.isArray(response) ||
        Object.keys(response).some(
          (key) =>
            !['instructions', 'outputModality', 'maxOutputTokens'].includes(
              key,
            ),
        )
      )
        throw new TypeError('Unsupported Realtime response options');
      const { instructions, outputModality, maxOutputTokens } = response;
      if (instructions !== undefined) bytes = userInputBytes(instructions);
      captured = {
        ...(instructions === undefined ? {} : { instructions }),
        ...(outputModality === undefined
          ? {}
          : { output_modality: outputModality }),
        ...(maxOutputTokens === undefined
          ? {}
          : { max_output_tokens: maxOutputTokens }),
      };
    }
    await this.enqueueInput(async () => {
      await this.call(
        'response',
        captured === undefined ? {} : { response: captured },
      );
    }, bytes);
  }
  /**
   * Send a provider event through the native connection.
   * Returns the provider item for conversation.item.retrieve, otherwise null.
   * Core validates managed controls and forwards other event types as JSON.
   * Linked responses can select advertised functions for one response.
   * Detached responses can declare functions that the caller handles.
   * Cancellation allows later input after dispatch and resolves after retirement.
   * Tool and approval authority remains with the native Session.
   */
  async sendEvent(event: RealtimeProviderObject): Promise<JsonObject | null> {
    this.checkLive();
    this.session._checkVoiceAdapterOperation(
      this,
      'send its own provider event',
    );
    if (!event || typeof event !== 'object' || Array.isArray(event))
      throw new TypeError('Realtime event must be a JSON object');
    const bytes = jsonAllocationBytes(
      event,
      INPUT_QUEUE_BYTES_LIMIT - this.inputBytes,
      'Realtime event exceeds the 8 MiB input queue allocation budget',
      true,
    );
    let snapshot: JsonObject;
    let result: JsonObject | null = null;
    this.pendingCommittedAudio++;
    try {
      await this.enqueueInput(
        async () => {
          if (snapshot.type === 'response.cancel') {
            const completion = this.interruptOwned(
              typeof snapshot.response_id === 'string'
                ? snapshot.response_id
                : undefined,
              {},
              undefined,
              () => this.call('send_event', { event: snapshot }),
            );
            void completion.catch(() => {});
            return { completion };
          }
          const send = () => this.call('send_event', { event: snapshot });
          const raw =
            snapshot.type === 'session.update'
              ? await this.publishSettings(async () => {
                  this.checkLive();
                  const accepted = await send();
                  const update = snapshot.session;
                  if (
                    update &&
                    typeof update === 'object' &&
                    !Array.isArray(update)
                  )
                    this.retainProfileOverrides(update);
                  return accepted;
                })
              : await send();
          const value: unknown =
            typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (
            value !== null &&
            (!value || typeof value !== 'object' || Array.isArray(value))
          )
            throw new Error('Native Realtime event returned an invalid result');
          result = value as JsonObject | null;
        },
        bytes,
        () => {
          snapshot = copyJsonValue(event) as JsonObject;
        },
      );
    } finally {
      this.pendingCommittedAudio--;
    }
    return result;
  }
  /**
   * Reconcile provider items observed during this connection with the supplied items.
   * Unobserved items, including SIP items from before attachment, remain outside
   * this replacement. Core validates the replacement before sending changes and
   * waits for provider acknowledgements. Edit supported messages and import
   * completed historical function call and output pairs as context. Surviving
   * tool, MCP, and approval rows retain exact content and relative order.
   * Settled rows can be removed. Supported messages can move
   * across surviving rows. A provider failure after some
   * acknowledgements can leave partial edits; retrieve observed history before
   * retrying. Canonical audit history, background work, and retained context for
   * subsequent Session turns remain intact. A synchronous updater receives a fresh
   * provider snapshot after preceding input. If provider history changes before
   * replacement, the operation rejects without retrying the updater.
   */
  async updateHistory(
    items:
      | readonly RealtimeProviderObject[]
      | ((history: JsonObject[]) => readonly RealtimeProviderObject[]),
  ): Promise<void> {
    this.checkLive();
    this.session._checkVoiceAdapterOperation(
      this,
      'update its own conversation history',
    );
    const checkItems = (value: unknown): void => {
      if (
        !Array.isArray(value) ||
        value.some(
          (item) => !item || typeof item !== 'object' || Array.isArray(item),
        )
      )
        throw new TypeError(
          'Realtime history must be an array of provider items',
        );
    };
    if (typeof items === 'function') {
      this.pendingCommittedAudio++;
      try {
        await this.enqueueInput(async () => {
          let retainedBytes = 0;
          const charge = (value: readonly object[]): void => {
            const bytes = jsonAllocationBytes(
              value,
              INPUT_QUEUE_BYTES_LIMIT - this.inputBytes,
              'Realtime history exceeds the 8 MiB input queue allocation budget',
              true,
            );
            this.inputBytes += bytes;
            retainedBytes += bytes;
          };
          try {
            const expected = await this.retrieveConversationHistory();
            this.checkLive();
            charge(expected);
            // Retain the comparison snapshot separately from mutable callback input.
            charge(expected);
            const updated = items(copyJsonValue(expected) as JsonObject[]);
            checkItems(updated);
            charge(updated);
            const snapshot = copyJsonValue(updated) as JsonObject[];
            this.checkLive();
            await this.call('update_history', {
              items: snapshot,
              expected_items: expected,
            });
          } finally {
            this.inputBytes -= retainedBytes;
          }
        });
      } finally {
        this.pendingCommittedAudio--;
      }
      return;
    }
    checkItems(items);
    const bytes = jsonAllocationBytes(
      items,
      INPUT_QUEUE_BYTES_LIMIT - this.inputBytes,
      'Realtime history exceeds the 8 MiB input queue allocation budget',
      true,
    );
    let snapshot: JsonObject[];
    await this.enqueueInput(
      async () => {
        await this.call('update_history', { items: snapshot });
      },
      bytes,
      () => {
        snapshot = copyJsonValue(items) as JsonObject[];
      },
    );
  }
  /**
   * Retrieve a known provider item with available media, even if it predates SIP
   * attachment. Retrieval does not add an unknown ID to observed history ordering.
   */
  async retrieveConversationItem(providerItemId: string): Promise<JsonObject> {
    this.checkLive();
    this.session._checkVoiceAdapterOperation(
      this,
      'retrieve its own conversation item',
    );
    if (typeof providerItemId !== 'string' || !providerItemId.trim())
      throw new TypeError('Realtime provider item ID must be nonempty');
    const raw = await this.call('retrieve_item', { item_id: providerItemId });
    const item: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('Native Realtime retrieval returned no provider item');
    return item as JsonObject;
  }
  /**
   * Retrieve available media for IDs observed during this connection, in observed
   * order. This cannot discover SIP items from before attachment and may be large.
   */
  async retrieveConversationHistory(): Promise<JsonObject[]> {
    this.checkLive();
    this.session._checkVoiceAdapterOperation(
      this,
      'retrieve its own conversation history',
    );
    const raw = await this.call('retrieve_history');
    const items: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (
      !Array.isArray(items) ||
      items.some(
        (item) => !item || typeof item !== 'object' || Array.isArray(item),
      )
    )
      throw new Error('Native Realtime retrieval returned no provider history');
    return items as JsonObject[];
  }
  /** Delete one provider conversation item after native dependency checks and durable ACK. */
  async deleteConversationItem(providerItemId: string): Promise<void> {
    this.checkLive();
    this.session._checkVoiceAdapterOperation(
      this,
      'delete its own conversation item',
    );
    const itemId = providerItemId;
    if (typeof itemId !== 'string' || !itemId.trim())
      throw new TypeError('Realtime provider item ID must be nonempty');
    await this.call('delete_item', { item_id: itemId });
  }
  /** Send immutable PCM16 samples, or explicitly encoded mono24kHz PCM/8kHz G.711.
   * Core checks the provider-accepted codec before admitting each bounded frame.
   * commit sends one input buffer commit after the final frame; omission only appends.
   */
  async sendAudio(
    audio: Int16Array | NativeRealtimeAudioInput,
    options: { commit?: boolean } = {},
  ): Promise<void> {
    this.checkLive();
    if (
      typeof options !== 'object' ||
      options === null ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => key !== 'commit')
    )
      throw new TypeError('Realtime audio options must be an object');
    const commit = options.commit;
    if (commit !== undefined && typeof commit !== 'boolean')
      throw new TypeError('Realtime audio commit must be a boolean');
    const samples = audio instanceof Int16Array;
    const format = samples ? 'pcm16' : audio?.format;
    const data = samples ? audio : audio?.data;
    if (
      !['pcm16', 'g711_ulaw', 'g711_alaw'].includes(format) ||
      !(samples ? data instanceof Int16Array : data instanceof Uint8Array) ||
      (!data.length && !commit)
    )
      throw new TypeError(
        'Realtime audio requires nonempty PCM16 samples or explicitly encoded PCM/G.711 bytes',
      );
    if (this.transport.type === 'existing_call' && data.length)
      throw new Error('SIP calls receive audio from the provider');
    const width = format === 'pcm16' ? 2 : 1;
    if (!samples && data.length % width)
      throw new TypeError('PCM16 audio requires complete two-byte samples');
    const frameSize = 32768 * (samples ? 1 : width);
    if (commit) {
      this.session._checkVoiceAdapterOperation(this, 'commit its own audio');
      this.pendingCommittedAudio++;
    }
    try {
      await this.enqueueInput(async () => {
        for (let offset = 0; offset < data.length; offset += frameSize) {
          this.checkLive();
          const count = Math.min(frameSize, data.length - offset);
          let bytes: Buffer;
          if (samples) {
            bytes = Buffer.alloc(count * 2);
            for (let i = 0; i < count; i++)
              bytes.writeInt16LE(data[offset + i], i * 2);
          } else
            bytes = Buffer.from(data.buffer, data.byteOffset + offset, count);
          await this.call('audio', {
            frame: {
              data: bytes.toString('base64'),
              format,
              sample_rate: format === 'pcm16' ? 24000 : 8000,
              num_channels: 1,
              samples_per_channel: samples ? count : count / width,
              item_id: null,
            },
          });
        }
        if (commit) {
          this.checkLive();
          await this.call('audio_commit');
        }
      }, data.buffer.byteLength);
    } finally {
      if (commit) this.pendingCommittedAudio--;
    }
  }
  /** Record audio actually played; buffering a received frame is not playback. */
  reportPlayback(position: NativeRealtimePlaybackPosition): void {
    this.checkLive();
    this.playback.report(position);
  }
  /** One pull consumer; once acquired, overflow terminates media without dropping. */
  async *events(): AsyncGenerator<NativeRealtimeEvent> {
    if (this.consuming)
      throw new Error('Native Realtime already has an event consumer');
    this.consuming = true;
    this.pullAcquired = true;
    try {
      for (;;) {
        const event = this.queue.shift();
        if (event) {
          this.queuedBytes -= this.eventBytes(event);
          yield event;
        } else if (this.ended) {
          if (this.failure) throw this.failure.error;
          yield { type: 'lifecycle', status: 'closed' };
          return;
        } else await this.changed.promise;
      }
    } finally {
      this.consuming = false;
    }
  }
  private wake(): void {
    this.changed.resolve();
    this.changed = Promise.withResolvers<void>();
  }
  private eventBytes(event: NativeRealtimeEvent): number {
    const fields =
      event.type === 'history'
        ? event.item
        : event.type === 'guardrail'
          ? event.input
          : event;
    let bytes = 128 + (event.type === 'audio' ? event.data.byteLength : 0);
    if (event.type === 'raw_provider_event')
      return bytes + jsonAllocationBytes(event.event, AUDIO_LIMIT - bytes);
    if (event.type === 'hosted_mcp_tools_listed')
      return hostedMcpCatalogBytes(
        event.tools,
        event.itemId,
        event.serverLabel,
        event.responseId,
        AUDIO_LIMIT,
      );
    if (event.type === 'hosted_mcp_call_completed' && event.error !== undefined)
      bytes += jsonAllocationBytes(event.error, AUDIO_LIMIT - bytes);
    if (event.type === 'response') {
      if (event.usage !== undefined)
        bytes += jsonAllocationBytes(event.usage, AUDIO_LIMIT - bytes);
      if (event.cumulativeUsage !== undefined)
        bytes += jsonAllocationBytes(
          event.cumulativeUsage,
          AUDIO_LIMIT - bytes,
        );
    }
    for (const value of Object.values(fields))
      if (typeof value === 'string') bytes += value.length * 4;
    return bytes;
  }
  private rollingObservation(): boolean {
    return !this.pullAcquired && this.observers.size > 0;
  }
  private emit(event: NativeRealtimeEvent): void {
    if (this.ended) return;
    const bytes = this.eventBytes(event);
    if (this.rollingObservation() && bytes <= AUDIO_LIMIT) {
      while (
        this.queue.length &&
        (this.queue.length >= EVENT_LIMIT ||
          this.queuedBytes + bytes > AUDIO_LIMIT)
      ) {
        this.queuedBytes -= this.eventBytes(this.queue.shift()!);
      }
    }
    if (
      this.queue.length >= EVENT_LIMIT ||
      this.queuedBytes + bytes > AUDIO_LIMIT
    ) {
      this.finish(
        new Error(
          'Native Realtime event buffer overflow; consume events promptly',
        ),
      );
      return;
    }
    this.queuedBytes += bytes;
    this.queue.push(event);
    this.wake();
    this.observers.emit(event);
  }
  private finish(...errors: [] | [unknown]): void {
    const wasEnded = this.ended;
    const failure =
      this.adapterDriver?.failure ??
      (errors.length ? { error: errors[0] } : undefined);
    this.live = false;
    this.startupAbort.abort(failure?.error);
    this.guardrails.stop();
    for (const owned of this.delegations.values()) owned.retired = true;
    for (const batch of this.toolBatches) batch.retired = true;
    if (!this.ended) {
      this.ended = true;
      this.observers.emit({ type: 'lifecycle', status: 'closed' });
      this.observers.close();
      this.failure = failure;
      this.queue.length = 0;
      this.queuedBytes = 0;
      this.terminal.resolve();
      this.wake();
    }
    if (!this.sessionClosing && !wasEnded) void this.close().catch(() => {});
  }
  /** @internal Reader control is synchronous and independent of public observers. */
  _ingest(event: NativeEvent): boolean {
    const msg = event.msg;
    if (!KINDS.has(msg.type)) return false;
    if (event.id !== this.#generation) return true;
    if (msg.type === 'realtime_conversation_closed') {
      this.nativeEnded.resolve();
      if (!this.ended)
        this.finish(
          new Error(
            'Native Realtime connection closed unexpectedly' +
              (typeof msg.reason === 'string' ? `: ${msg.reason}` : ''),
          ),
        );
      return true;
    }
    // Preserve Core's final history observations while media close joins.
    if (
      this.ended &&
      !(
        msg.type === 'realtime_conversation_realtime' &&
        msg.payload &&
        typeof msg.payload === 'object' &&
        !Array.isArray(msg.payload) &&
        Object.entries(msg.payload).some(
          ([key, value]) =>
            key.startsWith('History') ||
            (key === 'RawProviderEvent' &&
              value &&
              typeof value === 'object' &&
              'history_observation' in value &&
              value.history_observation === true),
        )
      )
    )
      return true;
    try {
      if (msg.type === 'realtime_conversation_started') {
        this.ready.resolve();
        this.emit({
          type: 'lifecycle',
          status: 'started',
          sessionId:
            typeof msg.realtime_session_id === 'string'
              ? msg.realtime_session_id
              : undefined,
        });
      } else if (msg.type === 'realtime_conversation_realtime') {
        this.payload(msg.payload, msg._sdk_native_input);
      }
    } catch (error) {
      this.finish(error);
    }
    return true;
  }
  /** @internal Unexpected reader termination must wake stalled players. */
  _readerClosed(): void {
    if (!this.sessionClosing)
      this.finish(new Error('Native Session event stream ended'));
  }
  private payload(raw: unknown, nativeInput: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new TypeError('Invalid native Realtime event');
    const entries = Object.entries(raw);
    if (entries.length !== 1)
      throw new TypeError('Invalid native Realtime payload');
    const outOfBand = entries[0][0] === 'DetachedResponse';
    const [name, value] = (
      outOfBand
        ? Object.entries(entries[0][1] as Record<string, unknown>)[0]
        : entries[0]
    ) as [string, any];
    if (name === 'RawProviderEvent') {
      if (value.history_observation) this._observeProviderFrame(value.event);
      if (this.options.includeRawProviderEvents)
        this.emit({ type: 'raw_provider_event', event: value.event });
    } else if (name === 'ProviderRequestError') {
      this.emit({
        type: 'provider_request_error',
        code: value.code ?? undefined,
        eventId: value.event_id ?? undefined,
      });
    } else if (name === 'HostedMcpApprovalRequested') {
      for (const key of [
        'approval_id',
        'request_id',
        'server_label',
        'tool_name',
        'arguments',
      ])
        if (
          typeof value[key] !== 'string' ||
          (key !== 'arguments' && !value[key])
        )
          throw new TypeError('Invalid native hosted MCP approval');
      if (
        this.retiredResponses.has(value.response_id) ||
        this.seenHostedApprovals.has(value.approval_id)
      )
        return;
      if (this.seenHostedApprovals.size >= HANDOFF_LIMIT) {
        for (const id of this.seenHostedApprovals) {
          if (!this.pendingHostedApprovals.has(id)) {
            this.seenHostedApprovals.delete(id);
            break;
          }
        }
        if (this.seenHostedApprovals.size >= HANDOFF_LIMIT)
          throw new Error('Hosted MCP approval capacity exceeded');
      }
      const request: NativeRealtimeHostedMcpApprovalRequest = Object.freeze({
        type: 'hosted_mcp_approval_requested',
        requestId: value.request_id,
        serverLabel: value.server_label,
        toolName: value.tool_name,
        arguments: value.arguments,
        responseId: value.response_id ?? undefined,
      });
      this.seenHostedApprovals.add(value.approval_id);
      this.pendingHostedApprovals.set(value.approval_id, {
        responseId:
          typeof value.response_id === 'string' ? value.response_id : undefined,
        inFlight: false,
        retired: false,
      });
      this.hostedApprovals.set(request, value.approval_id);
      this.emit(request);
    } else if (name === 'HostedMcpToolsListed') {
      if (!Array.isArray(value.tools))
        throw new TypeError('Invalid native hosted MCP tool list');
      if (this.queue.length >= EVENT_LIMIT && !this.rollingObservation())
        throw new Error(
          'Native Realtime event buffer overflow; consume events promptly',
        );
      hostedMcpCatalogBytes(
        value.tools,
        value.item_id,
        value.server_label,
        value.response_id,
        this.rollingObservation()
          ? AUDIO_LIMIT
          : AUDIO_LIMIT - this.queuedBytes,
      );
      this.emit(
        Object.freeze({
          type: 'hosted_mcp_tools_listed',
          itemId: value.item_id,
          serverLabel: value.server_label,
          responseId: value.response_id ?? undefined,
          tools: Object.freeze(
            value.tools.map(
              (tool: {
                name: string;
                description?: string;
                input_schema: JsonObject;
              }) =>
                Object.freeze({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: copyJsonValue(tool.input_schema) as JsonObject,
                }),
            ),
          ),
        }),
      );
    } else if (name === 'HostedMcpCallCompleted') {
      const completed: NativeRealtimeEvent = {
        type: 'hosted_mcp_call_completed',
        itemId: value.item_id,
        serverLabel: value.server_label,
        toolName: value.tool_name,
        arguments: value.arguments,
        responseId: value.response_id ?? undefined,
        output: value.output ?? undefined,
        error: value.error,
      };
      if (
        !this.rollingObservation() &&
        (this.queue.length >= EVENT_LIMIT ||
          this.eventBytes(completed) > AUDIO_LIMIT - this.queuedBytes)
      )
        throw new Error(
          'Native Realtime event buffer overflow; consume events promptly',
        );
      this.emit(
        Object.freeze({
          ...completed,
          error:
            completed.error === undefined
              ? undefined
              : copyJsonValue(completed.error),
        }),
      );
    } else if (name === 'FunctionBatchFinished') {
      if (typeof value.response_id !== 'string' || !value.response_id)
        throw new TypeError('Invalid native function-batch receipt');
      const sourceWork = [...this.toolBatches].find(
        (batch) => batch.responseId === value.response_id && !batch.retired,
      );
      for (const batch of this.toolBatches)
        if (batch.responseId === value.response_id) batch.complete();
      if (
        (this.retiredResponses.has(value.response_id) && !sourceWork) ||
        value.target == null
      )
        return;
      if (this.profileUpdates.size >= PENDING_LIMIT)
        throw new Error('Native Realtime profile update capacity exceeded');
      const task = this.#context(async () => {
        try {
          await this._syncProfile(false, {
            responseId: value.response_id,
            target: value.target,
            ...(sourceWork ? { work: sourceWork } : {}),
          });
        } catch (error) {
          // The owner records live failures. Retirement can reject an in-flight
          // ACK; joining that task is cleanup, not a new media failure.
          if (this.live) this.finish(error);
        }
      });
      this.profileUpdates.add(task);
      void task.then(
        () => this.profileUpdates.delete(task),
        (error) => {
          this.profileUpdates.delete(task);
          if (this.live) this.finish(error);
        },
      );
    } else if (name === 'HandoffRequested') {
      if (this.retiredResponses.has(value.response_id)) return;
      const id = value.handoff_id;
      if (typeof id !== 'string' || !id)
        throw new TypeError('Realtime handoff lacks identity');
      if (this.seen.has(id)) return;
      this.reclaimRequestId();
      if (
        this.seen.size >= HANDOFF_LIMIT ||
        this.delegations.size >= PENDING_LIMIT
      )
        throw new Error('Native Realtime delegation capacity exceeded');
      this.seen.add(id);
      const owned: Delegation = {
        workflow: new NativeSessionVoiceWorkflow(
          this.session as PublicSession<string>,
          this.selectedTools,
        ),
        retired: false,
        responseId:
          typeof value.response_id === 'string' ? value.response_id : undefined,
        sdkOwnershipId:
          typeof value.sdk_ownership_id === 'string'
            ? value.sdk_ownership_id
            : undefined,
      };
      this.delegations.set(id, owned);
      this.emit({ type: 'delegation', handoffId: id, status: 'started' });
      if (this.live) {
        owned.task = this.#context(() => this.delegate(id, nativeInput, owned));
        void owned.task.catch((error) => this.finish(error));
      }
    } else if (name === 'DetachedFunctionCall') {
      for (const key of [
        'response_id',
        'item_id',
        'call_id',
        'name',
        'arguments',
      ])
        if (
          typeof value[key] !== 'string' ||
          (key !== 'arguments' && !value[key])
        )
          throw new TypeError('Invalid native detached function call');
      this.emit({
        type: 'detached_function_call',
        responseId: value.response_id,
        itemId: value.item_id,
        callId: value.call_id,
        name: value.name,
        arguments: value.arguments,
      });
    } else if (name === 'FunctionCallRequested') {
      const id = value.call_id;
      if (
        typeof id !== 'string' ||
        !id ||
        typeof value.name !== 'string' ||
        !value.name
      )
        throw new TypeError('Native Realtime function request lacks identity');
      if (this.seen.has(id)) return;
      this.reclaimRequestId();
      const bytes = Buffer.byteLength(id) + Buffer.byteLength(value.name);
      const pending = [...this.functions.values()].filter(
        (record) => !record.batch && !record.retired,
      ).length;
      if (
        this.seen.size >= HANDOFF_LIMIT ||
        pending + this.toolBatches.size + this.delegations.size >=
          PENDING_LIMIT ||
        this.functionBytes + bytes > AUDIO_LIMIT
      )
        throw new Error('Native Realtime function capacity exceeded');
      const history = Buffer.from(
        this.conversation.serializeSnapshot(),
        'utf8',
      );
      if (this.functionHistoryBytes + history.byteLength > CALL_HISTORY_LIMIT)
        throw new RangeError(
          'Native Realtime call-history snapshot capacity exceeded',
        );
      this.seen.add(id);
      this.functionBytes += bytes;
      this.functionHistoryBytes += history.byteLength;
      this.functions.set(id, {
        name: value.name,
        itemId: typeof value.item_id === 'string' ? value.item_id : undefined,
        history,
        sourceProfile: value.source_profile,
        retired:
          typeof value.response_id === 'string' &&
          this.retiredResponses.has(value.response_id),
        responseId:
          typeof value.response_id === 'string' ? value.response_id : undefined,
      });
    } else if (name === 'FunctionCallRejected') {
      if (typeof value.call_id !== 'string' || typeof value.name !== 'string')
        throw new TypeError('Native unavailable function lacks identity');
      this.emit({
        type: 'function_call',
        callId: value.call_id,
        name: value.name,
        status: 'failed',
        error: new Error(`Tool ${value.name} not found`),
      });
    } else if (name === 'FunctionCallFinished') {
      const record = this.functions.get(value.call_id);
      if (!record) {
        if (this.seen.has(value.call_id)) return;
        throw new Error('Native Realtime result has no registered function');
      }
      this.emit({
        type: 'function_call',
        callId: value.call_id,
        name: record.name,
        status: value.succeeded ? 'completed' : 'failed',
        ...(record.error ? { error: record.error } : {}),
      });
      this.functionBytes -=
        Buffer.byteLength(value.call_id) + Buffer.byteLength(record.name);
      this.functionHistoryBytes -= record.history.byteLength;
      this.functions.delete(value.call_id);
    } else if (name === 'Error')
      throw new Error('Native Realtime transport failed', { cause: value });
    else if (name === 'AudioOut') {
      if (this.retiredResponses.has(value.response_id)) return;
      if (
        typeof value.data !== 'string' ||
        value.data.length > Math.floor((AUDIO_LIMIT * 4) / 3) + 4 ||
        /[^A-Za-z0-9+/=]/.test(value.data)
      )
        throw new TypeError('Invalid or oversized native Realtime audio');
      const decoded = Buffer.from(value.data, 'base64');
      if (decoded.toString('base64') !== value.data)
        throw new TypeError('Invalid native Realtime base64 audio');
      const audio: Extract<NativeRealtimeEvent, { type: 'audio' }> = {
        type: 'audio',
        data: new Uint8Array(decoded),
        sampleRate: value.sample_rate,
        channels: value.num_channels,
        itemId: value.item_id ?? undefined,
        responseId: value.response_id ?? undefined,
        format: value.format ?? undefined,
        contentIndex: value.content_index ?? undefined,
        outputIndex: value.output_index ?? undefined,
        ...(outOfBand ? { outOfBand: true } : {}),
      };
      if (!outOfBand && audio.itemId && audio.contentIndex !== undefined)
        this.conversation.observeAudio(
          audio.itemId,
          audio.contentIndex,
          audio.data,
          (audio.sampleRate *
            audio.channels *
            (audio.format === 'g711_ulaw' || audio.format === 'g711_alaw'
              ? 1
              : 2)) /
            1000,
        );
      this.playback.observe(audio);
      this.emit(audio);
    } else if (
      ['ResponseCreated', 'ResponseDone', 'ResponseCancelled'].includes(name)
    ) {
      const responseId =
        typeof value.response_id === 'string' ? value.response_id : undefined;
      if (responseId && name !== 'ResponseCreated')
        this.playback.complete(responseId);
      if (!outOfBand) {
        if (name === 'ResponseDone') this.startFunctionBatch(value);
        if (name === 'ResponseCreated') this.responseId = responseId;
        else if (!responseId || responseId === this.responseId)
          this.responseId = undefined;
      }
      let reportedUsage: NativeRealtimeUsage | undefined;
      if (
        name === 'ResponseDone' &&
        value.usage !== undefined &&
        value.usage !== null
      ) {
        const reported = reportedRealtimeUsage(value.usage);
        this.usageTotals = addRealtimeUsage(this.usageTotals ?? {}, reported);
        reportedUsage = structuredClone(reported) as NativeRealtimeUsage;
      }
      this.emit({
        type: 'response',
        usage: reportedUsage,
        cumulativeUsage: this.usage,
        status:
          name === 'ResponseCreated'
            ? 'created'
            : name === 'ResponseDone'
              ? 'done'
              : 'cancelled',
        responseId,
        ...(outOfBand ? { outOfBand: true } : {}),
      });
    } else if (
      [
        'InputTranscriptDelta',
        'InputTranscriptDone',
        'OutputTranscriptDelta',
        'OutputTranscriptDone',
      ].includes(name)
    ) {
      if (
        name.startsWith('Output') &&
        this.retiredResponses.has(value.response_id)
      )
        return;
      if (name.startsWith('Output'))
        this.guardrails.observe(value, name.endsWith('Done'), outOfBand);
      this.emit({
        type: 'text',
        role: name.startsWith('Input') ? 'user' : 'assistant',
        text: value.delta ?? value.text ?? '',
        final: name.endsWith('Done'),
        responseId: value.response_id ?? undefined,
        itemId: value.item_id ?? undefined,
        contentIndex: value.content_index ?? undefined,
        outputIndex: value.output_index ?? undefined,
        outputKind: value.output_kind ?? undefined,
        ...(outOfBand ? { outOfBand: true } : {}),
      });
    } else if (name === 'SessionUpdated')
      this.emit({
        type: 'lifecycle',
        status: 'updated',
        sessionId: value.realtime_session_id,
      });
    else if (name === 'InputAudioSpeechStarted')
      this.emit({ type: 'lifecycle', status: 'speech_started' });
    else if (name === 'InputAudioSpeechStopped')
      this.emit({ type: 'lifecycle', status: 'speech_stopped' });
    else if (name === 'ConversationItemObserved') {
      if (
        typeof value.item_id !== 'string' ||
        !value.item_id ||
        typeof value.kind !== 'string' ||
        !['added', 'done'].includes(value.status) ||
        (value.role != null && typeof value.role !== 'string') ||
        (value.call_id != null && typeof value.call_id !== 'string')
      )
        throw new TypeError('Invalid native provider conversation item');
      this.emit({
        type: 'conversation_item',
        itemId: value.item_id,
        kind: value.kind,
        status: value.status,
        role: value.role ?? undefined,
        callId: value.call_id ?? undefined,
      });
    } else if (name === 'ConversationItemDeleted') {
      if (typeof value.item_id !== 'string' || !value.item_id)
        throw new TypeError('Invalid native provider deletion receipt');
      this.emit({ type: 'conversation_item_deleted', itemId: value.item_id });
    } else if (
      name === 'HistoryItemStarted' ||
      name === 'HistoryItemCompleted'
    ) {
      const item: NativeRealtimeHistoryItem = Object.freeze({
        id: value.id,
        realtimeSessionId: value.realtime_session_id,
        kind: value.type,
        role: value.role,
        text: value.text,
        turnId: value.turn_id,
        itemId: value.item_id,
        providerItemId: value.provider_item_id,
        outcome: value.outcome,
        presentation: value.presentation?.type,
        presentationIndex: value.presentation?.index,
      });
      const old = this.canonical.get(item.id);
      const bytes =
        this.historyBytes +
        historyAllocationBytes(item) -
        (old ? historyAllocationBytes(old) : 0);
      if (bytes > HISTORY_LIMIT)
        throw new Error('Native Realtime history capacity exceeded');
      this.historyBytes = bytes;
      this.canonical.set(item.id, item);
      this.emit({
        type: 'history',
        item,
        completed: name === 'HistoryItemCompleted',
      });
    } else if (name === 'HistoryTranscriptDelta') {
      const old = this.canonical.get(value.item_id);
      if (!old)
        throw new Error('Native Realtime history delta has no canonical item');
      const priorLength = old.text?.length ?? 0;
      const work =
        priorLength && value.delta.length
          ? priorLength + value.delta.length
          : 0;
      const bytes = this.historyBytes + value.delta.length * 4;
      if (bytes > HISTORY_LIMIT)
        throw new Error('Native Realtime history capacity exceeded');
      // Bound prefix construction independently of event queue consumption.
      // Empty operands do not copy a prefix; replacements never reset work.
      if (this.historyTranscriptWork + work > HISTORY_TRANSCRIPT_WORK_LIMIT)
        throw new Error(
          'Native Realtime history transcript work capacity exceeded',
        );
      this.historyTranscriptWork += work;
      this.historyBytes = bytes;
      const item = Object.freeze({
        ...old,
        text: (old.text ?? '') + value.delta,
      });
      this.canonical.set(item.id, item);
      this.emit({ type: 'history', item, completed: false });
    }
  }
  private reclaimRequestId(): void {
    if (this.seen.size < HANDOFF_LIMIT) return;
    // Only terminal IDs may expire; active work retains its duplicate fence.
    for (const id of this.seen) {
      if (
        !this.functions.has(id) &&
        !this.delegations.has(id) &&
        ![...this.toolBatches].some((batch) => batch.callIds.includes(id))
      ) {
        this.seen.delete(id);
        return;
      }
    }
  }
  private retireResponse(id: string): void {
    if (this.retiredResponses.has(id)) return;
    if (this.retiredResponses.size >= HANDOFF_LIMIT) {
      for (const previous of this.retiredResponses) {
        if (
          previous !== this.responseId &&
          ![...this.functions.values()].some(
            (item) => item.responseId === previous,
          ) &&
          ![...this.delegations.values()].some(
            (item) => item.responseId === previous,
          ) &&
          ![...this.toolBatches].some((batch) => batch.responseId === previous)
        ) {
          this.retiredResponses.delete(previous);
          break;
        }
      }
      if (this.retiredResponses.size >= HANDOFF_LIMIT)
        throw new Error('Native Realtime retired response capacity exceeded');
    }
    this.retiredResponses.add(id);
  }
  private startFunctionBatch(value: {
    response_id?: unknown;
    function_call_ids?: unknown;
  }): void {
    if (
      !Array.isArray(value.function_call_ids) ||
      (typeof value.response_id === 'string' &&
        this.retiredResponses.has(value.response_id))
    )
      return;
    const ids = value.function_call_ids.filter(
      (id): id is string =>
        typeof id === 'string' &&
        this.functions.has(id) &&
        !this.functions.get(id)!.retired,
    );
    if (!ids.length || ids.every((id) => this.functions.get(id)!.batch)) return;
    const responseId = value.response_id;
    if (
      typeof responseId !== 'string' ||
      !responseId ||
      new Set(ids).size !== ids.length
    )
      throw new Error(
        'Native Realtime tool batch lacks exact response correlation',
      );
    for (const id of ids) {
      const record = this.functions.get(id)!;
      if (
        record.batch ||
        (record.responseId !== undefined && record.responseId !== responseId)
      )
        throw new Error('Native Realtime function belongs to another response');
    }
    const batch = new NativeRealtimeToolBatch(
      responseId,
      Object.freeze([...ids]),
      async (signal) => {
        const root = await this.session._submitRealtimeTools(
          this.#generation,
          responseId,
          ids,
          signal,
          async () => {
            if (this.options.isToolEnabled === undefined) return [];
            const disabled: string[] = [];
            for (const id of ids) {
              signal.throwIfAborted();
              const call = this.functions.get(id);
              if (!call || call.retired)
                throw new Error('Realtime call retired before dispatch');
              const source = this.session._realtimeHandoffSource(
                call.sourceProfile,
                call.name,
              );
              if (
                source &&
                !(await this._toolEnabled(
                  source.agent,
                  source.context,
                  call.name,
                  signal,
                  'handoff',
                ))
              ) {
                disabled.push(id);
                this._markToolUnavailable(id);
              }
            }
            return disabled;
          },
        );
        batch.root = root;
        this.observeToolsRoot(root, batch);
        return root;
      },
    );
    this.toolBatches.add(batch);
    for (const id of ids) {
      const record = this.functions.get(id)!;
      record.batch = batch;
      record.responseId = responseId;
      this.emit({
        type: 'function_call',
        callId: id,
        name: record.name,
        status: 'started',
      });
    }
    if (this.live) {
      batch.task = this.#context(() => this.runFunctionBatch(batch));
      void batch.task.catch((error) => this.finish(error));
    }
  }
  private observeToolsRoot(
    turn: Turn<unknown>,
    batch: NativeRealtimeToolBatch,
  ): void {
    let root = this.toolsRoots.get(turn);
    if (!root) {
      root = { turn, monitor: Promise.resolve(), settled: false };
      this.toolsRoots.set(turn, root);
      const captured = root;
      root.monitor = Promise.race([
        turn.wait(),
        this.toolsGraphClosed.promise,
      ]).then(
        () => {
          captured.settled = true;
          for (const owned of this.toolBatches)
            if (owned.root === turn && owned.retired) owned.retiredByCore();
        },
        (error) => {
          captured.settled = true;
          captured.failure = { error };
          const batches = [...this.toolBatches].filter(
            (owned) => owned.root === turn,
          );
          for (const owned of batches) owned.fail(error);
          if (
            this.live &&
            (!(error instanceof TurnAborted) ||
              batches.some((owned) => !owned.retired))
          )
            this.finish(error);
        },
      );
      this.toolsRootMonitors.add(root);
      void root.monitor.then(() => this.toolsRootMonitors.delete(captured));
    }
    // A receipt may arrive after its actual root's terminal observation. Reuse
    // that monitor without replacing or joining an unrelated newer root.
    if (root.settled) {
      if (root.failure) batch.fail(root.failure.error);
      else if (batch.retired) batch.retiredByCore();
    }
  }
  private async runFunctionBatch(
    batch: NativeRealtimeToolBatch,
  ): Promise<void> {
    let primary: { error: unknown } | undefined;
    let providerFailed = false;
    try {
      await batch.run();
    } catch (error) {
      primary = { error };
      if (this.live && !batch.retired) {
        this.emit({
          type: 'tool_batch_error',
          responseId: batch.responseId,
          callIds: batch.callIds,
          error,
        });
        if (!batch.admitted) {
          try {
            for (const id of batch.callIds)
              await this.call('fail', { handoff_id: id });
          } catch {
            providerFailed = true;
          }
        }
      }
    }
    if (batch.cleaned) this.toolBatches.delete(batch);
    if (primary && (!batch.cleaned || providerFailed)) throw primary.error;
  }

  private async delegate(
    id: string,
    input: unknown,
    owned: Delegation,
  ): Promise<void> {
    let primary: { error: unknown } | undefined;
    let providerFailed = false;
    try {
      if (!owned.retired) {
        if (typeof input !== 'string' || !input.trim())
          throw new Error('Native Realtime delegation lacks prepared input');
        let accepted = '';
        for await (const text of owned.workflow.run(input)) accepted += text;
        if (this.live && !owned.retired) {
          await this._syncProfile(false, { delegationId: id });
          if (this.live && !owned.retired) {
            await this.call('complete', { handoff_id: id, text: accepted });
            this.emit({
              type: 'delegation',
              handoffId: id,
              status: 'completed',
            });
          }
        }
      }
    } catch (error) {
      primary = { error };
      if (this.live && !owned.retired) {
        try {
          await this.call('fail', { handoff_id: id });
        } catch {
          providerFailed = true;
        }
        this.emit({
          type: 'delegation',
          handoffId: id,
          status: 'failed',
          error,
        });
      }
    }
    try {
      await owned.workflow.cancel();
    } catch (cleanupError) {
      throw primary ? primary.error : cleanupError;
    }
    if (this.delegations.get(id) === owned) this.delegations.delete(id);
    if (providerFailed) throw primary!.error;
  }
  /** Interrupt exact response output, or current output/backend work when omitted.
   * cancelTools:false: speech interruption with admitted SDK tool work retained.
   * Unstarted background requests: ordinary retirement.
   * Default interruption, accepted interrupting user speech, and close: tool cancellation.
   * Default barge-in may truncate an older playing item while cancelling newer speech.
   * Native interruption failures close the media owner; call close() to join cleanup.
   */
  async interrupt(
    responseId?: string,
    options: {
      playback?: NativeRealtimePlaybackPosition;
      feedback?: string;
      cancelTools?: boolean;
    } = {},
  ): Promise<void> {
    return this.interruptOwned(responseId, options);
  }
  private async interruptOwned(
    responseId?: string,
    options: {
      playback?: NativeRealtimePlaybackPosition;
      feedback?: string;
      cancelTools?: boolean;
    } = {},
    excludeWorker?: NativeRealtimeGuardrailWork,
    nativeInterrupt?: () => Promise<unknown>,
  ): Promise<void> {
    this.session._checkVoiceOperation('interrupt Realtime in');
    this.checkLive();
    if (
      options.cancelTools !== undefined &&
      typeof options.cancelTools !== 'boolean'
    )
      throw new TypeError('cancelTools must be boolean');
    const cancelTools = options.cancelTools !== false;
    if (
      responseId !== undefined &&
      (typeof responseId !== 'string' || !responseId)
    )
      throw new TypeError('responseId must be nonempty');
    if (
      options.feedback !== undefined &&
      (responseId === undefined ||
        typeof options.feedback !== 'string' ||
        !options.feedback.trim())
    )
      throw new TypeError(
        'Feedback requires an explicit responseId and nonempty developer text',
      );
    if (
      options.playback &&
      responseId !== undefined &&
      options.playback.responseId !== responseId
    )
      throw new TypeError('Playback must match the explicit responseId');
    // Raw events must pass native schema validation before local retirement.
    const dispatched = nativeInterrupt
      ? { receipt: await nativeInterrupt() }
      : undefined;
    const playback = options.playback
      ? this.playback.report(options.playback)
      : undefined;
    // Typed interruption fences current work before dispatch. A raw event has
    // already dispatched, so only its receipt may identify retired work.
    const matchesInitial = (id: string | undefined) =>
      !dispatched && (responseId === undefined || id === responseId);
    if (!dispatched && responseId !== undefined)
      this.retireResponse(responseId);
    for (const record of this.functions.values())
      if (cancelTools && matchesInitial(record.responseId))
        record.retired = true;
    const initialOwnedEntries = [...this.delegations].filter(([, item]) =>
      matchesInitial(item.responseId),
    );
    const initialOwned = initialOwnedEntries.map(([, item]) => item);
    const owned = cancelTools ? initialOwned.slice() : [];
    owned.forEach((item) => {
      item.retired = true;
    });
    for (let i = this.queue.length - 1; i >= 0; i--)
      if (
        this.queue[i].type === 'audio' &&
        (responseId !== undefined ||
          !(this.queue[i] as { outOfBand?: true }).outOfBand) &&
        matchesInitial((this.queue[i] as { responseId?: string }).responseId)
      ) {
        this.queuedBytes -= this.eventBytes(this.queue[i]);
        this.queue.splice(i, 1);
      }
    const initialBatches = [...this.toolBatches].filter((batch) =>
      matchesInitial(batch.responseId),
    );
    const batches = cancelTools ? initialBatches.slice() : [];
    // Retire admission immediately. Core owns response-scoped native cancellation.
    const guardWork = this.guardrails.retire(
      dispatched
        ? new Set<string>()
        : responseId === undefined
          ? undefined
          : new Set([responseId]),
      { linkedOnly: responseId === undefined },
    );
    const joining = Promise.allSettled([
      this.guardrails.join(guardWork, excludeWorker),
      ...owned.map((item) => item.workflow.cancel()),
      ...batches.map((batch) => batch.cancel()),
    ]);
    let failure: { error: unknown } | undefined;
    let joinedRoots = new Set<string>();
    let retired = new Set<string>();
    try {
      const raw = dispatched
        ? dispatched.receipt
        : await this.call('interrupt', {
            response_id: responseId ?? null,
            playback: playbackPayload(playback),
            feedback: options.feedback ?? null,
            ...(cancelTools
              ? {}
              : {
                  cancel_tools: false,
                  owned_handoffs: initialOwnedEntries.flatMap(([id, item]) =>
                    !item.retired && item.sdkOwnershipId !== undefined
                      ? [[id, item.responseId ?? null, item.sdkOwnershipId]]
                      : [],
                  ),
                }),
          });
      const receipt = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const preservedIds = receipt?.preserved_call_ids ?? [];
      if (
        !receipt ||
        !Array.isArray(preservedIds) ||
        preservedIds.some((id: unknown) => typeof id !== 'string' || !id) ||
        new Set(preservedIds).size !== preservedIds.length ||
        (cancelTools && preservedIds.length !== 0) ||
        !Array.isArray(receipt.retired_response_ids) ||
        receipt.retired_response_ids.some(
          (id: unknown) => typeof id !== 'string' || !id,
        ) ||
        (receipt.cancelled_response_id != null &&
          typeof receipt.cancelled_response_id !== 'string') ||
        (receipt.joined_root_turn_ids !== undefined &&
          (!Array.isArray(receipt.joined_root_turn_ids) ||
            receipt.joined_root_turn_ids.some(
              (id: unknown) => typeof id !== 'string' || !id,
            )))
      )
        throw new Error(
          'Native Realtime interruption lacks an authoritative effect receipt',
        );
      const preserved = new Set<string>(preservedIds);
      const keptDelegations = new Set(
        initialOwnedEntries
          .filter(([id]) => preserved.has(id))
          .map(([, item]) => item),
      );
      const keptBatches = new Set(
        initialBatches.filter((batch) =>
          batch.callIds.some((id) => preserved.has(id)),
        ),
      );
      const keepBatch = (batch: NativeRealtimeToolBatch) =>
        keptBatches.has(batch);
      joinedRoots = new Set<string>(receipt.joined_root_turn_ids ?? []);
      retired = new Set<string>(receipt.retired_response_ids);
      for (const id of retired) this.retireResponse(id);
      this.retireHostedApprovals(retired);
      this.playback.retire(retired);
      for (const record of this.functions.values())
        if (
          record.responseId !== undefined &&
          retired.has(record.responseId) &&
          !(record.batch && keepBatch(record.batch))
        )
          record.retired = true;
      const lateOwned = [...this.delegations.values()].filter(
        (item) =>
          !keptDelegations.has(item) &&
          (initialOwned.includes(item) ||
            (item.responseId !== undefined && retired.has(item.responseId))) &&
          !owned.includes(item),
      );
      const lateBatches = [...this.toolBatches].filter(
        (batch) =>
          !keepBatch(batch) &&
          (initialBatches.includes(batch) || retired.has(batch.responseId)) &&
          !batches.includes(batch),
      );
      for (const item of lateOwned) item.retired = true;
      const lateGuardWork = this.guardrails.retire(retired);
      const lateJoining = Promise.allSettled([
        this.guardrails.join(lateGuardWork, excludeWorker),
        ...lateOwned.map((item) => item.workflow.cancel()),
        ...lateBatches.map((batch) => batch.cancel()),
      ]);
      owned.push(...lateOwned);
      batches.push(...lateBatches);
      for (const batch of batches) batch.retiredByCore();
      for (let i = this.queue.length - 1; i >= 0; i--) {
        const event = this.queue[i];
        if (
          (event.type === 'audio' || event.type === 'text') &&
          event.responseId !== undefined &&
          retired.has(event.responseId)
        ) {
          this.queuedBytes -= this.eventBytes(event);
          this.queue.splice(i, 1);
        }
      }
      this.emit({
        type: 'playback_interrupted',
        responseId,
        playback,
        retiredResponseIds: Object.freeze([...retired]),
        cancelledResponseId: receipt.cancelled_response_id ?? undefined,
      });
      const lateFailure = (await lateJoining).find(
        (result) => result.status === 'rejected',
      );
      if (lateFailure?.status === 'rejected') throw lateFailure.reason;
    } catch (error) {
      // Local cancellation already fenced publication; an uncertain native
      // result cannot leave that partially retired owner accepting more work.
      this.finish(error);
      failure = { error };
    }
    if (failure) throw failure.error;
    const cleanup = await joining;
    const failed = cleanup.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    await Promise.all([
      ...owned.flatMap((item) => (item.task ? [item.task] : [])),
      ...batches.flatMap((batch) => (batch.task ? [batch.task] : [])),
    ]);
    // Core names only roots it sealed and joined. A delayed attachment may
    // share a live sibling root, which this response must never wait for.
    const monitors = new Set(this.toolsRootMonitors);
    for (const batch of batches) {
      const root = batch.root && this.toolsRoots.get(batch.root);
      if (root) monitors.add(root);
    }
    for (const root of monitors) {
      if (!joinedRoots.has(root.turn.turnId)) continue;
      await root.monitor;
      if (root.failure && !(root.failure.error instanceof TurnAborted))
        throw root.failure.error;
    }
    // Native retirement need not emit FunctionCallFinished. Its exact receipt
    // plus joined batch cleanup is terminal evidence for these host records.
    for (const [id, record] of this.functions) {
      if (
        record.responseId !== undefined &&
        retired.has(record.responseId) &&
        (!record.batch || record.batch.cleaned)
      ) {
        this.functionBytes -=
          Buffer.byteLength(id) + Buffer.byteLength(record.name);
        this.functionHistoryBytes -= record.history.byteLength;
        this.functions.delete(id);
      }
    }
  }
  /** @internal Session fences results before its broader graph cleanup begins. */
  _retireFromSession(): void {
    this.sessionClosing = true;
    this.finish();
  }
  /** @internal Called only after native graph shutdown, before publishing Session close. */
  async _nativeShutdown(): Promise<void> {
    // The native capability rejects until the original Thread slot is released.
    // Its retained manager/runtime do not keep the Session or Engine alive.
    this.closeNative = () => this.closeAfterGraph(this.#generation);
    this.nativeEnded.resolve();
    this.toolsGraphClosed.resolve();
    for (const item of this.delegations.values())
      voiceWorkflowGraphClosed(item.workflow);
    for (const batch of this.toolBatches) batch.afterGraphClosed();
    await this.closing?.catch(() => {});
    await this.close();
  }
  close(): Promise<void> {
    this.session._checkVoiceOperation('close Realtime in');
    this.live = false;
    this.startupAbort.abort();
    const guardWork = this.guardrails.stop();
    for (const item of this.delegations.values()) item.retired = true;
    for (const batch of this.toolBatches) batch.retired = true;
    if (!this.ended) {
      this.ended = true;
      this.observers.emit({ type: 'lifecycle', status: 'closed' });
      this.observers.close();
      this.queue.length = 0;
      this.queuedBytes = 0;
      this.terminal.resolve();
      this.wake();
    }
    return (this.closing ??= (async () => {
      const owned = [...this.delegations.values()];
      const batches = [...this.toolBatches];
      const joining = Promise.allSettled([
        this.guardrails.join(guardWork),
        ...owned.map((item) => item.workflow.cancel()),
        ...batches.map((batch) => batch.cancel()),
      ]);
      let mediaFailure: { error: unknown } | undefined;
      try {
        // Core cancellation must run while allocation/readiness is pending.
        if (!this.nativeClosed) await this.closeNative();
        for (const batch of this.toolBatches) batch.retiredByCore();
        await this.preparation?.catch(() => {});
        const admitted = await this.admission?.then(
          () => true,
          () => false,
        );
        // A failed start can be confirmed idle without publishing Closed.
        // Successful admission still joins the authoritative history tail.
        if (admitted && !this.nativeClosed) await this.nativeEnded.promise;
        this.nativeClosed = true;
        await this.adapterDriver?.finish();
      } catch (error) {
        mediaFailure = this.adapterDriver?.cleanupFailure ?? { error };
      }
      if (mediaFailure) throw mediaFailure.error;
      const results = await joining;
      const tasks = await Promise.allSettled([
        this.retargetTail,
        this.settingsTail,
        ...this.profileUpdates,
        ...owned.flatMap((item) => (item.task ? [item.task] : [])),
        ...batches.flatMap((batch) => (batch.task ? [batch.task] : [])),
      ]);
      await Promise.all(
        [...this.toolsRootMonitors].map((root) => root.monitor),
      );
      if (this.voiceGraphAdmitted)
        await this.session._releaseRealtimeGraph(this.#generation);
      this.profileGuardrails.clear();
      const failure = [...results, ...tasks].find(
        (result) => result.status === 'rejected',
      );
      if (failure?.status === 'rejected') throw failure.reason;
      this.retireHostedApprovals();
      this.functions.clear();
      this.functionBytes = 0;
      this.functionHistoryBytes = 0;
      this.release();
    })().catch((error) => {
      this.closing = undefined;
      throw error;
    }));
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

/** The public media owner deliberately excludes graph-shutdown/control capabilities. */
export type NativeRealtimeSession = Pick<
  NativeRealtimeOwner,
  | 'history'
  | 'providerHistory'
  | 'on'
  | 'usage'
  | 'callId'
  | 'answerSdp'
  | 'reportPlayback'
  | 'sendText'
  | 'sendMessage'
  | 'addImage'
  | 'requestResponse'
  | 'sendEvent'
  | 'deleteConversationItem'
  | 'updateHistory'
  | 'retrieveConversationItem'
  | 'retrieveConversationHistory'
  | 'update'
  | 'updateAgent'
  | 'getActiveAgent'
  | 'approveHostedMcp'
  | 'sendAudio'
  | 'events'
  | 'interrupt'
  | 'close'
  | typeof Symbol.asyncDispose
>;

/** @internal Only Session.realtime publishes this private owner. */
export function createNativeRealtimeOwner(
  ...args: ConstructorParameters<typeof NativeRealtimeOwner>
): NativeRealtimeOwner {
  return new NativeRealtimeOwner(...args);
}
