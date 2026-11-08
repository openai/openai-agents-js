import {
  NativeRealtimeGuardrails,
  type NativeRealtimeOutputGuardrail,
  type NativeRealtimeGuardrailEvent,
  type NativeRealtimeGuardrailWork,
} from './realtime-guardrails';
import type { FunctionTool } from './tools';
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
import { randomUUID } from 'node:crypto';
import type { Session as PublicSession } from './public-agent';
import type { Session } from './session';
import type { NativeEvent } from './events';
import { copyJsonValue, type JsonObject, type JsonValue } from './binding';
import {
  NativeSessionVoiceWorkflow,
  voiceWorkflowGraphClosed,
} from '../voice/workflow';

export interface NativeRealtimeOptions {
  model?: string;
  voice?: string;
  instructions?: string;
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
}
export interface NativeRealtimeHistoryItem {
  readonly id: string;
  readonly realtimeSessionId: string;
  readonly kind: string;
  readonly role?: string;
  readonly text?: string;
  readonly turnId?: string;
  readonly itemId?: string;
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
    }
  | {
      type: 'delegation';
      handoffId: string;
      status: 'started' | 'completed' | 'failed';
      /** Original application-side failure; never sent to the speech provider. */
      error?: unknown;
    }
  | { type: 'history'; item: NativeRealtimeHistoryItem; completed: boolean }
  | {
      type: 'function_call';
      callId: string;
      name: string;
      status: 'started' | 'completed' | 'failed';
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
  | 'text'
  | 'complete'
  | 'fail'
  | 'interrupt'
  | 'close';
export type NativeRealtimeCall = (
  operation: `realtime_conversation_${Command}_sdk`,
  params: JsonObject,
) => Promise<unknown>;
interface Delegation {
  workflow: NativeSessionVoiceWorkflow;
  retired: boolean;
  responseId?: string;
  task?: Promise<void>;
}
const KINDS = new Set([
  'realtime_conversation_started',
  'realtime_conversation_realtime',
  'realtime_conversation_closed',
  'realtime_conversation_sdp',
]);
const EVENT_LIMIT = 128;
const AUDIO_LIMIT = 2 * 1024 * 1024;
const HANDOFF_LIMIT = 1024;
const PENDING_LIMIT = 16;

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
  private readonly functions = new Map<
    string,
    {
      name: string;
      responseId?: string;
      batch?: NativeRealtimeToolBatch;
      retired: boolean;
    }
  >();
  private readonly toolBatches = new Set<NativeRealtimeToolBatch>();
  private functionBytes = 0;
  private readonly hostedApprovals = new WeakMap<
    NativeRealtimeHostedMcpApprovalRequest,
    string
  >();
  private readonly seenHostedApprovals = new Set<string>();
  private readonly profileUpdates = new Set<Promise<void>>();
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
  private sessionClosing = false;
  private consuming = false;
  private queuedBytes = 0;
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
    this.selectedTools =
      options.tools === undefined
        ? undefined
        : Object.freeze([...options.tools]);
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
    )
      this.transport = {
        type: 'existing_call',
        call_id: options.transport.callId,
      };
    else
      throw new TypeError(
        'Realtime transport requires a WebRTC offerSdp or SIP callId',
      );
    this.initialSettings = options.settings
      ? serializeRealtimeSettings(options.settings)
      : null;
    this.guardrails = new NativeRealtimeGuardrails({
      guardrails: options.outputGuardrails ?? [],
      threshold: options.guardrailTextThreshold,
      source: (receipt) => this.session._realtimeGuardrailSource(receipt),
      invoke: (callback) =>
        this.#context(() => this.session._runVoiceCallback(callback)),
      trip: (input, feedback, worker) =>
        this.interruptOwned(
          input.responseId,
          {
            feedback,
            playback:
              input.contentIndex === undefined
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
  get history(): readonly NativeRealtimeHistoryItem[] {
    return Object.freeze(
      [...this.canonical.values()].map((item) => Object.freeze({ ...item })),
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
      const start = async (
        functionTools: JsonObject[] | null,
        expectedSelectionId: string | null = null,
      ) => {
        this.checkLive();
        const prepareParams: JsonObject = {
          function_tools: functionTools,
          hosted_mcp_auto_response:
            this.options.automaticallyTriggerResponseForMcpToolCalls ?? true,
          expected_selection_id: expectedSelectionId,
          settings: this.initialSettings,
          params: {
            client_managed_handoffs: true,
            delegation_ack_filler: null,
            flush_transcript_tail_on_session_end: true,
            codex_responses_as_items: false,
            codex_response_item_prefix: null,
            codex_response_handoff_mode: 'thinking',
            backend_reasoning_status: false,
            codex_response_handoff_channel_prefixes: null,
            model: this.options.model ?? null,
            output_modality: 'audio',
            include_startup_context: false,
            initial_items: [],
            realtime_start_instructions: null,
            realtime_end_instructions: null,
            prompt: this.options.instructions ?? null,
            realtime_session_id: null,
            transport: this.transport,
            version: 'v2',
            voice: this.options.voice ?? null,
          },
        };
        if (this.adapterSource) {
          if (!this.adapterBridge)
            throw new Error('Native adapter binding is unavailable');
          const handle = this.adapterBridge.create(this.#generation);
          this.adapterDriver = new NativeRealtimeAdapterDriver(
            this.adapterSource,
            handle,
            (callback) =>
              this.#context(() => this.session._runVoiceCallback(callback)),
          );
          this.preparation = this.adapterBridge.prepare(
            { generation: this.#generation, ...prepareParams },
            handle,
          );
        } else this.preparation = this.call('prepare', prepareParams);
        const prepared = await this.preparation;
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
      const preparation =
        this.selectedTools === undefined
          ? start(null)
          : this.session
              ._realtimeFunctionTools(this.selectedTools)
              .then((tools) => {
                signal?.throwIfAborted();
                if (!this.live)
                  throw new Error('Native Realtime admission stopped');
                return start(tools.tools, tools.selectionId);
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
  /** Change supplied provider settings only; omitted fields retain their current values. */
  async update(update: NativeRealtimeSessionUpdate): Promise<void> {
    this.checkLive();
    await this.call('update', {
      update: serializeRealtimeSessionUpdate(update),
    });
  }
  /** Decide only an original issued request; clones, cross-owner objects and replay fail. */
  async approveHostedMcp(
    request: NativeRealtimeHostedMcpApprovalRequest,
    decision: { readonly approve: boolean; readonly reason?: string },
  ): Promise<void> {
    this.checkLive();
    const id = this.hostedApprovals.get(request);
    if (!id)
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
    try {
      await this.call('hosted_mcp_approval', {
        approval_id: id,
        approve: decision.approve,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      });
    } catch (error) {
      // Native consumes before a provider write; a live rejected admission can
      // be corrected and retried. Native still rejects an actually consumed ID.
      if (this.live && !this.ended) this.hostedApprovals.set(request, id);
      throw error;
    }
  }

  /** @internal Refresh an authoritative source; Core owns provider ACK and continuation. */
  async _syncProfile(
    includeMono = false,
    bound?: { responseId: string; target: unknown },
  ): Promise<void> {
    this.checkLive();
    try {
      const target = bound
        ? this.session._realtimeProfileTarget(bound.target)
        : await this.session._realtimeCurrentProfile();
      if (target === null && !includeMono) return;
      const selection =
        this.selectedTools === undefined
          ? undefined
          : await this.session._realtimeFunctionTools(this.selectedTools, {
              allowMissing: true,
            });
      this.checkLive();
      await this.call('update', {
        update: {},
        profile: {
          response_id: bound?.responseId ?? null,
          target,
          function_tools: selection?.tools ?? null,
          expected_selection_id: selection?.selectionId ?? null,
        },
      });
    } catch (error) {
      if (this.live) this.finish(error);
      throw error;
    }
  }

  async sendText(text: string): Promise<void> {
    this.checkLive();
    if (typeof text !== 'string' || !text.trim())
      throw new TypeError('Realtime text must be nonempty');
    await this.call('text', { text, role: 'user' });
  }
  /** Send immutable PCM16 samples, or explicitly encoded mono24kHz PCM/8kHz G.711.
   * Core checks the provider-accepted codec before admitting each bounded frame.
   */
  async sendAudio(audio: Int16Array | NativeRealtimeAudioInput): Promise<void> {
    this.checkLive();
    if (this.transport.type === 'existing_call')
      throw new Error('SIP calls receive audio from the provider');
    const samples = audio instanceof Int16Array;
    const format = samples ? 'pcm16' : audio?.format;
    const data = samples ? audio : audio?.data;
    if (
      !['pcm16', 'g711_ulaw', 'g711_alaw'].includes(format) ||
      !(samples ? data instanceof Int16Array : data instanceof Uint8Array) ||
      !data.length
    )
      throw new TypeError(
        'Realtime audio requires nonempty PCM16 samples or explicitly encoded PCM/G.711 bytes',
      );
    const width = format === 'pcm16' ? 2 : 1;
    if (!samples && data.length % width)
      throw new TypeError('PCM16 audio requires complete two-byte samples');
    const frameSize = 32768 * (samples ? 1 : width);
    for (let offset = 0; offset < data.length; offset += frameSize) {
      this.checkLive();
      const count = Math.min(frameSize, data.length - offset);
      let bytes: Buffer;
      if (samples) {
        bytes = Buffer.alloc(count * 2);
        for (let i = 0; i < count; i++)
          bytes.writeInt16LE(data[offset + i], i * 2);
      } else bytes = Buffer.from(data.buffer, data.byteOffset + offset, count);
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
  }
  /** Record audio actually played; buffering a received frame is not playback. */
  reportPlayback(position: NativeRealtimePlaybackPosition): void {
    this.checkLive();
    this.playback.report(position);
  }
  /** One observer; overflow terminates media instead of silently dropping it. */
  async *events(): AsyncGenerator<NativeRealtimeEvent> {
    if (this.consuming)
      throw new Error('Native Realtime already has an event consumer');
    this.consuming = true;
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
    if (event.type === 'hosted_mcp_tools_listed')
      bytes += Buffer.byteLength(JSON.stringify(event.tools));
    if (event.type === 'hosted_mcp_call_completed' && event.error !== undefined)
      bytes += Buffer.byteLength(JSON.stringify(event.error));
    for (const value of Object.values(fields))
      if (typeof value === 'string') bytes += Buffer.byteLength(value);
    return bytes;
  }
  private emit(event: NativeRealtimeEvent): void {
    if (this.ended) return;
    const bytes = this.eventBytes(event);
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
  }
  private finish(...errors: [] | [unknown]): void {
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
      this.failure = failure;
      this.queue.length = 0;
      this.queuedBytes = 0;
      this.terminal.resolve();
      this.wake();
    }
    if (!this.sessionClosing) void this.close().catch(() => {});
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
    // Preserve Core's final canonical history tail while ordinary media close joins.
    if (
      this.ended &&
      !(
        msg.type === 'realtime_conversation_realtime' &&
        msg.payload &&
        typeof msg.payload === 'object' &&
        !Array.isArray(msg.payload) &&
        Object.keys(msg.payload).some((key) => key.startsWith('History'))
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
    const [name, value] = entries[0] as [string, any];
    if (name === 'HostedMcpApprovalRequested') {
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
      if (this.seenHostedApprovals.size >= HANDOFF_LIMIT)
        throw new Error('Hosted MCP approval capacity exceeded');
      const request: NativeRealtimeHostedMcpApprovalRequest = Object.freeze({
        type: 'hosted_mcp_approval_requested',
        requestId: value.request_id,
        serverLabel: value.server_label,
        toolName: value.tool_name,
        arguments: value.arguments,
        responseId: value.response_id ?? undefined,
      });
      this.seenHostedApprovals.add(value.approval_id);
      this.hostedApprovals.set(request, value.approval_id);
      this.emit(request);
    } else if (name === 'HostedMcpToolsListed') {
      if (!Array.isArray(value.tools))
        throw new TypeError('Invalid native hosted MCP tool list');
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
      this.emit(
        Object.freeze({
          type: 'hosted_mcp_call_completed',
          itemId: value.item_id,
          serverLabel: value.server_label,
          toolName: value.tool_name,
          arguments: value.arguments,
          responseId: value.response_id ?? undefined,
          output: value.output ?? undefined,
          error:
            value.error === undefined ? undefined : copyJsonValue(value.error),
        }),
      );
    } else if (name === 'FunctionBatchFinished') {
      if (typeof value.response_id !== 'string' || !value.response_id)
        throw new TypeError('Invalid native function-batch receipt');
      if (this.retiredResponses.has(value.response_id)) return;
      if (this.profileUpdates.size >= PENDING_LIMIT)
        throw new Error('Native Realtime profile update capacity exceeded');
      const task = this.#context(async () => {
        try {
          await this._syncProfile(false, {
            responseId: value.response_id,
            target: value.target,
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
      const id = value.handoff_id;
      if (typeof id !== 'string' || !id)
        throw new TypeError('Realtime handoff lacks identity');
      if (this.seen.has(id)) return;
      if (
        this.seen.size >= HANDOFF_LIMIT ||
        this.delegations.size >= PENDING_LIMIT
      )
        throw new Error('Native Realtime delegation capacity exceeded');
      this.seen.add(id);
      const owned: Delegation = {
        workflow: new NativeSessionVoiceWorkflow(
          this.session as PublicSession<string>,
        ),
        retired: false,
        responseId:
          typeof value.response_id === 'string' ? value.response_id : undefined,
      };
      this.delegations.set(id, owned);
      this.emit({ type: 'delegation', handoffId: id, status: 'started' });
      if (this.live) {
        owned.task = this.#context(() => this.delegate(id, nativeInput, owned));
        void owned.task.catch((error) => this.finish(error));
      }
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
      this.seen.add(id);
      this.functionBytes += bytes;
      this.functions.set(id, {
        name: value.name,
        retired:
          typeof value.response_id === 'string' &&
          this.retiredResponses.has(value.response_id),
        responseId:
          typeof value.response_id === 'string' ? value.response_id : undefined,
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
      });
      this.functionBytes -=
        Buffer.byteLength(value.call_id) + Buffer.byteLength(record.name);
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
      };
      this.playback.observe(audio);
      this.emit(audio);
    } else if (
      ['ResponseCreated', 'ResponseDone', 'ResponseCancelled'].includes(name)
    ) {
      const responseId =
        typeof value.response_id === 'string' ? value.response_id : undefined;
      if (name === 'ResponseDone') this.startFunctionBatch(value);
      if (name === 'ResponseCreated') this.responseId = responseId;
      else if (!responseId || responseId === this.responseId)
        this.responseId = undefined;
      this.emit({
        type: 'response',
        status:
          name === 'ResponseCreated'
            ? 'created'
            : name === 'ResponseDone'
              ? 'done'
              : 'cancelled',
        responseId,
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
        this.guardrails.observe(value, name.endsWith('Done'));
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
    else if (name === 'HistoryItemStarted' || name === 'HistoryItemCompleted') {
      const item: NativeRealtimeHistoryItem = Object.freeze({
        id: value.id,
        realtimeSessionId: value.realtime_session_id,
        kind: value.type,
        role: value.role,
        text: value.text,
        turnId: value.turn_id,
        itemId: value.item_id,
        outcome: value.outcome,
        presentation: value.presentation?.type,
        presentationIndex: value.presentation?.index,
      });
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
      const item = Object.freeze({
        ...old,
        text: (old.text ?? '') + value.delta,
      });
      this.canonical.set(item.id, item);
      this.emit({ type: 'history', item, completed: false });
    }
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
      () =>
        this.session._submitRealtimeTools(this.#generation, responseId, ids),
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
          await this._syncProfile();
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
   * Default barge-in may truncate an older playing item while cancelling newer speech.
   */
  async interrupt(
    responseId?: string,
    options: {
      playback?: NativeRealtimePlaybackPosition;
      feedback?: string;
    } = {},
  ): Promise<void> {
    return this.interruptOwned(responseId, options);
  }
  private async interruptOwned(
    responseId?: string,
    options: {
      playback?: NativeRealtimePlaybackPosition;
      feedback?: string;
    } = {},
    excludeWorker?: NativeRealtimeGuardrailWork,
  ): Promise<void> {
    this.session._checkVoiceOperation('interrupt Realtime in');
    this.checkLive();
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
    const playback = options.playback
      ? this.playback.report(options.playback)
      : undefined;
    if (responseId !== undefined) {
      if (
        !this.retiredResponses.has(responseId) &&
        this.retiredResponses.size >= HANDOFF_LIMIT
      )
        throw new Error('Native Realtime retired response capacity exceeded');
      this.retiredResponses.add(responseId);
    }
    for (const record of this.functions.values())
      if (responseId === undefined || record.responseId === responseId)
        record.retired = true;
    const owned = [...this.delegations.values()].filter(
      (item) => responseId === undefined || item.responseId === responseId,
    );
    owned.forEach((item) => {
      item.retired = true;
    });
    for (let i = this.queue.length - 1; i >= 0; i--)
      if (
        this.queue[i].type === 'audio' &&
        (responseId === undefined ||
          (this.queue[i] as { responseId?: string }).responseId === responseId)
      ) {
        this.queuedBytes -= this.eventBytes(this.queue[i]);
        this.queue.splice(i, 1);
      }
    const batches = [...this.toolBatches].filter(
      (batch) => responseId === undefined || batch.responseId === responseId,
    );
    // Cancel owned native work immediately, even if the media command stalls.
    const guardWork = this.guardrails.retire(
      responseId === undefined ? undefined : new Set([responseId]),
    );
    const joining = Promise.allSettled([
      this.guardrails.join(guardWork, excludeWorker),
      ...owned.map((item) => item.workflow.cancel()),
      ...batches.map((batch) => batch.cancel()),
    ]);
    let failure: unknown;
    try {
      const raw = await this.call('interrupt', {
        response_id: responseId ?? null,
        playback: playbackPayload(playback),
        feedback: options.feedback ?? null,
      });
      const receipt = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (
        !receipt ||
        !Array.isArray(receipt.retired_response_ids) ||
        receipt.retired_response_ids.some(
          (id: unknown) => typeof id !== 'string' || !id,
        ) ||
        (receipt.cancelled_response_id != null &&
          typeof receipt.cancelled_response_id !== 'string')
      )
        throw new Error(
          'Native Realtime interruption lacks an authoritative effect receipt',
        );
      const retired = new Set<string>(receipt.retired_response_ids);
      for (const id of retired) {
        if (
          !this.retiredResponses.has(id) &&
          this.retiredResponses.size >= HANDOFF_LIMIT
        )
          throw new Error('Native Realtime retired response capacity exceeded');
        this.retiredResponses.add(id);
      }
      for (const record of this.functions.values())
        if (record.responseId !== undefined && retired.has(record.responseId))
          record.retired = true;
      const lateOwned = [...this.delegations.values()].filter(
        (item) =>
          item.responseId !== undefined &&
          retired.has(item.responseId) &&
          !owned.includes(item),
      );
      const lateBatches = [...this.toolBatches].filter(
        (batch) => retired.has(batch.responseId) && !batches.includes(batch),
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
      failure = error;
    }
    const cleanup = await joining;
    const failed = cleanup.find((result) => result.status === 'rejected');
    if (failure !== undefined) throw failure;
    if (failed?.status === 'rejected') throw failed.reason;
    await Promise.all([
      ...owned.flatMap((item) => (item.task ? [item.task] : [])),
      ...batches.flatMap((batch) => (batch.task ? [batch.task] : [])),
    ]);
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
      const results = await joining;
      const tasks = await Promise.allSettled([
        ...this.profileUpdates,
        ...owned.flatMap((item) => (item.task ? [item.task] : [])),
        ...batches.flatMap((batch) => (batch.task ? [batch.task] : [])),
      ]);
      const failure = [...results, ...tasks].find(
        (result) => result.status === 'rejected',
      );
      if (mediaFailure) throw mediaFailure.error;
      if (failure?.status === 'rejected') throw failure.reason;
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
  | 'callId'
  | 'answerSdp'
  | 'reportPlayback'
  | 'sendText'
  | 'update'
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
