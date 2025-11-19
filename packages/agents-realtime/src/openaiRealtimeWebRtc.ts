/// <reference lib="dom" />

import { isBrowserEnvironment } from '@openai/agents-core/_shims';
import {
  RealtimeTransportLayer,
  RealtimeTransportLayerConnectOptions,
} from './transportLayer';

import { UserError } from '@openai/agents-core';
import logger from './logger';
import { RealtimeClientMessage, RealtimeSessionConfig } from './clientMessages';
import {
  OpenAIRealtimeBase,
  OpenAIRealtimeBaseOptions,
} from './openaiRealtimeBase';
import { parseRealtimeEvent } from './openaiRealtimeEvents';
import { HEADERS } from './utils';

/**
 * The connection state of the WebRTC connection.
 */
export type WebRTCState =
  | {
      status: 'disconnected';
      peerConnection: undefined;
      dataChannel: undefined;
      callId: string | undefined;
    }
  | {
      status: 'connecting';
      peerConnection: RTCPeerConnection;
      dataChannel: RTCDataChannel;
      callId: string | undefined;
    }
  | {
      status: 'connected';
      peerConnection: RTCPeerConnection;
      dataChannel: RTCDataChannel;
      callId: string | undefined;
    };

/**
 * The options for the OpenAI Realtime WebRTC transport layer.
 */
export type OpenAIRealtimeWebRTCOptions = {
  /**
   * Override of the base URL for the Realtime API
   */
  baseUrl?: string;
  /**
   * The audio element to use for audio playback. If not provided, a new audio element will be
   * created.
   */
  audioElement?: HTMLAudioElement;
  /**
   * The media stream to use for audio input. If not provided, the default microphone will be used.
   */
  mediaStream?: MediaStream;
  /**
   * **Important**: Do not use this option unless you know what you are doing.
   *
   * Whether to use an insecure API key. This has to be set if you are trying to use a regular
   * OpenAI API key instead of a client ephemeral key.
   * @see https://platform.openai.com/docs/guides/realtime#creating-an-ephemeral-token
   */
  useInsecureApiKey?: boolean;
  /**
   * Optional hook invoked with the freshly created peer connection. Returning a
   * different connection will override the one created by the transport layer.
   * This is called right before the offer is created and can be asynchronous.
   */
  changePeerConnection?: (
    peerConnection: RTCPeerConnection,
  ) => RTCPeerConnection | Promise<RTCPeerConnection>;
} & OpenAIRealtimeBaseOptions;

/**
 * Transport layer that's handling the connection between the client and OpenAI's Realtime API
 * via WebRTC. While this transport layer is designed to be used within a RealtimeSession, it can
 * also be used standalone if you want to have a direct connection to the Realtime API.
 *
 * Unless you specify a `mediaStream` or `audioElement` option, the transport layer will
 * automatically configure the microphone and audio output to be used by the session.
 */
