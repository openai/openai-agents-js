// lib/realtime/CustomTransport.ts
import { RuntimeEventEmitter } from '@openai/agents-core';
import type {
  RealtimeTransportLayer,
  RealtimeTransportLayerConnectOptions,
  RealtimeClientMessage,
  RealtimeTransportEventTypes,
} from '@openai/agents-realtime';

export class CustomTransport
  extends RuntimeEventEmitter<RealtimeTransportEventTypes>
  implements RealtimeTransportLayer
{
  private ws: WebSocket | null = null;
  private url: string;

  // ライブラリの型定義に合わせて修正
  public status: 'connecting' | 'connected' | 'disconnected' | 'disconnecting' =
    'disconnected';
  public muted: boolean | null = false;

  constructor(url: string) {
    super();
    this.url = url;
  }

  async connect(options: RealtimeTransportLayerConnectOptions): Promise<void> {
    this.status = 'connecting';
    const connectUrl = options.url ?? this.url;
    // If connecting to OpenAI's realtime API from the browser, pass required subprotocols
    // including the ephemeral key as a protocol when possible.
    try {
      if (connectUrl.includes('api.openai.com') && options.apiKey) {
        const protocols = [
          'realtime',
          // ephemeral keys typically start with "ek_"; this is the expected subprotocol
          // shape used by the official SDK for browser-based connections.
          'openai-insecure-api-key.' + options.apiKey,
        ];
        // Debug: log the connection attempt and protocols
        try {
          console.log(
            '[CustomTransport] connecting to',
            connectUrl,
            'protocols=',
            protocols,
          );
        } catch {}
        // Pass protocols array to browser WebSocket constructor
        this.ws = new WebSocket(connectUrl, protocols as any);
      } else {
        try {
          console.log('[CustomTransport] connecting to', connectUrl);
        } catch {}
        this.ws = new WebSocket(connectUrl);
      }
    } catch (err) {
      // Fallback: try plain constructor
      try {
        console.log(
          '[CustomTransport] websocket connect failed, fallback plain',
          err,
        );
      } catch {}
      this.ws = new WebSocket(connectUrl);
    }

    this.ws.onopen = () => {
      this.status = 'connected';
      try {
        console.log('[CustomTransport] websocket open');
      } catch {}
      this.emit('connect');
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data as string);
        try {
          console.log('[CustomTransport] recv', data);
        } catch {}
        this.emit('event', data);
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    };

    this.ws.onclose = () => {
      this.status = 'disconnected';
      try {
        console.log('[CustomTransport] websocket close');
      } catch {}
      this.emit('close');
    };

    this.ws.onerror = (error) => {
      try {
        console.error('[CustomTransport] websocket error', error);
      } catch {}
      this.emit('error', error);
    };
  }

  sendEvent(event: RealtimeClientMessage): void {
    if (this.ws && this.status === 'connected') {
      this.ws.send(JSON.stringify(event));
    }
  }

  sendMessage(
    message: string | any,
    otherEventData: Record<string, any> = {},
    options?: { triggerResponse?: boolean },
  ): void {
    const text = typeof message === 'string' ? message : (message as any).text;
    const evt: RealtimeClientMessage = {
      type: 'input_text',
      text,
      ...otherEventData,
    } as unknown as RealtimeClientMessage;

    if (options?.triggerResponse === false) {
      (evt as any).trigger_response = false;
    }

    this.sendEvent(evt);
  }

  addImage(image: string, options?: { triggerResponse?: boolean }): void {
    const evt: RealtimeClientMessage = {
      type: 'input_image',
      image,
    } as unknown as RealtimeClientMessage;

    if (options?.triggerResponse === false) {
      (evt as any).trigger_response = false;
    }

    this.sendEvent(evt);
  }

  sendAudio(audio: ArrayBuffer, options: { commit?: boolean } = {}): void {
    // Convert to base64 string for wire transport
    const bytes = new Uint8Array(audio);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 =
      typeof btoa === 'function'
        ? btoa(binary)
        : Buffer.from(binary, 'binary').toString('base64');

    const evt: RealtimeClientMessage = {
      type: 'input_audio_buffer',
      audio: base64,
      commit: !!options.commit,
    } as unknown as RealtimeClientMessage;

    this.sendEvent(evt);
  }

  updateSessionConfig(config: Partial<any>): void {
    const evt: RealtimeClientMessage = {
      type: 'session.update',
      session: config,
    } as unknown as RealtimeClientMessage;

    this.sendEvent(evt);
  }

  close(): void {
    this.status = 'disconnecting';
    this.ws?.close();
  }

  mute(muted: boolean): void {
    this.muted = muted;
    this.emit('muted', muted);
  }

  sendFunctionCallOutput(
    toolCall: any,
    output: string,
    startResponse: boolean,
  ): void {
    const evt: RealtimeClientMessage = {
      type: 'tool_call_output',
      tool_call: toolCall,
      output,
      start_response: startResponse,
    } as unknown as RealtimeClientMessage;

    this.sendEvent(evt);
  }

  interrupt(): void {
    const evt: RealtimeClientMessage = {
      type: 'interrupt',
    } as unknown as RealtimeClientMessage;
    this.sendEvent(evt);
  }

  resetHistory(oldHistory: any[], newHistory: any[]): void {
    const evt: RealtimeClientMessage = {
      type: 'session.reset_history',
      old_history: oldHistory,
      new_history: newHistory,
    } as unknown as RealtimeClientMessage;

    this.sendEvent(evt);
  }

  sendMcpResponse(approvalRequest: any, approved: boolean): void {
    const evt: RealtimeClientMessage = {
      type: 'mcp_response',
      request: approvalRequest,
      approved,
    } as unknown as RealtimeClientMessage;

    this.sendEvent(evt);
  }
}
