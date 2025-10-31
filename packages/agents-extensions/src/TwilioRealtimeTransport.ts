import {
  OpenAIRealtimeWebSocket,
  OpenAIRealtimeWebSocketOptions,
  utils,
  RealtimeTransportLayerConnectOptions,
  TransportLayerAudio,
  RealtimeSessionConfig,
} from '@openai/agents/realtime';
import { getLogger } from '@openai/agents';
import type {
  WebSocket as NodeWebSocket,
  MessageEvent as NodeMessageEvent,
  ErrorEvent as NodeErrorEvent,
} from 'ws';

import type { ErrorEvent } from 'undici-types';

/**
 * The options for the Twilio Realtime Transport Layer.
 */
export type TwilioRealtimeTransportLayerOptions =
  OpenAIRealtimeWebSocketOptions & {
    /**
     * The websocket that is receiving messages from Twilio's Media Streams API. Typically the
     * connection gets passed into your request handler when running your WebSocket server.
     */
    twilioWebSocket: WebSocket | NodeWebSocket;
    // Optional resampler hooks. They can be async or sync.
    // data: ArrayBuffer audio payload, from: input audio format label, to: target audio format label
    resampleIncoming?: (
      data: ArrayBuffer,
      from?: string,
      to?: string,
    ) => Promise<ArrayBuffer> | ArrayBuffer;
    resampleOutgoing?: (
      data: ArrayBuffer,
      from?: string,
      to?: string,
    ) => Promise<ArrayBuffer> | ArrayBuffer;
  };

/**
 * An adapter to connect a websocket that is receiving messages from Twilio's Media Streams API to
 * the OpenAI Realtime API via WebSocket.
 *
 * It automatically handles setting the right audio format for the input and output audio, passing
 * the data along and handling the timing for interruptions using Twilio's `mark` events.
 *
 * It does require you to run your own WebSocket server that is receiving connection requests from
 * Twilio.
 *
 * It will emit all Twilio received messages as `twilio_message` type messages on the `*` handler.
 * If you are using a `RealtimeSession` you can listen to the `transport_event`.
 *
 * @example
 * ```ts
 * const transport = new TwilioRealtimeTransportLayer({
 *   twilioWebSocket: twilioWebSocket,
 * });
 *
 * transport.on('*', (event) => {
 *   if (event.type === 'twilio_message') {
 *     console.log('Twilio message:', event.data);
 *   }
 * });
 * ```
 */