export class OpenAIRealtimeWebRTC
  extends OpenAIRealtimeBase
  implements RealtimeTransportLayer
{
  #url: string;
  #state: WebRTCState = {
    status: 'disconnected',
    peerConnection: undefined,
    dataChannel: undefined,
    callId: undefined,
  };
  #useInsecureApiKey: boolean;
  #ongoingResponse: boolean = false;
  #muted = false;

  constructor(private readonly options: OpenAIRealtimeWebRTCOptions = {}) {
    if (typeof RTCPeerConnection === 'undefined') {
      throw new Error('WebRTC is not supported in this environment');
    }
    super(options);
    this.#url = options.baseUrl ?? `https://api.openai.com/v1/realtime/calls`;
    this.#useInsecureApiKey = options.useInsecureApiKey ?? false;
  }

  /**
   * The current call ID of the WebRTC connection.
   */
  get callId() {
    return this.#state.callId;
  }

  /**
   * The current status of the WebRTC connection.
   */
  get status() {
    return this.#state.status;
  }

  /**
   * The current connection state of the WebRTC connection including the peer connection and data
   * channel.
   */
  get connectionState(): WebRTCState {
    return this.#state;
  }

  /**
   * Whether the session is muted.
   */
  get muted(): boolean {
    return this.#muted;
  }

  /**
   * Connect to the Realtime API. This will establish the connection to the OpenAI Realtime API
   * via WebRTC.
   *
   * If you are using a browser, the transport layer will also automatically configure the
   * microphone and audio output to be used by the session.
   *
   * @param options - The options for the connection.
   */
  async connect(options: RealtimeTransportLayerConnectOptions) {
    if (this.#state.status === 'connected') {
      return;
    }

    if (this.#state.status === 'connecting') {
      logger.warn(
        'Realtime connection already in progress. Please await original promise',
      );
    }

    const model = options.model ?? this.currentModel;
    this.currentModel = model;
    const baseUrl = options.url ?? this.#url;
    const apiKey = await this._getApiKey(options);

    const isClientKey = typeof apiKey === 'string' && apiKey.startsWith('ek_');
    if (isBrowserEnvironment() && !this.#useInsecureApiKey && !isClientKey) {
      throw new UserError(
        'Using the WebRTC connection in a browser environment requires an ephemeral client key. If you need to use a regular API key, use the WebSocket transport or set the `useInsecureApiKey` option to true.',
      );
    }

    // eslint-disable-next-line no-async-promise-executor
    return new Promise<void>(async (resolve, reject) => {
      try {
        const userSessionConfig: Partial<RealtimeSessionConfig> = {
          ...(options.initialSessionConfig || {}),
          model: this.currentModel,
        };

        const connectionUrl = new URL(baseUrl);

        let peerConnection: RTCPeerConnection = new RTCPeerConnection();
        const dataChannel = peerConnection.createDataChannel('oai-events');
        let callId: string | undefined = undefined;

        const attachConnectionStateHandler = (
          connection: RTCPeerConnection,
        ) => {
          connection.onconnectionstatechange = () => {
            switch (connection.connectionState) {
              case 'disconnected':
              case 'failed':
              case 'closed':
                this.close();
                break;
              // 'connected' state is handled by dataChannel.onopen. So we don't need to handle it here.
              // 'new' and 'connecting' are intermediate states and do not require action here.
            }
          };
        };
        attachConnectionStateHandler(peerConnection);

        this.#state = {
          status: 'connecting',
          peerConnection,
          dataChannel,
          callId,
        };
        this.emit('connection_change', this.#state.status);

        dataChannel.addEventListener('open', () => {
          this.#state = {
            status: 'connected',
            peerConnection,
            dataChannel,
            callId,
          };
          // Sending the session config again here once the channel is connected to ensure
          // that the session config is sent to the server before the first response is received
          // Setting it on connection should work but the config is not being validated on the
          // server. This triggers a validation error if the config is not valid.
          this.updateSessionConfig(userSessionConfig);
          this.emit('connection_change', this.#state.status);
          this._onOpen();
          resolve();
        });

        dataChannel.addEventListener('error', (event) => {
          this.close();
          this._onError(event);
          reject(event);
        });

        dataChannel.addEventListener('message', (event) => {
          this._onMessage(event);
          const { data: parsed, isGeneric } = parseRealtimeEvent(event);
          if (!parsed || isGeneric) {
            return;
          }

          if (parsed.type === 'response.created') {
            this.#ongoingResponse = true;
          } else if (parsed.type === 'response.done') {
            this.#ongoingResponse = false;
          }

          if (parsed.type === 'session.created') {
            this._tracingConfig = parsed.session.tracing;
            // Trying to turn on tracing after the session is created
            const tracingConfig =
              typeof userSessionConfig.tracing === 'undefined'
                ? 'auto'
                : userSessionConfig.tracing;
            this._updateTracingConfig(tracingConfig);
          }
        });

        // set up audio playback
        const audioElement =
          this.options.audioElement ?? document.createElement('audio');
        audioElement.autoplay = true;
        peerConnection.ontrack = (event) => {
          audioElement.srcObject = event.streams[0];
        };

        // get microphone stream
        const stream =
          this.options.mediaStream ??
          (await navigator.mediaDevices.getUserMedia({
            audio: true,
          }));
        peerConnection.addTrack(stream.getAudioTracks()[0]);

        if (this.options.changePeerConnection) {
          const originalPeerConnection = peerConnection;
          peerConnection =
            await this.options.changePeerConnection(peerConnection);
          if (originalPeerConnection !== peerConnection) {
            originalPeerConnection.onconnectionstatechange = null;
          }
          attachConnectionStateHandler(peerConnection);
          this.#state = { ...this.#state, peerConnection };
        }

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        if (!offer.sdp) {
          throw new Error('Failed to create offer');
        }

        const sdpResponse = await fetch(connectionUrl, {
          method: 'POST',
          body: offer.sdp,
          headers: {
            'Content-Type': 'application/sdp',
            Authorization: `Bearer ${apiKey}`,
            'X-OpenAI-Agents-SDK': HEADERS['X-OpenAI-Agents-SDK'],
          },
        });

        callId = sdpResponse.headers?.get('Location')?.split('/').pop();
        this.#state = { ...this.#state, callId };

        const answer: RTCSessionDescriptionInit = {
          type: 'answer',
          sdp: await sdpResponse.text(),
        };

        await peerConnection.setRemoteDescription(answer);
      } catch (error) {
        this.close();
        this._onError(error);
        reject(error);
      }
    });
  }

  /**
   * Send an event to the Realtime API. This will stringify the event and send it directly to the
   * API. This can be used if you want to take control over the connection and send events manually.
   *
   * @param event - The event to send.
   */
  sendEvent(event: RealtimeClientMessage): void {
    if (
      !this.#state.dataChannel ||
      this.#state.dataChannel.readyState !== 'open'
    ) {
      throw new Error(
        'WebRTC data channel is not connected. Make sure you call `connect()` before sending events.',
      );
    }
    this.#state.dataChannel.send(JSON.stringify(event));
  }

  /**
   * Mute or unmute the session.
   * @param muted - Whether to mute the session.
   */
  mute(muted: boolean) {
    this.#muted = muted;
    if (this.#state.peerConnection) {
      const peerConnection = this.#state.peerConnection;
      peerConnection.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.enabled = !muted;
        }
      });
    }
  }

  protected override _afterAudioDoneEvent() {
    this.#ongoingResponse = false;
  }

  /**
   * Close the connection to the Realtime API and disconnects the underlying WebRTC connection.
   */
  close() {
    if (this.#state.dataChannel) {
      this.#state.dataChannel.close();
    }

    if (this.#state.peerConnection) {
      const peerConnection = this.#state.peerConnection;
      peerConnection.onconnectionstatechange = null;
      peerConnection.getSenders().forEach((sender) => {
        sender.track?.stop();
      });
      peerConnection.close();
    }

    if (this.#state.status !== 'disconnected') {
      this.#state = {
        status: 'disconnected',
        peerConnection: undefined,
        dataChannel: undefined,
        callId: undefined,
      };
      this.emit('connection_change', this.#state.status);
      this._onClose();
    }
  }

  /**
   * Interrupt the current response if one is ongoing and clear the audio buffer so that the agent
   * stops talking.
   */
  interrupt() {
    if (this.#ongoingResponse) {
      this.sendEvent({
        type: 'response.cancel',
      });
      this.#ongoingResponse = false;
    }

    this.sendEvent({
      type: 'output_audio_buffer.clear',
    });
  }
}
