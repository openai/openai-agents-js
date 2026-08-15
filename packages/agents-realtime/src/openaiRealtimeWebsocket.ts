import {
  isBrowserEnvironment,
  useWebSocketProtocols,
  WebSocket,
} from '@openai/agents-realtime/_shims';
import {
  RealtimeTransportLayerConnectOptions,
  RealtimeTransportLayer,
} from './transportLayer';

import { RealtimeClientMessage, RealtimeSessionConfig } from './clientMessages';
import {
  OpenAIRealtimeBase,
  OpenAIRealtimeBaseOptions,
} from './openaiRealtimeBase';
import { ResponseCreateSequencer } from './responseCreateSequencer';
import { base64ToArrayBuffer, HEADERS, WEBSOCKET_META } from './utils';
import { UserError } from '@openai/agents-core';
import { TransportLayerAudio } from './transportLayerEvents';
import { parseRealtimeEvent } from './openaiRealtimeEvents';

/**
 * The connection state of the WebSocket connection.
 */
export type WebSocketState =
  | {
      status: 'disconnected';
      websocket: undefined;
    }
  | {
      status: 'connecting';
      websocket: WebSocket;
    }
  | {
      status: 'connected';
      websocket: WebSocket;
    };

export interface CreateWebSocketOptions {
  url: string;
  apiKey: string;
}

type WebSocketConnectionAttempt = {
  previousModel: OpenAIRealtimeBase['currentModel'];
  previousApiKey: string | undefined;
  previousUrl: string | undefined;
  previousDefaultUrl: string | undefined;
  cancellationError: Error;
  failureSelected: boolean;
  selectedFailure?: unknown;
  rejectCancellation: (reason?: unknown) => void;
  rejectSetup?: (reason?: unknown) => void;
};

/**
 * The options for the OpenAI Realtime WebSocket transport layer.
 */
export type OpenAIRealtimeWebSocketOptions = {
  /**
   * **Important**: Do not use this option unless you know what you are doing.
   *
   * Whether to use an insecure API key. This has to be set if you are trying to use a regular
   * OpenAI API key instead of a client ephemeral key.
   * @see https://platform.openai.com/docs/guides/realtime#creating-an-ephemeral-token
   */
  useInsecureApiKey?: boolean;
  /**
   * The URL to use for the WebSocket connection.
   */
  url?: string;
  /**
   * Builds a new WebSocket connection.
   * @param options - The options for the WebSocket connection.
   * @returns The WebSocket connection.
   */
  createWebSocket?: (options: CreateWebSocketOptions) => Promise<WebSocket>;
  /**
   * When you pass your own createWebSocket function, which completes the connection state transition,
   * you can set this to true to skip registering the `open` event listener for the same purpose.
   * If this flag is set to true, the constructor will immediately call the internal operation
   * to mark the internal connection state to `connected`. Otherwise, the constructor will register
   * the `open` event listener and wait for it to be triggered.
   *
   * By default (meaning if this property is absent), this is set to false.
   */
  skipOpenEventListeners?: boolean;
} & OpenAIRealtimeBaseOptions;

/**
 * Transport layer that's handling the connection between the client and OpenAI's Realtime API
 * via WebSockets. While this transport layer is designed to be used within a RealtimeSession, it
 * can also be used standalone if you want to have a direct connection to the Realtime API.
 */
export class OpenAIRealtimeWebSocket
  extends OpenAIRealtimeBase
  implements RealtimeTransportLayer
{
  #apiKey: string | undefined;
  #url: string | undefined;
  #defaultUrl: string | undefined;
  #state: WebSocketState = {
    status: 'disconnected',
    websocket: undefined,
  };
  #useInsecureApiKey: boolean;
  #currentItemId: string | undefined;
  #currentAudioContentIndex: number | undefined;
  /**
   * Timestamp maintained by the transport layer to aid with the calculation of the elapsed time
   * since the response started to compute the right interruption time.
   *
   * Mostly internal but might be used by extended transport layers for their interruption
   * calculation.
   */
  protected _firstAudioTimestamp: number | undefined;
  protected _audioLengthMs: number = 0;
  #createWebSocket?: (options: CreateWebSocketOptions) => Promise<WebSocket>;
  #skipOpenEventListeners?: boolean;
  #connectionAttempt: WebSocketConnectionAttempt | undefined;
  #responseCreateSequencer = new ResponseCreateSequencer(
    (event) => this.#sendEventNow(event),
    (error) => this._onError(error),
  );
  #resetAudioPlaybackState() {
    this.#currentItemId = undefined;
    this._firstAudioTimestamp = undefined;
    this._audioLengthMs = 0;
    this.#currentAudioContentIndex = undefined;
  }

  #transitionToDisconnected(websocket?: WebSocket) {
    if (websocket && this.#state.websocket !== websocket) {
      return;
    }

    this.#responseCreateSequencer.releaseWaiters();
    this.#resetAudioPlaybackState();

    if (this.#state.status === 'disconnected') {
      return;
    }

    this.#state = {
      status: 'disconnected',
      websocket: undefined,
    };

    let notificationError: unknown;
    try {
      this.emit('connection_change', this.#state.status);
    } catch (error) {
      notificationError = error;
    }
    try {
      this._onClose();
    } catch (error) {
      notificationError ??= error;
    }

    if (notificationError) {
      throw notificationError;
    }
  }

  #reportError(error: unknown) {
    try {
      this._onError(error);
    } catch {
      // Error observers must not interrupt connection state cleanup.
    }
  }

  #restoreConnectionConfig(attempt: WebSocketConnectionAttempt) {
    this.currentModel = attempt.previousModel;
    this.#apiKey = attempt.previousApiKey;
    this.#url = attempt.previousUrl;
    this.#defaultUrl = attempt.previousDefaultUrl;
  }

  #releaseConnectionAttempt(attempt: WebSocketConnectionAttempt) {
    if (this.#connectionAttempt !== attempt) {
      return false;
    }

    this.#restoreConnectionConfig(attempt);
    this.#connectionAttempt = undefined;
    return true;
  }

  #selectConnectionFailure(
    attempt: WebSocketConnectionAttempt,
    failure: unknown,
  ) {
    if (!attempt.failureSelected) {
      attempt.failureSelected = true;
      attempt.selectedFailure = failure;
    }
  }

  #getConnectionFailure(attempt: WebSocketConnectionAttempt) {
    return attempt.failureSelected
      ? attempt.selectedFailure
      : attempt.cancellationError;
  }

  #closeWebSocket(websocket: WebSocket | undefined) {
    let cleanupError: unknown;

    try {
      this.#transitionToDisconnected(websocket);
    } catch (error) {
      cleanupError = error;
    }

    try {
      websocket?.close();
    } catch (error) {
      cleanupError ??= error;
    }

    if (cleanupError) {
      throw cleanupError;
    }
  }

  constructor(options: OpenAIRealtimeWebSocketOptions = {}) {
    super(options);
    this.#url = options.url;
    this.#defaultUrl = options.url;
    this.#useInsecureApiKey = options.useInsecureApiKey ?? false;
    this.#createWebSocket = options.createWebSocket;
    this.#skipOpenEventListeners = options.skipOpenEventListeners ?? false;
  }

  protected getCommonRequestHeaders() {
    return HEADERS;
  }

  /**
   * The current status of the WebSocket connection.
   */
  get status() {
    return this.#state.status;
  }

  /**
   * The current connection state of the WebSocket connection.
   */
  get connectionState(): WebSocketState {
    return this.#state;
  }

  /**
   * Always returns `null` as the WebSocket transport layer does not handle muting. Instead,
   * this should be handled by the client by not triggering the `sendAudio` method.
   */
  get muted(): null {
    return null;
  }

  /**
   * The current item ID of the ongoing response.
   */
  protected get currentItemId() {
    return this.#currentItemId;
  }

  /**
   * Triggers the `audio` event that a client might listen to to receive the audio buffer.
   * Protected for you to be able to override and disable emitting this event in case your extended
   * transport layer handles audio internally.
   *
   * @param audioEvent - The audio event to emit.
   */
  protected _onAudio(audioEvent: TransportLayerAudio) {
    this.emit('audio', audioEvent);
  }

  protected override _afterAudioDoneEvent() {
    this.#resetAudioPlaybackState();
  }

  async #setupWebSocket(
    resolve: (value: void) => void,
    reject: (reason?: any) => void,
    sessionConfig: Partial<RealtimeSessionConfig>,
    attempt: WebSocketConnectionAttempt,
  ) {
    if (this.#state.websocket) {
      throw new UserError('WebSocket is already connected or connecting.');
    }

    if (!this.#apiKey) {
      throw new UserError(
        'API key is not set. Please call `connect()` with an API key first.',
      );
    }

    if (
      isBrowserEnvironment() &&
      !this.#apiKey.startsWith('ek_') &&
      !this.#useInsecureApiKey
    ) {
      throw new UserError(
        'Using the WebSocket connection in a browser environment requires an ephemeral client key. If you have to use a regular API key, set the `useInsecureApiKey` option to true.',
      );
    }

    let ws: WebSocket | null = null;

    if (this.#createWebSocket) {
      ws = await this.#createWebSocket({
        url: this.#url!,
        apiKey: this.#apiKey,
      });
    } else {
      // browsers and workerd should use the protocols argument, node should use the headers argument
      const websocketArguments = useWebSocketProtocols
        ? [
            'realtime',
            // Auth
            'openai-insecure-api-key.' + this.#apiKey,
            // Version header
            WEBSOCKET_META,
          ]
        : {
            headers: {
              Authorization: `Bearer ${this.#apiKey}`,
              ...this.getCommonRequestHeaders(),
            },
          };

      ws = new WebSocket(this.#url!, websocketArguments as any);
    }

    if (this.#connectionAttempt !== attempt) {
      try {
        ws.close();
      } catch (cleanupError) {
        this.#reportError(cleanupError);
      }
      throw attempt.cancellationError;
    }

    this.#state = {
      status: 'connecting',
      websocket: ws,
    };
    this.emit('connection_change', this.#state.status);

    const onSocketOpenReady = () => {
      const isActiveConnection = () =>
        this.#connectionAttempt === attempt && this.#state.websocket === ws;
      if (!isActiveConnection()) {
        return;
      }

      this.#state = {
        status: 'connected',
        websocket: ws,
      };

      try {
        this.emit('connection_change', this.#state.status);
        if (!isActiveConnection()) {
          reject(attempt.cancellationError);
          return;
        }
        this._onOpen();
        if (!isActiveConnection()) {
          reject(attempt.cancellationError);
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      resolve();
    };

    if (this.#skipOpenEventListeners === true) {
      onSocketOpenReady();
    } else {
      ws.addEventListener('open', onSocketOpenReady);
    }

    ws.addEventListener('error', (error) => {
      if (this.#state.websocket !== ws) {
        return;
      }

      reject(error);
      this.#releaseConnectionAttempt(attempt);
      this.#reportError(error);
      try {
        this.#closeWebSocket(ws);
      } catch (cleanupError) {
        this.#reportError(cleanupError);
      }
    });

    ws.addEventListener('message', (message) => {
      if (this.#state.websocket !== ws) {
        return;
      }

      this._onMessage(message);
      if (this.#state.websocket !== ws) {
        return;
      }
      const { data: parsed, isGeneric } = parseRealtimeEvent(message);
      if (!parsed || isGeneric) {
        return;
      }

      if (parsed.type === 'error') {
        this.#responseCreateSequencer.handleResponseCreateError(parsed);
      }

      if (parsed.type === 'response.output_audio.delta') {
        this.#currentAudioContentIndex = parsed.content_index;
        this.#currentItemId = parsed.item_id;
        if (this._firstAudioTimestamp === undefined) {
          // If the response start timestamp is not set, we set it to the current time.
          // This is used to calculate the elapsed time for interruption.
          this._firstAudioTimestamp = Date.now();
          this._audioLengthMs = 0;
        }

        const buff = base64ToArrayBuffer(parsed.delta);
        // calculate the audio length in milliseconds
        // GA format: session.audio.output.format supports structured { type: "audio/pcm", rate } or "audio/pcmu" etc.
        const fmt = this._rawSessionConfig?.audio?.output?.format;
        if (fmt && typeof fmt === 'object') {
          // Structured format
          const t = fmt.type as string;
          if (t === 'audio/pcmu' || t === 'audio/pcma') {
            // 8kHz, 1 byte per sample
            this._audioLengthMs += buff.byteLength / 8;
          } else if (t === 'audio/pcm') {
            const rate = (fmt as any).rate ?? 24000;
            // bytes -> samples (2 bytes per sample) -> ms
            this._audioLengthMs += (buff.byteLength / 2 / rate) * 1000;
          } else {
            // Fallback assumption similar to legacy
            this._audioLengthMs += buff.byteLength / 24 / 2;
          }
        } else if (typeof fmt === 'string') {
          if (fmt.startsWith('g711_')) {
            this._audioLengthMs += buff.byteLength / 8;
          } else {
            // Assume 24kHz PCM16
            this._audioLengthMs += buff.byteLength / 24 / 2;
          }
        } else {
          // Default to 24kHz PCM16 behavior if unspecified
          this._audioLengthMs += buff.byteLength / 24 / 2;
        }

        const audioEvent: TransportLayerAudio = {
          type: 'audio',
          data: buff,
          responseId: parsed.response_id,
        };
        this._onAudio(audioEvent);
      } else if (parsed.type === 'input_audio_buffer.speech_started') {
        const automaticResponseCancellationEnabled =
          (this._rawSessionConfig as any)?.audio?.input?.turn_detection
            ?.interrupt_response ?? false;
        this.interrupt(!automaticResponseCancellationEnabled);
      } else if (parsed.type === 'response.created') {
        this.#responseCreateSequencer.markResponseCreated();
      } else if (parsed.type === 'response.done') {
        this.#responseCreateSequencer.markResponseDone();
      } else if (parsed.type === 'session.created') {
        this._tracingConfig = parsed.session.tracing;
        // Trying to turn on tracing after the session is created
        const tracingConfig =
          typeof sessionConfig.tracing === 'undefined'
            ? 'auto'
            : sessionConfig.tracing;
        this._updateTracingConfig(tracingConfig);
      }
    });

    ws.addEventListener('close', () => {
      if (this.#state.websocket !== ws) {
        return;
      }

      const closedBeforeOpen = this.#state.status === 'connecting';
      if (closedBeforeOpen) {
        reject(new Error('WebSocket closed before the connection was ready.'));
      }
      this.#releaseConnectionAttempt(attempt);
      try {
        this.#transitionToDisconnected(ws);
      } catch (cleanupError) {
        this.#reportError(cleanupError);
      }
    });
  }

  async connect(options: RealtimeTransportLayerConnectOptions) {
    if (this.#connectionAttempt || this.#state.status !== 'disconnected') {
      throw new UserError('WebSocket is already connected or connecting.');
    }

    let rejectCancellation!: (reason?: unknown) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const attempt: WebSocketConnectionAttempt = {
      previousModel: this.currentModel,
      previousApiKey: this.#apiKey,
      previousUrl: this.#url,
      previousDefaultUrl: this.#defaultUrl,
      cancellationError: new Error(
        'WebSocket connection was closed before setup completed.',
      ),
      failureSelected: false,
      rejectCancellation,
    };
    this.#connectionAttempt = attempt;

    const prepareConnection = async () => {
      try {
        const model = options.model ?? this.currentModel;
        this.currentModel = model;
        const apiKey = await this._getApiKey(options);
        if (this.#connectionAttempt !== attempt) {
          throw this.#getConnectionFailure(attempt);
        }
        this.#apiKey = apiKey;

        const callId = options.callId;
        let url: string;
        if (options.url) {
          url = options.url;
          this.#defaultUrl = options.url;
        } else if (callId) {
          url = `wss://api.openai.com/v1/realtime?call_id=${callId}`;
        } else if (this.#defaultUrl) {
          url = this.#defaultUrl;
        } else {
          url = `wss://api.openai.com/v1/realtime?model=${this.currentModel}`;
        }
        this.#url = url;

        const sessionConfig: Partial<RealtimeSessionConfig> = {
          ...(options.initialSessionConfig || {}),
          model: this.currentModel,
        };

        await new Promise<void>((resolve, reject) => {
          const resolveSetup = () => {
            if (attempt.rejectSetup === rejectSetup) {
              attempt.rejectSetup = undefined;
            }
            resolve();
          };
          const rejectSetup = (reason?: unknown) => {
            this.#selectConnectionFailure(attempt, reason);
            if (attempt.rejectSetup === rejectSetup) {
              attempt.rejectSetup = undefined;
            }
            reject(reason);
          };
          attempt.rejectSetup = rejectSetup;
          this.#setupWebSocket(
            resolveSetup,
            rejectSetup,
            sessionConfig,
            attempt,
          ).catch(rejectSetup);
        });

        if (
          this.#connectionAttempt !== attempt ||
          this.#state.status !== 'connected'
        ) {
          throw this.#getConnectionFailure(attempt);
        }
        await this.updateSessionConfig(sessionConfig);
        if (
          this.#connectionAttempt !== attempt ||
          this.#state.status !== 'connected'
        ) {
          throw this.#getConnectionFailure(attempt);
        }
      } catch (error) {
        this.#selectConnectionFailure(attempt, error);
        if (this.#connectionAttempt === attempt) {
          const websocket = this.#state.websocket;
          this.#releaseConnectionAttempt(attempt);
          try {
            this.#closeWebSocket(websocket);
          } catch (cleanupError) {
            this.#reportError(cleanupError);
          }
        }
        throw this.#getConnectionFailure(attempt);
      }
    };

    try {
      await Promise.race([prepareConnection(), cancellation]);
    } finally {
      if (this.#connectionAttempt === attempt) {
        this.#connectionAttempt = undefined;
      }
    }
  }

  /**
   * Send an event to the Realtime API. This will stringify the event and send it directly to the
   * API. This can be used if you want to take control over the connection and send events manually.
   *
   * @param event - The event to send.
   */
  sendEvent(event: RealtimeClientMessage): void {
    this.#assertConnected();

    if (event.type === 'response.create') {
      this.#responseCreateSequencer.requestResponseCreate(event, {
        manual: true,
      });
      return;
    }

    if (event.type === 'response.cancel') {
      this.#responseCreateSequencer.beginCancelResponse();
    }

    const preparedEvent = this._prepareClientEventForSend(event);
    this.#sendEventNow(preparedEvent);
    this._recordClientEventSent(preparedEvent);
  }

  override requestResponse(response?: Record<string, any>): void {
    this.#assertConnected();
    this.#responseCreateSequencer.requestResponseCreate(
      {
        type: 'response.create',
        ...(response ? { response } : {}),
      },
      { manual: response !== undefined },
    );
  }

  /**
   * Close the WebSocket connection.
   *
   * This will also reset any internal connection tracking used for interruption handling.
   */
  close() {
    const attempt = this.#connectionAttempt;
    if (attempt) {
      const failure = this.#getConnectionFailure(attempt);
      this.#releaseConnectionAttempt(attempt);
      attempt.rejectSetup?.(failure);
      attempt.rejectCancellation(failure);
    }

    const websocket = this.#state.websocket;
    this.#closeWebSocket(websocket);
  }

  /**
   * Will throw an error as the WebSocket transport layer does not support muting.
   */
  mute(_muted: boolean): never {
    throw new Error(
      'Mute is not supported for the WebSocket transport. You have to mute the audio input yourself.',
    );
  }

  /**
   * Send an audio buffer to the Realtime API. This is used for your client to send audio to the
   * model to respond.
   *
   * @param audio - The audio buffer to send.
   * @param options - The options for the audio buffer.
   */
  sendAudio(audio: ArrayBuffer, options: { commit?: boolean } = {}) {
    if (this.#state.status === 'connected') {
      super.sendAudio(audio, options);
    }
  }

  /**
   * Send a cancel response event to the Realtime API. This is used to cancel an ongoing
   *  response that the model is currently generating.
   */
  _cancelResponse() {
    if (this.#responseCreateSequencer.beginCancelResponse()) {
      this.#sendEventNow({
        type: 'response.cancel',
      });
    }
  }

  /**
   * Do NOT call this method directly. Call `interrupt()` instead for proper interruption handling.
   *
   * This method is used to send the right events to the API to inform the model that the user has
   * interrupted the response. It might be overridden/extended by an extended transport layer. See
   * the `TwilioRealtimeTransportLayer` for an example.
   *
   * @param elapsedTime - The elapsed time since the response started.
   */
  _interrupt(elapsedTime: number, cancelOngoingResponse: boolean = true) {
    if (elapsedTime < 0) {
      return;
    }

    // immediately emit this event so the client can stop playing audio
    if (cancelOngoingResponse) {
      this._cancelResponse();
    }

    const length = this._audioLengthMs ?? Number.POSITIVE_INFINITY;
    // audio_end_ms must be an integer
    const audio_end_ms = Math.max(0, Math.floor(Math.min(elapsedTime, length)));

    this.emit('audio_interrupted');
    this.sendEvent({
      type: 'conversation.item.truncate',
      item_id: this.#currentItemId,
      content_index: this.#currentAudioContentIndex,
      audio_end_ms,
    });
  }

  /**
   * Interrupt the ongoing response. This method is triggered automatically by the client when
   * voice activity detection (VAD) is enabled (default) as well as when an output guardrail got
   * triggered.
   *
   * You can also call this method directly if you want to interrupt the conversation for example
   * based on an event in the client.
   */
  interrupt(cancelOngoingResponse: boolean = true) {
    if (!this.#currentItemId || typeof this._firstAudioTimestamp !== 'number') {
      return;
    }

    const elapsedTime = Date.now() - this._firstAudioTimestamp;

    if (elapsedTime >= 0) {
      this._interrupt(elapsedTime, cancelOngoingResponse);
    }

    this.#resetAudioPlaybackState();
  }

  #assertConnected(): void {
    if (!this.#state.websocket) {
      throw new Error(
        'WebSocket is not connected. Make sure you call `connect()` before sending events.',
      );
    }
  }

  #sendEventNow(event: RealtimeClientMessage): void {
    this.#assertConnected();
    this.#state.websocket!.send(JSON.stringify(event));
  }
}