export class TwilioRealtimeTransportLayer extends OpenAIRealtimeWebSocket {
  #twilioWebSocket: WebSocket | NodeWebSocket;
  #streamSid: string | null = null;
  #audioChunkCount: number = 0;
  #lastPlayedChunkCount: number = 0;
  #previousItemId: string | null = null;
  #logger = getLogger('openai-agents:extensions:twilio');
  #resampleIncoming?: (
    data: ArrayBuffer,
    from?: string,
    to?: string,
  ) => Promise<ArrayBuffer> | ArrayBuffer;
  #resampleOutgoing?: (
    data: ArrayBuffer,
    from?: string,
    to?: string,
  ) => Promise<ArrayBuffer> | ArrayBuffer;
  // audio format expected by Twilio (default g711_ulaw)
  #twilioAudioFormat: string = 'g711_ulaw';

  constructor(options: TwilioRealtimeTransportLayerOptions) {
    super(options);
    this.#twilioWebSocket = options.twilioWebSocket;
    this.#resampleIncoming = options.resampleIncoming;
    this.#resampleOutgoing = options.resampleOutgoing;
  }

  _setInputAndOutputAudioFormat(
    partialConfig?: Partial<RealtimeSessionConfig>,
  ) {
    let newConfig: Partial<RealtimeSessionConfig> = {};
    if (!partialConfig) {
      // @ts-expect-error - this is a valid config
      newConfig.inputAudioFormat = 'g711_ulaw';
      // @ts-expect-error - this is a valid config
      newConfig.outputAudioFormat = 'g711_ulaw';
    } else {
      newConfig = {
        ...partialConfig,
        // @ts-expect-error - this is a valid config
        inputAudioFormat: partialConfig.inputAudioFormat ?? 'g711_ulaw',
        // @ts-expect-error - this is a valid config
        outputAudioFormat: partialConfig.outputAudioFormat ?? 'g711_ulaw',
      };
    }
    return newConfig;
  }

  async connect(options: RealtimeTransportLayerConnectOptions) {
    options.initialSessionConfig = this._setInputAndOutputAudioFormat(
      options.initialSessionConfig,
    );

    // Keep the transport's twilioAudioFormat in sync with initial session config
    // (outputAudioFormat is what we will send to Twilio)
    this.#twilioAudioFormat =
      // @ts-expect-error - this is a valid config
      options.initialSessionConfig?.outputAudioFormat ?? 'g711_ulaw';

    // listen to Twilio messages as quickly as possible
    this.#twilioWebSocket.addEventListener(
      'message',
      async (message: MessageEvent | NodeMessageEvent) => {
        try {
          const data = JSON.parse(message.data.toString());
          if (this.#logger.dontLogModelData) {
            this.#logger.debug('Twilio message:', data.event);
          } else {
            this.#logger.debug('Twilio message:', data);
          }
          this.emit('*', {
            type: 'twilio_message',
            message: data,
          });
          switch (data.event) {
            case 'media':
              if (this.status === 'connected') {
                // Twilio sends base64 payloads
                let buffer = utils.base64ToArrayBuffer(data.media.payload);

                // If user supplied a resampler, call it to convert to the internal Realtime expected format
                if (this.#resampleIncoming) {
                  try {
                    const maybePromise = this.#resampleIncoming(
                      buffer,
                      // Twilio payload format (we assume Twilio->transport input)
                      data.media?.format ?? undefined,
                      // target format we used for inputAudioFormat
                      // (we infer from initialSessionConfig or default to g711_ulaw)
                      // @ts-expect-error - this is a valid config
                      options.initialSessionConfig?.inputAudioFormat ??
                        'g711_ulaw',
                    );
                    buffer = (await maybePromise) ?? buffer;
                  } catch (err) {
                    this.#logger.error('Incoming resampling failed:', err);
                    // fall back to original buffer
                  }
                }

                this.sendAudio(buffer);
              }
              break;
            case 'mark':
              if (
                !data.mark.name.startsWith('done:') &&
                data.mark.name.includes(':')
              ) {
                // keeping track of what the last chunk was that the user heard fully
                const count = Number(data.mark.name.split(':')[1]);
                if (Number.isFinite(count)) {
                  this.#lastPlayedChunkCount = count;
                } else {
                  this.#logger.warn(
                    'Invalid mark name received:',
                    data.mark.name,
                  );
                }
              } else if (data.mark.name.startsWith('done:')) {
                this.#lastPlayedChunkCount = 0;
              }
              break;
            case 'start':
              this.#streamSid = data.start.streamSid;
              break;
            default:
              break;
          }
        } catch (error) {
          this.#logger.error(
            'Error parsing message:',
            error,
            'Message:',
            message,
          );
          this.emit('error', {
            type: 'error',
            error,
          });
        }
      },
    );
    this.#twilioWebSocket.addEventListener('close', () => {
      if (this.status !== 'disconnected') {
        this.close();
      }
    });
    this.#twilioWebSocket.addEventListener(
      'error',
      (error: ErrorEvent | NodeErrorEvent) => {
        this.emit('error', {
          type: 'error',
          error,
        });
        this.close();
      },
    );
    this.on('audio_done', () => {
      this.#twilioWebSocket.send(
        JSON.stringify({
          event: 'mark',
          mark: {
            name: `done:${this.currentItemId}`,
          },
          streamSid: this.#streamSid,
        }),
      );
    });
    await super.connect(options);
  }

  updateSessionConfig(config: Partial<RealtimeSessionConfig>): void {
    const newConfig = this._setInputAndOutputAudioFormat(config);
    super.updateSessionConfig(newConfig);
  }

  _interrupt(_elapsedTime: number, cancelOngoingResponse: boolean = true) {
    const elapsedTime = this.#lastPlayedChunkCount + 50; /* 50ms buffer */
    this.#logger.debug(
      `Interruption detected, clearing Twilio audio and truncating OpenAI audio after ${elapsedTime}ms`,
    );
    this.#twilioWebSocket.send(
      JSON.stringify({
        event: 'clear',
        streamSid: this.#streamSid,
      }),
    );
    super._interrupt(elapsedTime, cancelOngoingResponse);
  }

  protected async _onAudio(audioEvent: TransportLayerAudio) {
    this.#logger.debug(
      `Sending audio to Twilio ${audioEvent.responseId}: (${audioEvent.data.byteLength} bytes)`,
    );
    // Allow user-provided resampler to convert outgoing Realtime audio to Twilio format.
    let twilioPayloadBuffer: ArrayBuffer = audioEvent.data;

    if (this.#resampleOutgoing) {
      try {
        const maybePromise = this.#resampleOutgoing(
          audioEvent.data,
          // from: Realtime internal audio format (unknown here), leave undefined
          undefined,
          // to: format Twilio expects for outgoing audio
          this.#twilioAudioFormat,
        );
        twilioPayloadBuffer = (await maybePromise) ?? audioEvent.data;
      } catch (err) {
        this.#logger.error('Outgoing resampling failed:', err);
        // fall back to original audioEvent.data
        twilioPayloadBuffer = audioEvent.data;
      }
    }

    const audioDelta = {
      event: 'media',
      streamSid: this.#streamSid,
      media: {
        payload: utils.arrayBufferToBase64(twilioPayloadBuffer),
      },
    };
    if (this.#previousItemId !== this.currentItemId && this.currentItemId) {
      this.#previousItemId = this.currentItemId;
      this.#audioChunkCount = 0;
    }
    this.#audioChunkCount += audioEvent.data.byteLength / 8;
    this.#twilioWebSocket.send(JSON.stringify(audioDelta));
    this.#twilioWebSocket.send(
      JSON.stringify({
        event: 'mark',
        streamSid: this.#streamSid,
        mark: {
          name: `${this.currentItemId}:${this.#audioChunkCount}`,
        },
      }),
    );
    this.emit('audio', audioEvent);
  }
}

// vim:ts=2 sw=2 et:
