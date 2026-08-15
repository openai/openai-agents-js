import {
  OpenAIRealtimeBase,
  type OpenAIRealtimeBaseOptions,
  type RealtimeClientMessage,
  type RealtimeSessionConfig,
  type RealtimeTransportLayerConnectOptions,
} from '@openai/agents-realtime';
import {
  MediaStream,
  RTCPeerConnection,
  mediaDevices,
} from 'react-native-webrtc';

type DataChannel = ReturnType<RTCPeerConnection['createDataChannel']>;
type ConnectionStatus =
  'connected' | 'disconnected' | 'connecting' | 'disconnecting';

const DEFAULT_CALL_URL = 'https://api.openai.com/v1/realtime/calls';
const SESSION_UPDATE_TIMEOUT_MS = 10_000;
const PEER_CONNECTION_DISCONNECTED_GRACE_MS = 5_000;

type PendingResponseCreate = {
  event: RealtimeClientMessage;
  automatic: boolean;
  coveredAutomaticRequest: boolean;
};

export type ReactNativeWebRTCTransportOptions = OpenAIRealtimeBaseOptions & {
  /**
   * Whether the peer connection should capture and play audio.
   * Disable this for text-only sessions. The example currently does so as a
   * temporary workaround for the iOS 26.5 Simulator audio regression.
   */
  enableAudio?: boolean;
};

/**
 * A minimal app-owned WebRTC transport for react-native-webrtc.
 *
 * It deliberately does not call registerGlobals(). The SDK receives a normal
 * RealtimeTransportLayer while WebRTC objects stay local to this application.
 */
export class ReactNativeWebRTCTransport extends OpenAIRealtimeBase {
  readonly #enableAudio: boolean;
  #status: ConnectionStatus = 'disconnected';
  #peerConnection: RTCPeerConnection | null = null;
  #dataChannel: DataChannel | null = null;
  #localStream: MediaStream | null = null;
  #muted = false;
  #activeResponse = false;
  #cancelRequested = false;
  #pendingResponseCreate: PendingResponseCreate | null = null;
  #queuedResponseCreates: PendingResponseCreate[] = [];
  #responseCreateEventCounter = 0;
  #peerConnectionDisconnectedTimeout: ReturnType<typeof setTimeout> | null =
    null;
  #connectAttempt = 0;
  #connectPromise: Promise<void> | null = null;
  #rejectConnectionAttempt: ((reason?: unknown) => void) | null = null;
  #rejectSessionUpdate: ((reason?: unknown) => void) | null = null;

