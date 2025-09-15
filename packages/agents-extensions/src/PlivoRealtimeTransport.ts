import {
  OpenAIRealtimeWebSocket,
  OpenAIRealtimeWebSocketOptions,
  utils,
  RealtimeTransportLayerConnectOptions,
  TransportLayerAudio,
  RealtimeSessionConfig,
} from '@openai/agents/realtime';
import type {
  WebSocket as NodeWebSocket,
  MessageEvent as NodeMessageEvent,
} from 'ws';

enum PlivoEventTypes {
  START = 'start',
  MEDIA = 'media',
  STOP = 'stop',
  PLAY_AUDIO = 'playAudio',
}

enum PlivoContentTypes {
  MULAW = 'audio/x-mulaw',
  LINEAR16 = 'audio/x-l16',
}

export type PlivoRealtimeTransportLayerOptions =
  OpenAIRealtimeWebSocketOptions & {
    /**
     * The websocket that is receiving messages from Plivo's Media Streams API. Typically the
     * connection gets passed into your request handler when running your WebSocket server.
     */
    plivoWebSocket: WebSocket | NodeWebSocket;
  };

export class PlivoRealtimeTransportLayer extends OpenAIRealtimeWebSocket {
  #plivoWebSocket: WebSocket | NodeWebSocket;
  // #streamId: string | null = null;
  constructor(options: PlivoRealtimeTransportLayerOptions) {
    super(options);
    this.#plivoWebSocket = options.plivoWebSocket;
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

  updateSessionConfig(config: Partial<RealtimeSessionConfig>): void {
    const newConfig = this._setInputAndOutputAudioFormat(config);
    super.updateSessionConfig(newConfig);
  }

  /**
   * This event is fired when the model sends audio to the transport layer.
   * @param audioEvent
   */
  protected _onAudio(audioEvent: TransportLayerAudio): void {
    try {
      this.#plivoWebSocket.send(
        JSON.stringify({
          event: PlivoEventTypes.PLAY_AUDIO,
          media: {
            contentType: PlivoContentTypes.MULAW,
            sampleRate: 8000,
            payload: utils.arrayBufferToBase64(audioEvent.data),
          },
        }),
      );
      this.emit('audio', audioEvent);
    } catch (error) {
      this.emit('error', {
        type: 'error',
        error,
      });
    }
  }

  // connect to the plivo websocket
  async connect(options: RealtimeTransportLayerConnectOptions) {
    options.initialSessionConfig = this._setInputAndOutputAudioFormat(
      options.initialSessionConfig,
    );
    this.#plivoWebSocket.addEventListener(
      'message',
      async (message: MessageEvent | NodeMessageEvent) => {
        const data = JSON.parse(message.data.toString());
        switch (data?.event) {
          case PlivoEventTypes.MEDIA:
            this.sendAudio(utils.base64ToArrayBuffer(data?.media?.payload));
            break;
          default:
            break;
        }
        this.emit('*', {
          type: 'plivo_message',
          message: data,
        });
      },
    );
    this.#plivoWebSocket.addEventListener('error', (error: any) => {
      this.emit('error', {
        type: 'error',
        error,
      });
    });
    this.#plivoWebSocket.addEventListener('close', async () => {
      this.emit('close');
    });
    this.#plivoWebSocket.addEventListener('open', () => {
      this.emit('open');
    });
    await super.connect(options);
  }
}
