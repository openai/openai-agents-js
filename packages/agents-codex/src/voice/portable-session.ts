import {
  isBackgroundResult,
  type BackgroundResult,
} from '../runtime/background-result';
import type { JsonValue } from '../runtime/binding';
import type { ToolDecision } from '../runtime/tools';
import { abortable } from './abortable';
import { boundedVoiceJSON } from './bounded-voice-json';
import {
  outputAudioBytesPerMillisecond,
  VoiceConversationHistory,
  type VoiceHistoryItem,
} from './conversation-history';
import {
  PortableVoiceHistory,
  type PortableHistoryUpdate,
} from './portable-history';
export type { PortableHistoryUpdate } from './portable-history';
import { decodeBase64 } from './base64';
import { VoiceEventObservers, detachVoiceObservation } from './event-observers';
import {
  NativeRealtimeGuardrails,
  captureRealtimeGuardrails,
  type NativeRealtimeOutputGuardrail,
} from '../runtime/realtime-guardrails';
import {
  addRealtimeUsage,
  reportedRealtimeUsage,
  type NativeRealtimeUsage,
  type NativeRealtimeUsageAccounting,
} from '../runtime/realtime-usage';

/** Host effects for the target-neutral Rust Realtime control crate. */
export interface PortableVoiceTransport {
  /** WebRTC transports clear their server output buffer when default playback is interrupted. */
  readonly clearOutputAudioOnInterrupt?: boolean;
  send(frame: string): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface PortableVoiceContext {
  readonly agent: PortableVoiceOptions;
  readonly context: unknown;
  readonly history: readonly Readonly<Record<string, unknown>>[];
  readonly signal: AbortSignal;
}

export interface PortableVoiceTool<
  Arguments extends Record<string, unknown> = Record<string, unknown>,
> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isEnabled?:
    boolean | ((context: PortableVoiceContext) => boolean | Promise<boolean>);
  needsApproval?:
    | boolean
    | ((
        arguments_: Arguments,
        context: PortableVoiceToolContext,
      ) => boolean | Promise<boolean>);
  /** Optional caller-schema validation; plain JSON schemas retain structural parsing. */
  parseArguments?: (value: unknown) => Arguments | Promise<Arguments>;
  /** Reject a call before execution, or throw to fail the connection. */
  before?: (
    arguments_: Arguments,
    context: PortableVoiceToolContext,
  ) =>
    | Extract<ToolDecision, { action: 'allow' | 'deny' }>
    | Promise<Extract<ToolDecision, { action: 'allow' | 'deny' }>>;
  /** Replace output; returning the original preserves background intent. */
  after?: (
    output: JsonValue,
    context: PortableVoiceToolContext,
  ) =>
    | JsonValue
    | BackgroundResult<JsonValue>
    | Promise<JsonValue | BackgroundResult<JsonValue>>;
  /** Format argument or execution failures for the model; null disables recovery. */
  errorFunction?:
    | ((
        error: unknown,
        context: PortableVoiceToolContext,
      ) => JsonValue | Promise<JsonValue>)
    | null;
  execute(
    arguments_: Arguments,
    signal: AbortSignal,
    context: PortableVoiceToolContext,
  ):
    | JsonValue
    | BackgroundResult<JsonValue>
    | Promise<JsonValue | BackgroundResult<JsonValue>>;
}

export interface PortableVoiceToolContext extends PortableVoiceContext {
  readonly callId: string;
  readonly agent: PortableVoiceOptions;
  readonly context: unknown;
  readonly history: readonly Readonly<Record<string, unknown>>[];
  readonly usage?: NativeRealtimeUsage;
  readonly usageAccounting?: NativeRealtimeUsageAccounting;
}

export interface PortableVoiceOptions {
  model: string;
  name?: string;
  instructions:
    string | ((context: PortableVoiceContext) => string | Promise<string>);
  /** Provider session settings, excluding identity and the source-owned tool catalog. */
  settings?: Record<string, unknown>;
  context?: unknown;
  outputGuardrails?: readonly NativeRealtimeOutputGuardrail<PortableVoiceOptions>[];
  guardrailTextThreshold?: number | null;
  /** Captured at construction; agent updates do not change audio retention. */
  storeAudio?: boolean;
  /** Captured at construction; defaults to automatic hosted MCP continuation. */
  automaticallyTriggerResponseForMcpToolCalls?: boolean;
  handoffs?: readonly PortableVoiceHandoff[];
  tools?: PortableVoiceTool<any>[];
  /** Provider-hosted MCP declarations; execution remains with the provider. */
  hostedTools?: readonly Record<string, unknown>[];
  onApproval?: (
    request: {
      callId: string;
      kind?: 'function' | 'hosted_mcp';
      serverLabel?: string;
      name: string;
      arguments: Record<string, unknown>;
    },
    signal: AbortSignal,
    context: PortableVoiceContext,
  ) => boolean | Promise<boolean>;
  onEvent?: (event: unknown) => void;
  onProviderEvent?: (event: unknown) => void;
  onError?: (error: Error) => void;
}

export interface PortableVoiceHandoff {
  isEnabled?:
    boolean | ((context: PortableVoiceContext) => boolean | Promise<boolean>);
  parseArguments?: (
    value: unknown,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  agent:
    | PortableVoiceOptions
    | ((
        arguments_: Record<string, unknown>,
        signal: AbortSignal,
        context: PortableVoiceToolContext,
      ) => PortableVoiceOptions | Promise<PortableVoiceOptions>);
  onHandoff?: (
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
    context: PortableVoiceToolContext,
  ) => void | Promise<void>;
}

interface Profile {
  id: number;
  options: PortableVoiceOptions;
  tools: Map<string, PortableVoiceTool<any>>;
  handoffs: Set<string>;
  guardrails: NativeRealtimeGuardrails<PortableVoiceOptions>;
}
export type PortableVoiceEffect =
  | { type: 'preflight'; event: unknown; immediate: boolean }
  | { type: 'send'; id: number; event: unknown }
  | {
      type: 'approve' | 'execute';
      call_id: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: 'approve_mcp';
      request_id: string;
      server_label: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | { type: 'abort_mcp'; request_id: string }
  | { type: 'retire'; response_id: string }
  | {
      type: 'scope';
      response_id: string;
      profile_id: number;
      out_of_band: boolean;
      history?: readonly Readonly<Record<string, unknown>>[];
    }
  | { type: 'history_rejected'; item_id: string; message: string }
  | { type: 'event'; event: unknown }
  | { type: 'abort'; call_id: string }
  | { type: 'ready' | 'configured' | 'configuration_rejected' | 'closed' };

/** A single owned Rust control generation, supplied by Wasm or a native binding. */
export interface PortableVoiceControl {
  apply(command: unknown): PortableVoiceEffect[];
}

/** Portable effect driver. Rust owns admission, approval receipts and continuation. */
export class PortableVoiceSession {
  readonly #abort = new AbortController();
  #profile: Profile;
  #pendingProfile: Profile | undefined;
  readonly #profiles = new Set<Profile>();
  readonly #profileById = new Map<number, Profile>();
  #nextProfile = 0;
  readonly #responses = new Map<string, Profile>();
  readonly #detachedResponses = new Set<string>();
  readonly #detachedProfiles = new Map<string, Profile>();
  readonly #accountedResponses = new Set<string>();
  #usageTotals?: ReturnType<typeof reportedRealtimeUsage>;
  #finishedResponses = 0;
  #usageReports = 0;
  #outputAudioBytesPerMillisecond = 48;
  readonly #responseAudioBytesPerMillisecond = new Map<string, number>();
  readonly #responseHistories = new Map<
    string,
    readonly Readonly<Record<string, unknown>>[]
  >();
  readonly #mcpRequests = new Map<
    string,
    {
      profile: Profile;
      abort: AbortController;
      history: readonly Readonly<Record<string, unknown>>[];
    }
  >();
  readonly #firstHandoffs = new Map<string, string>();
  readonly #abortedCalls = new Set<string>();
  readonly #abortedMcp = new Set<string>();
  readonly #calls = new Map<
    string,
    {
      profile: Profile;
      abort: AbortController;
      history: readonly Readonly<Record<string, unknown>>[];
      handoffIgnored: boolean;
      arguments?: Promise<Record<string, unknown>>;
    }
  >();
  readonly #observers = new VoiceEventObservers<{
    type: string;
    value: unknown;
  }>();
  readonly #history: VoiceConversationHistory;
  readonly #historyUpdates: PortableVoiceHistory;
  readonly #storeAudio: boolean;
  readonly #hostedMcpAutoResponse: boolean;
  readonly #clearOutputAudioOnInterrupt: boolean;
  #updating:
    { resolve: () => void; reject: (error: unknown) => void } | undefined;
  #updates: Promise<void> = Promise.resolve();
  readonly #tasks = new Set<Promise<void>>();
  #send: Promise<void> = Promise.resolve();
  #queuedSends = 0;
  #queuedSendBytes = 0;
  #closed = false;
  #started = false;
  #readyTimer: ReturnType<typeof setTimeout> | undefined;
  #closing: Promise<void> | undefined;
  #readyResolve!: () => void;
  #readyReject!: (error: unknown) => void;
  readonly #ready = new Promise<void>((resolve, reject) => {
    this.#readyResolve = resolve;
    this.#readyReject = reject;
  });

  constructor(
    private readonly control: PortableVoiceControl,
    private readonly transport: PortableVoiceTransport,
    private options: PortableVoiceOptions,
  ) {
    this.#clearOutputAudioOnInterrupt =
      transport.clearOutputAudioOnInterrupt ?? false;
    this.#storeAudio = options.storeAudio ?? false;
    this.#hostedMcpAutoResponse =
      options.automaticallyTriggerResponseForMcpToolCalls ?? true;
    this.#history = new VoiceConversationHistory({
      storeAudio: options.storeAudio,
    });
    this.#historyUpdates = new PortableVoiceHistory(
      () => this.#history.providerSnapshot(),
      (command) =>
        command.type === 'validate_history'
          ? this.#apply(command)
          : this.#dispatch(this.#preflightHistoryCommand(command)),
      (error) => this.fail(error),
      (error) => {
        if (!this.#closed) this.#notify(this.options.onError, error);
      },
    );
    this.#profile = this.#makeProfile(options);
    this.options = this.#profile.options;
    // A transport can fail before start returns its readiness promise.
    void this.#ready.catch(() => {});
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error('Portable voice session is closed.');
    if (this.#started)
      throw new Error('Portable voice session already started.');
    this.#started = true;
    this.#readyTimer = setTimeout(
      () =>
        this.fail(
          new Error('Portable voice configuration acceptance timed out.'),
        ),
      10_000,
    );
    try {
      this.#dispatch({
        type: 'start',
        config: await this.#configuration(this.#profile),
        ...(this.#clearOutputAudioOnInterrupt
          ? { clear_output_audio_on_interrupt: true }
          : {}),
      });
    } catch (error) {
      this.fail(error);
    }
    return this.#ready;
  }

  receive(event: unknown): void {
    if (this.#closed) return;
    try {
      this.#notify(this.options.onProviderEvent, event);
      this.#emit('provider_event', event);
      this.#historyUpdates.receive(event);
      this.#dispatch({ type: 'provider', event });
    } catch (error) {
      this.fail(error);
    }
  }

  sendText(text: string): void {
    this.#dispatchAfterHistory({ type: 'text', text });
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    const failure =
      error instanceof Error ? error : new Error('Voice host failed.');
    this.#readyReject(failure);
    this.#updating?.reject(failure);
    this.#historyUpdates.close(failure);
    void this.close().catch(() => {});
    this.#notify(this.options.onError, failure);
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    clearTimeout(this.#readyTimer);
    this.#readyTimer = undefined;
    const reason = new Error('Portable voice session closed.');
    this.#abort.abort(reason);
    this.#readyReject(reason);
    this.#updating?.reject(reason);
    for (const call of this.#calls.values()) call.abort.abort();
    for (const call of this.#mcpRequests.values()) call.abort.abort();
    const guardrailWork = [...this.#profiles].flatMap((profile) =>
      profile.guardrails.stop(),
    );
    this.#historyUpdates.close(reason);
    this.#responses.clear();
    this.#detachedResponses.clear();
    this.#detachedProfiles.clear();
    this.#accountedResponses.clear();
    this.#responseHistories.clear();
    this.#responseAudioBytesPerMillisecond.clear();
    this.#observers.close();
    try {
      this.control.apply({ type: 'close' });
    } catch {
      // The Rust owner may already have retired after a protocol failure.
    }
    this.#closing = (async () => {
      try {
        await this.transport.close();
      } finally {
        await Promise.allSettled([
          ...this.#tasks,
          ...guardrailWork.map((work) => work.completion),
        ]);
        this.#calls.clear();
        this.#firstHandoffs.clear();
        this.#abortedCalls.clear();
        this.#abortedMcp.clear();
        this.#mcpRequests.clear();
        this.#profiles.clear();
        this.#profileById.clear();
      }
    })();
    return this.#closing;
  }

  /** Detached provider history with optional retained audio. */
  get history(): readonly Readonly<Record<string, unknown>>[] {
    return this.#history.snapshot();
  }

  /** Speech-model usage reported for the session's responses. */
  get usage(): NativeRealtimeUsage | undefined {
    return this.#usageTotals === undefined
      ? undefined
      : (JSON.parse(JSON.stringify(this.#usageTotals)) as NativeRealtimeUsage);
  }

  /** Counts of accepted response completions and provider usage reports. */
  get usageAccounting(): NativeRealtimeUsageAccounting {
    return Object.freeze({
      finishedResponses: this.#finishedResponses,
      usageReports: this.#usageReports,
    });
  }

  /** Replace observed messages in order, retaining unchanged tool/control anchors. */
  updateHistory(update: PortableHistoryUpdate): Promise<void> {
    return this.#historyUpdates.update(update);
  }

  on(
    type:
      | 'event'
      | 'provider_event'
      | 'history_updated'
      | 'guardrail'
      | 'agent_updated',
    listener: (event: unknown) => void,
  ): () => void {
    return this.#observers.on(
      type === 'event' ? 'provider_observation' : type,
      (event) => listener(event.value),
    );
  }

  updateAgent(options: PortableVoiceOptions): Promise<void> {
    if (this.#closed || !this.#started)
      return Promise.reject(
        new Error(
          'Start a live portable voice session before updating its agent.',
        ),
      );
    const profile = this.#makeProfile(options);
    return this.#queueUpdate(async () => {
      const config = await this.#configuration(profile);
      await this.#acceptUpdate(profile, { type: 'update', config });
      this.#emit('agent_updated', options);
    });
  }

  /**
   * Send a provider event through the native session's controls.
   * Retrieval returns the provider item. Other events return null.
   * Use updateAgent to change the model or tool catalog.
   */
  async sendEvent(
    event: Readonly<Record<string, unknown>>,
  ): Promise<VoiceHistoryItem | null> {
    if (!this.#started)
      throw new Error(
        'Start a live portable voice session before sending events.',
      );
    const snapshot = this.#captureInput(event, 0).command as Record<
      string,
      unknown
    >;
    const command = { type: 'send_event', event: snapshot };
    if (snapshot?.type === 'session.update') {
      await this.#queueUpdate(async () => {
        this.#preflight({ ...command, validate: true });
        const {
          type: _type,
          model: _model,
          tools: _tools,
          instructions,
          ...settings
        } = snapshot.session as Record<string, unknown>;
        const options = this.#profile.options;
        const profile = this.#makeProfile(
          {
            ...options,
            instructions:
              typeof instructions === 'string'
                ? instructions
                : options.instructions,
            settings: mergeSessionSettings(options.settings ?? {}, settings),
          },
          this.#profile,
        );
        await this.#acceptUpdate(profile, {
          ...command,
          profile_id: profile.id,
        });
      });
      return null;
    }
    this.#preflight({ ...command, validate: true });
    const eventId =
      typeof snapshot.event_id === 'string' ? snapshot.event_id : undefined;
    switch (snapshot.type) {
      case 'conversation.item.retrieve':
        return this.#historyUpdates.retrieve(
          snapshot.item_id as string,
          eventId,
        );
      case 'conversation.item.delete':
        await this.#historyUpdates.delete(snapshot.item_id as string, eventId);
        break;
      case 'conversation.item.create':
      case 'conversation.item.truncate':
      case 'response.create':
        await this.#dispatchAfterHistory(command);
        break;
      default:
        this.#dispatch(command);
    }
    return null;
  }

  #queueUpdate(update: () => Promise<void>): Promise<void> {
    const queued = this.#updates.then(async () => {
      await this.#ready;
      if (this.#closed) throw new Error('Portable voice session is closed.');
      await update();
    });
    this.#updates = queued.catch(() => {});
    return queued;
  }

  #acceptUpdate(profile: Profile, command: unknown): Promise<void> {
    const accepted = new Promise<void>((resolve, reject) => {
      this.#updating = { resolve, reject };
    });
    this.#readyTimer = setTimeout(
      () =>
        this.fail(
          new Error('Portable voice configuration acceptance timed out.'),
        ),
      10_000,
    );
    this.#pendingProfile = profile;
    try {
      this.#dispatch(command);
    } catch (error) {
      this.fail(error);
    }
    return accepted;
  }

  sendAudio(audio: string): void {
    if (typeof audio !== 'string' || audio.length > 256 * 1024)
      throw new RangeError('Audio input exceeds capacity.');
    this.#dispatch(
      this.#captureInput(
        { type: 'audio', audio },
        'input_audio_buffer.append'.length - 'audio'.length,
      ).command,
    );
  }
  /** Audio-buffer commit, followed by explicit createResponse() when needed. */
  commitAudio(): void {
    this.#sendAudioControl('commit_audio');
  }
  clearAudio(): void {
    this.#sendAudioControl('clear_audio');
  }

  createResponse(response?: Record<string, unknown>): void {
    this.#dispatchAfterHistory({
      type: 'create_response',
      ...(response ? { response } : {}),
    });
  }

  cancel(responseId?: string): void {
    this.#preflight({
      type: 'validate_cancel',
      ...(responseId ? { response_id: responseId } : {}),
    });
    this.#dispatch({
      type: 'cancel',
      ...(responseId ? { response_id: responseId } : {}),
    });
  }
  sendMessage(item: Readonly<Record<string, unknown>>): void {
    this.#dispatchAfterHistory({ type: 'input', item });
  }
  deleteItem(itemId: string): void {
    if (this.#closed) throw new Error('Portable voice session is closed.');
    this.#preflight({ type: 'validate_delete', item_id: itemId });
    void this.#historyUpdates.delete(itemId).catch(() => {});
  }
  truncateItem(itemId: string, contentIndex: number, audioEndMs: number): void {
    this.#dispatchAfterHistory({
      type: 'truncate',
      item_id: itemId,
      content_index: contentIndex,
      audio_end_ms: audioEndMs,
    });
  }

  #captureInput(
    command: unknown,
    overhead: number,
  ): { command: unknown; bytes: number } {
    if (this.#closed) throw new Error('Portable voice session is closed.');
    if (this.#queuedSends >= 256)
      throw new RangeError('Portable voice input exceeds capacity.');
    const json = boundedVoiceJSON(
      command,
      Math.floor((8 * 1024 * 1024 - this.#queuedSendBytes) / 2) - overhead,
    );
    const snapshot = JSON.parse(json);
    const event =
      snapshot.type === 'input'
        ? {
            type: 'conversation.item.create',
            item: snapshot.item,
            ...('previous_item_id' in snapshot
              ? { previous_item_id: snapshot.previous_item_id }
              : {}),
          }
        : snapshot.type === 'text'
          ? {
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: snapshot.text }],
              },
            }
          : snapshot.type === 'audio'
            ? { type: 'input_audio_buffer.append', audio: snapshot.audio }
            : snapshot;
    const wire = boundedVoiceJSON(
      event,
      Math.floor((8 * 1024 * 1024 - this.#queuedSendBytes) / 2),
    );
    if (this.#closed) throw new Error('Portable voice session is closed.');
    if (
      this.#queuedSends >= 256 ||
      this.#queuedSendBytes + 2 * wire.length > 8 * 1024 * 1024
    )
      throw new RangeError('Portable voice input exceeds capacity.');
    return { command: snapshot, bytes: 2 * wire.length };
  }

  #sendAudioControl(type: 'commit_audio' | 'clear_audio'): void {
    const wireType =
      type === 'commit_audio'
        ? 'input_audio_buffer.commit'
        : 'input_audio_buffer.clear';
    this.#captureInput({ type: wireType }, 0);
    this.#dispatch({ type });
  }

  #preflight(
    command: unknown,
    sends = 256 - this.#queuedSends,
    bytes = 8 * 1024 * 1024 - this.#queuedSendBytes,
  ): void {
    if (this.#closed) throw new Error('Portable voice session is closed.');
    const immediate = { sends, bytes };
    const deferred = { sends: 256, bytes: 8 * 1024 * 1024 };
    for (const effect of this.control.apply(command)) {
      if (effect.type !== 'preflight')
        throw new Error('Invalid native voice egress preflight.');
      const capacity = effect.immediate ? immediate : deferred;
      if (capacity.sends < 1)
        throw new RangeError('Portable voice input exceeds capacity.');
      const frame = boundedVoiceJSON(
        effect.event,
        Math.floor(capacity.bytes / 2),
      );
      capacity.sends--;
      capacity.bytes -= frame.length * 2;
    }
  }

  #preflightResponse(
    response?: unknown,
    sends = 256 - this.#queuedSends,
    bytes = 8 * 1024 * 1024 - this.#queuedSendBytes,
  ): void {
    this.#preflight(
      { type: 'validate_response', ...(response ? { response } : {}) },
      sends,
      bytes,
    );
  }

  #notify<Value>(
    observer: ((event: Value) => unknown) | undefined,
    event: Value,
  ): void {
    if (!observer) return;
    try {
      void Promise.resolve(observer(detachVoiceObservation(event))).catch(
        () => {},
      );
    } catch {
      /* Passive observers do not own control. */
    }
  }

  #emit(type: string, event: unknown): void {
    this.#observers.emit({
      type: type === 'event' ? 'provider_observation' : type,
      value: event,
    });
  }

  #makeProfile(options: PortableVoiceOptions, captured?: Profile): Profile {
    options = { ...options };
    if (this.#profiles.size >= 256)
      throw new Error('Portable voice profile capacity exceeded.');
    const tools = new Map<string, PortableVoiceTool<any>>(captured?.tools);
    for (const tool of captured ? [] : (options.tools ?? [])) {
      if (tools.has(tool.name))
        throw new Error('Duplicate portable voice tool.');
      tools.set(tool.name, {
        ...tool,
        parameters: JSON.parse(JSON.stringify(tool.parameters)),
      });
    }
    for (const handoff of (captured ? [] : (options.handoffs ?? [])).map(
      (value) => ({
        ...value,
      }),
    )) {
      if (tools.has(handoff.name))
        throw new Error('Duplicate portable voice tool.');
      tools.set(handoff.name, {
        name: handoff.name,
        isEnabled: handoff.isEnabled,
        parseArguments: handoff.parseArguments,
        description: handoff.description,
        parameters: handoff.parameters ?? {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        execute: async (arguments_, signal, context) => {
          await handoff.onHandoff?.(arguments_, signal, {
            ...context,
            history: detachVoiceObservation(context.history),
          });
          if (signal.aborted) throw new Error('Voice handoff was cancelled.');
          const target =
            typeof handoff.agent === 'function'
              ? await handoff.agent(arguments_, signal, context)
              : handoff.agent;
          if (signal.aborted) throw new Error('Voice handoff was cancelled.');
          await this.updateAgent(target);
          return JSON.stringify({ assistant: target.name ?? handoff.name });
        },
      });
    }
    const outputGuardrails = captureRealtimeGuardrails(
      captured?.options.outputGuardrails ?? options.outputGuardrails ?? [],
    );
    const guardrails = new NativeRealtimeGuardrails<PortableVoiceOptions>({
      guardrails: outputGuardrails,
      threshold: options.guardrailTextThreshold,
      source: () => ({ agent: options, context: options.context }),
      invoke: async (callback) => callback(),
      trip: async (input, feedback, worker) => {
        const work = guardrails.retire(new Set([input.responseId]));
        this.#dispatch({
          type: 'guardrail',
          response_id: input.responseId,
          output: feedback ?? 'Output was blocked by a guardrail.',
        });
        await guardrails.join(work, worker);
      },
      emit: (event) => this.#emit('guardrail', event),
      fail: (error) => this.fail(error),
    });
    const profile = {
      id: this.#nextProfile++,
      options: { ...options, outputGuardrails },
      tools,
      handoffs: new Set(
        captured?.handoffs ??
          (options.handoffs ?? []).map((handoff) => handoff.name),
      ),
      guardrails,
    };
    this.#profileById.set(profile.id, profile);
    this.#profiles.add(profile);
    return profile;
  }

  #configuration(profile: Profile) {
    const configuration = (async () => {
      if (this.#closed) throw new Error('Portable voice session is closed.');
      const instructions =
        typeof profile.options.instructions === 'function'
          ? await abortable(
              Promise.resolve(
                profile.options.instructions(this.#context(profile)),
              ),
              this.#abort.signal,
            )
          : profile.options.instructions;
      const tools = [];
      for (const tool of profile.tools.values()) {
        if (this.#closed) throw new Error('Portable voice session is closed.');
        const enabled =
          typeof tool.isEnabled === 'function'
            ? await abortable(
                Promise.resolve(tool.isEnabled(this.#context(profile))),
                this.#abort.signal,
              )
            : (tool.isEnabled ?? true);
        if (enabled) tools.push(tool);
      }
      this.#abort.signal.throwIfAborted();
      return {
        profile_id: profile.id,
        ...(!this.#hostedMcpAutoResponse
          ? { hosted_mcp_auto_response: false }
          : {}),
        model: profile.options.model,
        instructions,
        settings: profile.options.settings ?? {},
        ...(profile.options.hostedTools?.length
          ? { hosted_tools: profile.options.hostedTools }
          : {}),
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          needs_approval:
            typeof tool.needsApproval === 'function' ||
            (tool.needsApproval ?? false),
        })),
      };
    })();
    this.#track(
      configuration.then(() => {}),
      this.#abort.signal,
    );
    return configuration;
  }

  #context(
    profile: Profile,
    history?: PortableVoiceContext['history'],
    signal = this.#abort.signal,
  ): PortableVoiceContext {
    return {
      agent: profile.options,
      context: profile.options.context,
      history:
        history === undefined ? this.history : detachVoiceObservation(history),
      signal,
    };
  }

  #toolContext(callId: string): PortableVoiceToolContext {
    const call = this.#call(callId);
    return {
      ...this.#context(call.profile, call.history, call.abort.signal),
      callId,
      usage: this.usage,
      usageAccounting: this.usageAccounting,
    };
  }

  #arguments(effect: {
    call_id: string;
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const call = this.#call(effect.call_id);
    const tool = call.profile.tools.get(effect.name);
    if (!tool) throw new Error('Native control selected an unknown tool.');
    return (call.arguments ??= Promise.resolve().then(() => {
      if (call.abort.signal.aborted)
        throw new Error('Voice tool was cancelled.');
      return tool.parseArguments
        ? tool.parseArguments(effect.arguments)
        : effect.arguments;
    }));
  }

  #call(callId: string) {
    const call = this.#calls.get(callId);
    if (!call)
      throw new Error(
        'Native control selected a call without a source profile.',
      );
    return call;
  }

  #capture(value: unknown, refresh = false): void {
    const event = value as Record<string, any>;
    const responseId = event?.response_id ?? event?.response?.id;
    const profile =
      this.#responses.get(responseId) ?? this.#detachedProfiles.get(responseId);
    if (!profile) return;
    const sourceHistory =
      this.#responseHistories.get(responseId) ?? this.history;
    const items =
      event?.type === 'response.done'
        ? event.response?.output
        : event?.item
          ? [event.item]
          : [];
    if (refresh)
      for (const item of items ?? []) {
        const call = this.#calls.get(item.call_id);
        if (call && !call.arguments)
          call.history = [
            ...sourceHistory,
            ...(sourceHistory.some((retained) => retained.id === item.id)
              ? []
              : [JSON.parse(JSON.stringify(item))]),
          ];
      }
    for (const item of items ?? []) {
      if (
        profile &&
        item.type === 'mcp_approval_request' &&
        typeof item.id === 'string' &&
        !this.#mcpRequests.has(item.id)
      ) {
        if (this.#mcpRequests.size >= 256)
          throw new Error('Portable voice MCP approval capacity exceeded.');
        this.#mcpRequests.set(item.id, {
          profile,
          abort: new AbortController(),
          history: sourceHistory,
        });
        if (this.#abortedMcp.has(item.id))
          this.#mcpRequests.get(item.id)!.abort.abort();
      }
    }
    for (const item of items ?? [])
      if (
        profile &&
        item.type === 'function_call' &&
        !this.#calls.has(item.call_id)
      ) {
        if (this.#calls.size >= 256)
          throw new Error('Portable voice call capacity exceeded.');
        if (
          profile.handoffs.has(item.name) &&
          !this.#firstHandoffs.has(responseId)
        )
          this.#firstHandoffs.set(responseId, item.call_id);
        this.#calls.set(item.call_id, {
          profile,
          handoffIgnored:
            profile.handoffs.has(item.name) &&
            this.#firstHandoffs.get(responseId) !== item.call_id,
          abort: new AbortController(),
          history: [
            ...sourceHistory,
            ...(sourceHistory.some((retained) => retained.id === item.id)
              ? []
              : [JSON.parse(JSON.stringify(item))]),
          ],
        });
        if (this.#abortedCalls.has(item.call_id))
          this.#calls.get(item.call_id)!.abort.abort();
      }
  }

  #observe(value: unknown): void {
    const event = value as Record<string, any>;
    const responseId = event.response_id ?? event.response?.id;
    if (event.type === 'session.updated')
      this.#outputAudioBytesPerMillisecond = outputAudioBytesPerMillisecond(
        event.session,
        this.#outputAudioBytesPerMillisecond,
      );
    if (
      typeof responseId === 'string' &&
      !this.#responses.has(responseId) &&
      !this.#detachedProfiles.has(responseId)
    )
      return;
    if (
      event.type === 'response.created' &&
      !this.#responseAudioBytesPerMillisecond.has(responseId)
    )
      this.#responseAudioBytesPerMillisecond.set(
        responseId,
        outputAudioBytesPerMillisecond(
          event.response,
          this.#outputAudioBytesPerMillisecond,
        ),
      );
    if (
      event.type === 'response.done' &&
      typeof responseId === 'string' &&
      !this.#accountedResponses.has(responseId)
    ) {
      if (event.response?.usage != null) {
        this.#usageTotals = addRealtimeUsage(
          this.#usageTotals ?? {},
          reportedRealtimeUsage(event.response.usage),
        );
        this.#usageReports++;
      }
      this.#finishedResponses++;
      this.#accountedResponses.add(responseId);
    }
    const detached = this.#detachedResponses.has(
      event.response_id ?? event.response?.id,
    );
    const bytesPerMillisecond = outputAudioBytesPerMillisecond(
      event.response,
      this.#responseAudioBytesPerMillisecond.get(responseId) ??
        this.#outputAudioBytesPerMillisecond,
    );
    if (!detached && this.#history.observe(event, bytesPerMillisecond))
      this.#emit('history_updated', this.history);
    if (!detached) this.#historyUpdates.observe(event);
    if (
      !detached &&
      this.#storeAudio &&
      (event.type === 'response.output_audio.delta' ||
        event.type === 'response.audio.delta') &&
      typeof event.delta === 'string'
    ) {
      this.#history.observeAudio(
        event.item_id,
        event.content_index ?? 0,
        decodeBase64(event.delta),
        bytesPerMillisecond,
      );
    }
    const outputKind = event.type?.startsWith(
      'response.output_audio_transcript.',
    )
      ? 'audio_transcript'
      : event.type?.startsWith('response.output_text.')
        ? 'text'
        : undefined;
    const final = event.type?.endsWith('.done');
    if (outputKind && (final || event.type.endsWith('.delta'))) {
      (
        this.#responses.get(event.response_id) ??
        this.#detachedProfiles.get(event.response_id)
      )?.guardrails.observe(
        {
          ...event,
          output_kind: outputKind,
          text: event.text ?? event.transcript,
        },
        final,
        detached,
      );
    }
    if (
      event.type === 'response.cancelled' ||
      (event.type === 'response.done' && event.response?.status !== 'completed')
    ) {
      const id = event.response_id ?? event.response?.id;
      const profile = this.#responses.get(id) ?? this.#detachedProfiles.get(id);
      if (profile)
        this.#track(
          profile.guardrails.join(profile.guardrails.retire(new Set([id]))),
        );
    }
  }

  #dispatchAfterHistory(
    command: Record<string, unknown>,
  ): void | Promise<void> {
    if (this.#closed) throw new Error('Portable voice session is closed.');
    const snapshot = this.#preflightHistoryCommand(command);
    return this.#historyUpdates.dispatchAfterEdits(snapshot, (captured) => {
      const raw =
        captured.type === 'send_event'
          ? (captured.event as Record<string, unknown>)
          : undefined;
      const ready =
        captured.type === 'create_response' || raw?.type === 'response.create'
          ? { ...captured, history: this.#history.providerSnapshot() }
          : captured;
      // History edits can suspend admission while the transport budget changes.
      this.#dispatch(this.#preflightHistoryCommand(ready));
    });
  }

  #preflightHistoryCommand(
    command: Record<string, unknown>,
  ): Record<string, unknown> {
    if (command.type === 'send_event') {
      const captured = JSON.parse(boundedVoiceJSON(command));
      this.#captureInput(captured.event, 0);
      this.#preflight({
        type: 'send_event',
        event: captured.event,
        validate: true,
      });
      return captured;
    }
    if (command.type === 'text' || command.type === 'input') {
      const overhead =
        command.type === 'input'
          ? 'conversation.item.create'.length - 'input'.length
          : JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: '' }],
              },
            }).length - JSON.stringify({ type: 'text', text: '' }).length;
      const input = this.#captureInput(command, overhead);
      if (command.type === 'text' || command.create_response !== false)
        this.#preflightResponse(
          undefined,
          256 - this.#queuedSends - 1,
          8 * 1024 * 1024 - this.#queuedSendBytes - input.bytes,
        );
      return input.command as Record<string, unknown>;
    }
    const snapshot = JSON.parse(boundedVoiceJSON(command));
    if (snapshot.type === 'delete' || snapshot.type === 'truncate')
      this.#preflight({
        ...snapshot,
        type:
          snapshot.type === 'delete' ? 'validate_delete' : 'validate_truncate',
      });
    if (snapshot.type === 'create_response')
      this.#preflightResponse(snapshot.response);
    return snapshot;
  }

  #dispatch(command: unknown): void {
    try {
      this.#apply(command);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  #apply(command: unknown): void {
    if (this.#closed) throw new Error('Portable voice session is closed.');
    const effects = this.control.apply(command);
    for (const effect of effects)
      if (effect.type === 'scope') {
        const profile = this.#profileById.get(effect.profile_id);
        if (!profile)
          throw new Error('Native control selected an unknown source profile.');
        const target = effect.out_of_band
          ? this.#detachedProfiles
          : this.#responses;
        if (target.size >= 1024) {
          const oldest = target.keys().next().value!;
          target.delete(oldest);
          this.#firstHandoffs.delete(oldest);
          this.#responseHistories.delete(oldest);
          this.#accountedResponses.delete(oldest);
          this.#responseAudioBytesPerMillisecond.delete(oldest);
          if (effect.out_of_band) this.#detachedResponses.delete(oldest);
        }
        target.set(effect.response_id, profile);
        if (effect.history)
          this.#responseHistories.set(effect.response_id, effect.history);
        if (effect.out_of_band) this.#detachedResponses.add(effect.response_id);
      }
    for (const effect of effects) {
      if (effect.type === 'abort') {
        this.#abortedCalls.add(effect.call_id);
        this.#calls.get(effect.call_id)?.abort.abort();
      }
      if (effect.type === 'abort_mcp') {
        this.#abortedMcp.add(effect.request_id);
        this.#mcpRequests.get(effect.request_id)?.abort.abort();
      }
      if (effect.type === 'retire') {
        const profile =
          this.#responses.get(effect.response_id) ??
          this.#detachedProfiles.get(effect.response_id);
        if (profile)
          this.#track(
            profile.guardrails.join(
              profile.guardrails.retire(new Set([effect.response_id])),
            ),
          );
      }
    }
    for (const effect of effects)
      if (effect.type === 'event') this.#capture(effect.event);
    for (const effect of effects) {
      if (this.#closed) break;
      switch (effect.type) {
        case 'scope':
          break;
        case 'retire':
          break;
        case 'ready':
          clearTimeout(this.#readyTimer);
          this.#readyTimer = undefined;
          this.#readyResolve();
          break;
        case 'configured':
          if (this.#pendingProfile) {
            this.#profile = this.#pendingProfile;
            this.options = this.#profile.options;
            this.#pendingProfile = undefined;
          }
          clearTimeout(this.#readyTimer);
          this.#readyTimer = undefined;
          this.#updating?.resolve();
          this.#updating = undefined;
          break;
        case 'configuration_rejected': {
          const pending = this.#pendingProfile;
          if (pending) {
            this.#profiles.delete(pending);
            this.#profileById.delete(pending.id);
            this.#pendingProfile = undefined;
          }
          clearTimeout(this.#readyTimer);
          this.#readyTimer = undefined;
          this.#updating?.reject(
            new Error('Provider rejected the Realtime settings update.'),
          );
          this.#updating = undefined;
          break;
        }
        case 'abort_mcp':
          break;
        case 'approve_mcp': {
          const request = this.#mcpRequests.get(effect.request_id);
          if (!request)
            throw new Error(
              'Native control selected an MCP approval without a source profile.',
            );
          this.#track(
            Promise.resolve().then(async () => {
              if (this.#closed || request.abort.signal.aborted) return;
              const approved = await request.profile.options.onApproval?.(
                {
                  callId: effect.request_id,
                  kind: 'hosted_mcp',
                  serverLabel: effect.server_label,
                  name: effect.name,
                  arguments: effect.arguments,
                },
                request.abort.signal,
                this.#context(
                  request.profile,
                  request.history,
                  request.abort.signal,
                ),
              );
              if (!this.#closed && !request.abort.signal.aborted)
                this.#dispatch({
                  type: 'approve_mcp',
                  request_id: effect.request_id,
                  approved: approved === true,
                });
            }),
            request.abort.signal,
          );
          break;
        }
        case 'abort':
          break;
        case 'history_rejected': {
          const error = new Error(effect.message);
          if (!this.#historyUpdates.rejectDeletion(effect.item_id, error))
            this.#notify(this.options.onError, error);
          break;
        }
        case 'event':
          this.#observe(effect.event);
          this.#capture(effect.event, true);
          this.#notify(this.options.onEvent, effect.event);
          this.#emit('event', effect.event);
          break;
        case 'send': {
          const frame = JSON.stringify(effect.event);
          const bytes = frame.length * 2;
          if (
            this.#queuedSends === 256 ||
            this.#queuedSendBytes + bytes > 8 * 1024 * 1024
          )
            throw new Error('Portable voice egress exceeds capacity.');
          this.#queuedSends++;
          this.#queuedSendBytes += bytes;
          let charged = true;
          const release = () => {
            if (!charged) return;
            charged = false;
            this.#queuedSends--;
            this.#queuedSendBytes -= bytes;
          };
          const sending = this.#send
            .then(async () => {
              if (this.#closed) return;
              await this.transport.send(frame);
              release();
              if (!this.#closed)
                this.#dispatch({ type: 'sent', id: effect.id });
            })
            .finally(release);
          this.#send = sending.catch(() => {});
          this.#track(sending);
          this.#historyUpdates.trackSend(effect.event, sending);
          break;
        }
        case 'approve':
          this.#track(
            Promise.resolve().then(async () => {
              if (this.#closed) return;
              const call = this.#call(effect.call_id);
              if (call.abort.signal.aborted) return;
              const context = this.#toolContext(effect.call_id);
              const tool = call.profile.tools.get(effect.name)!;
              let arguments_: Record<string, unknown>;
              try {
                arguments_ = await this.#arguments(effect);
              } catch (error) {
                if (this.#closed || call.abort.signal.aborted) return;
                const output = await this.#toolError(tool, error, context);
                if (this.#closed || call.abort.signal.aborted) return;
                this.#dispatch({
                  type: 'approve',
                  call_id: effect.call_id,
                  approved: false,
                  output: toolOutputText(output),
                });
                return;
              }
              if (this.#closed || call.abort.signal.aborted) return;
              const needsApproval =
                typeof tool.needsApproval === 'function'
                  ? await tool.needsApproval(
                      detachVoiceObservation(arguments_),
                      context,
                    )
                  : tool.needsApproval;
              if (this.#closed || call.abort.signal.aborted) return;
              const approved =
                !needsApproval ||
                (await call.profile.options.onApproval?.(
                  {
                    callId: effect.call_id,
                    name: effect.name,
                    arguments: detachVoiceObservation(arguments_),
                  },
                  call.abort.signal,
                  this.#toolContext(effect.call_id),
                ));
              if (!this.#closed && !call.abort.signal.aborted)
                this.#dispatch({
                  type: 'approve',
                  call_id: effect.call_id,
                  approved: approved === true,
                });
            }),
            this.#call(effect.call_id).abort.signal,
          );
          break;
        case 'execute':
          this.#track(
            Promise.resolve().then(async () => {
              if (this.#closed) return;
              const call = this.#call(effect.call_id);
              if (call.abort.signal.aborted) return;
              const tool = call.profile.tools.get(effect.name);
              if (!tool)
                throw new Error('Native control selected an unknown tool.');
              // Match Core's first-requested handoff gate before parsing or
              // invoking either destination resolution or application callbacks.
              if (call.handoffIgnored) {
                this.#dispatch({
                  type: 'tool_result',
                  call_id: effect.call_id,
                  output: 'Multiple handoffs detected, ignoring this one.',
                });
                return;
              }
              let arguments_: Record<string, unknown>;
              try {
                arguments_ = await this.#arguments(effect);
              } catch (error) {
                if (this.#closed || call.abort.signal.aborted) return;
                const output = await this.#toolError(
                  tool,
                  error,
                  this.#toolContext(effect.call_id),
                );
                if (this.#closed || call.abort.signal.aborted) return;
                this.#dispatch({
                  type: 'tool_result',
                  call_id: effect.call_id,
                  output: toolOutputText(output),
                });
                return;
              }
              if (this.#closed || call.abort.signal.aborted) return;
              const enabled =
                typeof tool.isEnabled === 'function'
                  ? await tool.isEnabled(this.#toolContext(effect.call_id))
                  : (tool.isEnabled ?? true);
              if (this.#closed || call.abort.signal.aborted) return;
              if (!enabled) {
                this.#dispatch({
                  type: 'tool_result',
                  call_id: effect.call_id,
                  output: `Tool ${effect.name} not found`,
                });
                return;
              }
              const context = this.#toolContext(effect.call_id);
              const decision = tool.before
                ? await tool.before(arguments_, context)
                : undefined;
              if (this.#closed || call.abort.signal.aborted) return;
              let output: JsonValue | BackgroundResult<JsonValue>;
              if (decision?.action === 'deny') {
                output = decision.reason;
              } else {
                if (tool.before && typeof tool.isEnabled === 'function') {
                  const enabled = await tool.isEnabled(context);
                  if (this.#closed || call.abort.signal.aborted) return;
                  if (!enabled) {
                    this.#dispatch({
                      type: 'tool_result',
                      call_id: effect.call_id,
                      output: `Tool ${effect.name} not found`,
                    });
                    return;
                  }
                }
                try {
                  output = await tool.execute(
                    arguments_,
                    call.abort.signal,
                    context,
                  );
                } catch (error) {
                  if (this.#closed || call.abort.signal.aborted) return;
                  output = await this.#toolError(tool, error, context);
                }
              }
              if (this.#closed || call.abort.signal.aborted) return;
              let background = isBackgroundResult(output);
              let content = isBackgroundResult<JsonValue>(output)
                ? output.content
                : output;
              if (decision?.action !== 'deny' && tool.after) {
                const accepted = await tool.after(content, context);
                if (this.#closed || call.abort.signal.aborted) return;
                background =
                  isBackgroundResult(accepted) ||
                  (background && accepted === content);
                content = isBackgroundResult<JsonValue>(accepted)
                  ? accepted.content
                  : accepted;
              }
              const text = toolOutputText(content);
              if (!this.#closed && !call.abort.signal.aborted)
                this.#dispatch({
                  type: 'tool_result',
                  call_id: effect.call_id,
                  output: text,
                  ...(background ? { background: true } : {}),
                });
            }),
            this.#call(effect.call_id).abort.signal,
          );
          break;
        case 'closed':
          break;
      }
    }
  }

  async #toolError(
    tool: PortableVoiceTool<any>,
    error: unknown,
    context: PortableVoiceToolContext,
  ): Promise<JsonValue> {
    if (tool.errorFunction === null) throw error;
    return tool.errorFunction
      ? await tool.errorFunction(error, context)
      : 'An error occurred while running the tool. Please try again.';
  }

  #track(task: Promise<void>, signal?: AbortSignal): void {
    this.#tasks.add(task);
    void task
      .catch((error) => {
        if (!signal?.aborted) this.fail(error);
      })
      .finally(() => this.#tasks.delete(task));
  }
}

function mergeSessionSettings(
  current: Record<string, unknown>,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  return Object.fromEntries([
    ...Object.entries(current),
    ...Object.entries(changes).map(([key, value]) => {
      const previous = Object.hasOwn(current, key) ? current[key] : undefined;
      return [
        key,
        record(previous) && record(value)
          ? mergeSessionSettings(previous, value)
          : value,
      ];
    }),
  ]);
}

function toolOutputText(content: JsonValue): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  if (typeof text !== 'string')
    throw new TypeError('Portable voice tools must return JSON or text.');
  return text;
}