  constructor(options: ReactNativeWebRTCTransportOptions = {}) {
    super(options);
    this.#enableAudio = options.enableAudio ?? true;
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  get muted(): boolean {
    return this.#muted;
  }

  async connect(options: RealtimeTransportLayerConnectOptions): Promise<void> {
    if (this.#status === 'connected') {
      return;
    }
    if (this.#connectPromise) {
      return this.#connectPromise;
    }

    const attempt = ++this.#connectAttempt;
    this.currentModel = options.model ?? this.currentModel;
    const cancelled = new Promise<never>((_, reject) => {
      this.#rejectConnectionAttempt = reject;
    });
    const connectPromise = Promise.race([
      this.#prepareConnection(options, attempt),
      cancelled,
    ]);
    this.#connectPromise = connectPromise;
    void connectPromise.then(
      () => this.#clearConnectPromise(connectPromise),
      () => this.#clearConnectPromise(connectPromise),
    );
    try {
      this.#setStatus('connecting');
    } catch (error) {
      this.#cleanupFailedConnection(error);
    }
    return connectPromise;
  }

  async #prepareConnection(
    options: RealtimeTransportLayerConnectOptions,
    attempt: number,
  ): Promise<void> {
    try {
      const apiKey = await this._getApiKey(options);
      if (!apiKey) {
        throw new Error(
          'The token server did not return an ephemeral client key.',
        );
      }
      this.#assertActive(attempt);

      const peerConnection = new RTCPeerConnection();
      this.#peerConnection = peerConnection;
      const dataChannel = peerConnection.createDataChannel('oai-events');
      this.#dataChannel = dataChannel;

      const sessionConfig: Partial<RealtimeSessionConfig> = {
        ...(options.initialSessionConfig ?? {}),
        model: this.currentModel,
      };
      const sessionUpdated = this.#waitForDataChannel(
        peerConnection,
        dataChannel,
        sessionConfig,
        attempt,
      );
      void sessionUpdated.catch(() => {});

      addWebRTCEventListener(peerConnection, 'connectionstatechange', () => {
        if (!this.#isActiveConnection(attempt, peerConnection, dataChannel)) {
          return;
        }
        switch (peerConnection.connectionState) {
          case 'connected':
            this.#clearPeerConnectionDisconnectedTimeout();
            break;
          case 'disconnected':
            this.#schedulePeerConnectionDisconnectedClose(
              attempt,
              peerConnection,
              dataChannel,
            );
            break;
          case 'failed':
            this.#clearPeerConnectionDisconnectedTimeout();
            this.#cleanupFailedConnection(
              new Error('The WebRTC peer connection failed.'),
            );
            break;
          case 'closed':
            this.#clearPeerConnectionDisconnectedTimeout();
            this.#closeFromEvent();
            break;
        }
      });

      if (this.#enableAudio) {
        const localStream = await mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
        if (!this.#isActiveConnection(attempt, peerConnection, dataChannel)) {
          stopStream(localStream);
          throw new Error('The WebRTC connection attempt is no longer active.');
        }
        this.#localStream = localStream;
        const audioTrack = localStream.getAudioTracks()[0];
        if (!audioTrack) {
          throw new Error('No microphone audio track was available.');
        }
        peerConnection.addTrack(audioTrack, localStream);
      } else {
        // The Realtime API requires an audio media section in the SDP offer.
        peerConnection.addTransceiver('audio', { direction: 'inactive' });
      }

      const offer = await peerConnection.createOffer();
      this.#assertActiveConnection(attempt, peerConnection, dataChannel);
      await peerConnection.setLocalDescription(offer);
      this.#assertActiveConnection(attempt, peerConnection, dataChannel);
      if (!offer.sdp) {
        throw new Error('Failed to create a WebRTC offer.');
      }

      const response = await fetch(options.url ?? DEFAULT_CALL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp,
      });
      this.#assertActiveConnection(attempt, peerConnection, dataChannel);
      if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new Error(
          `Realtime call request failed with status ${response.status}${detail}`,
        );
      }

      const answer = await response.text();
      this.#assertActiveConnection(attempt, peerConnection, dataChannel);
      await peerConnection.setRemoteDescription({
        type: 'answer',
        sdp: answer,
      });
      this.#assertActiveConnection(attempt, peerConnection, dataChannel);
      await sessionUpdated;
      this.#assertActiveConnection(attempt, peerConnection, dataChannel);

      this.#setStatus('connected');
      this.#assertActiveConnection(attempt, peerConnection, dataChannel);
      this._onOpen();
      this.#assertActiveConnection(attempt, peerConnection, dataChannel);
    } catch (error) {
      if (this.#connectAttempt === attempt) {
        this.#cleanupFailedAttempt(error);
      }
      throw error;
    }
  }

  #waitForDataChannel(
    peerConnection: RTCPeerConnection,
    dataChannel: DataChannel,
    sessionConfig: Partial<RealtimeSessionConfig>,
    attempt: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let configSent = false;
      let settled = false;

      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        if (this.#rejectSessionUpdate === rejectConnection) {
          this.#rejectSessionUpdate = null;
        }
        callback();
      };
      const rejectConnection = (reason?: unknown) => {
        settle(() => reject(reason));
      };
      this.#rejectSessionUpdate = rejectConnection;

      addWebRTCEventListener(dataChannel, 'open', () => {
        if (!this.#isActiveConnection(attempt, peerConnection, dataChannel)) {
          return;
        }
        try {
          this.updateSessionConfig(sessionConfig);
          configSent = true;
          timeout = setTimeout(() => {
            settle(() =>
              reject(new Error('Timed out waiting for session.updated.')),
            );
          }, SESSION_UPDATE_TIMEOUT_MS);
        } catch (error) {
          settle(() => reject(error));
        }
      });

      addWebRTCEventListener(dataChannel, 'message', (event) => {
        if (!this.#isActiveConnection(attempt, peerConnection, dataChannel)) {
          return;
        }
        const data = event.data;
        if (typeof data !== 'string') {
          return;
        }

        this._onMessage({ data } as MessageEvent);
        if (!this.#isActiveConnection(attempt, peerConnection, dataChannel)) {
          return;
        }
        const parsed = parseServerEvent(data);
        if (!parsed) {
          return;
        }
        if (parsed.type === 'error') {
          this.#handleResponseCreateError(parsed);
        } else if (parsed.type === 'response.created') {
          this.#pendingResponseCreate = null;
          this.#activeResponse = true;
        } else if (parsed.type === 'response.done') {
          this.#activeResponse = false;
          this.#cancelRequested = false;
          this.#pendingResponseCreate = null;
          this.#scheduleNextResponseCreate();
        } else if (parsed.type === 'session.created') {
          const tracing = parsed.session?.tracing ?? null;
          this._tracingConfig = tracing;
          this._updateTracingConfig(sessionConfig.tracing ?? 'auto');
        } else if (parsed.type === 'session.updated' && configSent) {
          settle(resolve);
        }
      });

      addWebRTCEventListener(dataChannel, 'error', (event) => {
        if (!this.#isActiveConnection(attempt, peerConnection, dataChannel)) {
          return;
        }
        if (this.#status === 'connecting') {
          settle(() => reject(event));
        }
        this.#cleanupFailedConnection(event);
      });
      addWebRTCEventListener(dataChannel, 'close', () => {
        if (!this.#isActiveConnection(attempt, peerConnection, dataChannel)) {
          return;
        }
        if (this.#status === 'connecting') {
          const error = new Error(
            'The WebRTC data channel closed during setup.',
          );
          settle(() => reject(error));
          this.#cleanupFailedConnection(error);
        } else if (this.#status === 'connected') {
          this.#closeFromEvent();
        }
      });
    });
  }

  sendEvent(event: RealtimeClientMessage): void {
    this.#assertConnected();
    if (event.type === 'response.create') {
      this.#requestResponseCreate(event, false);
      return;
    }
    if (event.type === 'response.cancel' && this.#activeResponse) {
      this.#cancelRequested = true;
    }
    this._sendClientEventWithTracking(event, (preparedEvent) => {
      this.#sendEventNow(preparedEvent);
    });
  }

  override requestResponse(response?: Record<string, any>): void {
    this.#assertConnected();
    this.#requestResponseCreate(
      {
        type: 'response.create',
        ...(response ? { response } : {}),
      },
      response === undefined,
    );
  }

  #assertConnected(): void {
    const dataChannel = this.#dataChannel;
    if (!dataChannel || dataChannel.readyState !== 'open') {
      throw new Error(
        'WebRTC is not connected. Call session.connect() before sending events.',
      );
    }
  }

  #sendEventNow(event: RealtimeClientMessage): void {
    this.#assertConnected();
    const dataChannel = this.#dataChannel!;
    dataChannel.send(JSON.stringify(event));
  }

  #requestResponseCreate(
    event: RealtimeClientMessage,
    automatic: boolean,
  ): void {
    const request = { event, automatic, coveredAutomaticRequest: false };
    if (
      !this.#activeResponse &&
      !this.#cancelRequested &&
      !this.#pendingResponseCreate &&
      this.#queuedResponseCreates.length === 0
    ) {
      this.#dispatchResponseCreate(request);
      return;
    }

    if (automatic) {
      const lastQueued = this.#queuedResponseCreates.at(-1);
      if (lastQueued?.automatic) {
        lastQueued.coveredAutomaticRequest = true;
        return;
      }
    }
    this.#queuedResponseCreates.push(request);
  }

  #dispatchResponseCreate(request: PendingResponseCreate): void {
    this.#responseCreateEventCounter += 1;
    const event = {
      ...request.event,
      event_id:
        typeof request.event.event_id === 'string'
          ? request.event.event_id
          : `react_native_response_create_${this.#responseCreateEventCounter}`,
    };
    this.#pendingResponseCreate = { ...request, event };
    try {
      this.#sendEventNow(event);
    } catch (error) {
      this.#releaseFailedResponseCreate();
      this.#reportError(error);
      this.#scheduleNextResponseCreate();
    }
  }

  #scheduleNextResponseCreate(): void {
    void Promise.resolve().then(() => {
      if (
        this.#activeResponse ||
        this.#cancelRequested ||
        this.#pendingResponseCreate
      ) {
        return;
      }
      const next = this.#queuedResponseCreates.shift();
      if (next) {
        this.#dispatchResponseCreate(next);
      }
    });
  }

  #handleResponseCreateError(event: ServerEvent): void {
    const pendingEventId = this.#pendingResponseCreate?.event.event_id;
    const linkedEventId = event.error?.event_id;
    const message = event.error?.message ?? '';
    const code = event.error?.code ?? '';
    if (
      !this.#pendingResponseCreate ||
      (linkedEventId && linkedEventId !== pendingEventId) ||
      (!linkedEventId &&
        !message.includes('response.create') &&
        !code.includes('response_create'))
    ) {
      return;
    }
    this.#releaseFailedResponseCreate();
    this.#scheduleNextResponseCreate();
  }

  #releaseFailedResponseCreate(): void {
    const retryCoveredAutomaticRequest =
      this.#pendingResponseCreate?.coveredAutomaticRequest ?? false;
    this.#pendingResponseCreate = null;
    if (retryCoveredAutomaticRequest) {
      this.#queuedResponseCreates.unshift({
        event: { type: 'response.create' },
        automatic: true,
        coveredAutomaticRequest: false,
      });
    }
  }

  mute(muted: boolean): void {
    this.#muted = muted;
    for (const track of this.#localStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
  }

  interrupt(): void {
    if (this.#activeResponse && !this.#cancelRequested) {
      this.#cancelRequested = true;
      this.#sendEventNow({ type: 'response.cancel' });
    }
    this.#sendEventNow({ type: 'output_audio_buffer.clear' });
  }

  close(): void {
    this.#clearPeerConnectionDisconnectedTimeout();
    const shouldNotify = this.#status !== 'disconnected';
    this.#connectAttempt += 1;
    this.#rejectConnectionAttempt?.(
      new Error('The WebRTC connection was closed.'),
    );
    this.#rejectSessionUpdate?.(new Error('The WebRTC connection was closed.'));
    this.#rejectConnectionAttempt = null;
    this.#rejectSessionUpdate = null;
    this.#connectPromise = null;
    this.#status = 'disconnected';

    let cleanupError: unknown;
    const runCleanup = (cleanup: () => void) => {
      try {
        cleanup();
      } catch (error) {
        cleanupError ??= error;
      }
    };

    runCleanup(() => this.#closeResources());
    if (shouldNotify) {
      runCleanup(() => this.emit('connection_change', 'disconnected'));
      runCleanup(() => this._onClose());
    }
    if (cleanupError) {
      throw cleanupError;
    }
  }

  #closeResources(): void {
    const dataChannel = this.#dataChannel;
    const peerConnection = this.#peerConnection;
    const localStream = this.#localStream;

    this.#dataChannel = null;
    this.#peerConnection = null;
    this.#localStream = null;
    this.#activeResponse = false;
    this.#cancelRequested = false;
    this.#pendingResponseCreate = null;
    this.#queuedResponseCreates = [];

    let cleanupError: unknown;
    const runCleanup = (cleanup: () => void) => {
      try {
        cleanup();
      } catch (error) {
        cleanupError ??= error;
      }
    };

    if (dataChannel) {
      runCleanup(() => dataChannel.close());
    }
    if (peerConnection) {
      runCleanup(() => peerConnection.close());
    }
    for (const track of localStream?.getTracks() ?? []) {
      runCleanup(() => track.stop());
    }
    if (cleanupError) {
      throw cleanupError;
    }
  }

  #cleanupFailedAttempt(error: unknown): void {
    const shouldNotify = this.#status !== 'disconnected';
    this.#status = 'disconnected';

    let cleanupError: unknown;
    try {
      this.#closeResources();
    } catch (caughtError) {
      cleanupError = caughtError;
    }
    if (shouldNotify) {
      try {
        this.emit('connection_change', 'disconnected');
      } catch (observerError) {
        cleanupError ??= observerError;
      }
      try {
        this._onClose();
      } catch (observerError) {
        cleanupError ??= observerError;
      }
    }
    this.#reportError(error);
    if (cleanupError) {
      this.#reportError(cleanupError);
    }
  }

  #cleanupFailedConnection(error: unknown): void {
    let cleanupError: unknown;
    try {
      this.close();
    } catch (caughtError) {
      cleanupError = caughtError;
    }
    this.#reportError(error);
    if (cleanupError) {
      this.#reportError(cleanupError);
    }
  }

  #closeFromEvent(): void {
    try {
      this.close();
    } catch (error) {
      this.#reportError(error);
    }
  }

  #schedulePeerConnectionDisconnectedClose(
    attempt: number,
    peerConnection: RTCPeerConnection,
    dataChannel: DataChannel,
  ): void {
    this.#clearPeerConnectionDisconnectedTimeout();
    this.#peerConnectionDisconnectedTimeout = setTimeout(() => {
      this.#peerConnectionDisconnectedTimeout = null;
      if (
        this.#isActiveConnection(attempt, peerConnection, dataChannel) &&
        peerConnection.connectionState === 'disconnected'
      ) {
        this.#closeFromEvent();
      }
    }, PEER_CONNECTION_DISCONNECTED_GRACE_MS);
  }

  #clearPeerConnectionDisconnectedTimeout(): void {
    if (this.#peerConnectionDisconnectedTimeout === null) {
      return;
    }
    clearTimeout(this.#peerConnectionDisconnectedTimeout);
    this.#peerConnectionDisconnectedTimeout = null;
  }

  #reportError(error: unknown): void {
    try {
      this._onError(error);
    } catch {
      // Error observers must not interrupt connection state cleanup.
    }
  }

  #setStatus(status: 'connecting' | 'connected' | 'disconnected'): void {
    if (this.#status === status) {
      return;
    }
    this.#status = status;
    this.emit('connection_change', status);
  }

  #assertActive(attempt: number): void {
    if (this.#connectAttempt !== attempt) {
      throw new Error('The WebRTC connection attempt is no longer active.');
    }
  }

  #assertActiveConnection(
    attempt: number,
    peerConnection: RTCPeerConnection,
    dataChannel: DataChannel,
  ): void {
    if (!this.#isActiveConnection(attempt, peerConnection, dataChannel)) {
      throw new Error('The WebRTC connection attempt is no longer active.');
    }
  }

  #isActiveConnection(
    attempt: number,
    peerConnection: RTCPeerConnection,
    dataChannel: DataChannel,
  ): boolean {
    return (
      this.#connectAttempt === attempt &&
      this.#peerConnection === peerConnection &&
      this.#dataChannel === dataChannel
    );
  }

  #clearConnectPromise(connectPromise: Promise<void>): void {
    if (this.#connectPromise === connectPromise) {
      this.#connectPromise = null;
      this.#rejectConnectionAttempt = null;
      this.#rejectSessionUpdate = null;
    }
  }
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

type ServerEvent = {
  type?: string;
  error?: {
    code?: string;
    message?: string;
    event_id?: string;
  };
  session?: {
    tracing?: RealtimeSessionConfig['tracing'];
  };
};

type WebRTCEvent = {
  data?: unknown;
  streams?: MediaStream[];
};

function addWebRTCEventListener(
  target: unknown,
  type: string,
  listener: (event: WebRTCEvent) => void,
): void {
  // react-native-webrtc implements EventTarget, but 124.0.7 does not expose
  // inherited addEventListener methods on its concrete TypeScript classes.
  (
    target as {
      addEventListener: (
        eventType: string,
        callback: (event: WebRTCEvent) => void,
      ) => void;
    }
  ).addEventListener(type, listener);
}

function parseServerEvent(data: string): ServerEvent | null {
  try {
    return JSON.parse(data) as ServerEvent;
  } catch {
    return null;
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) {
      return response.statusText ? `: ${response.statusText}` : '';
    }
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      return parsed.error?.message ? `: ${parsed.error.message}` : `: ${text}`;
    } catch {
      return `: ${text}`;
    }
  } catch {
    return response.statusText ? `: ${response.statusText}` : '';
  }
}
