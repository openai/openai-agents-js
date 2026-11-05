import {
  RealtimeTransportLayer,
  OpenAIRealtimeWebSocket,
  OpenAIRealtimeWebSocketOptions,
} from '@openai/agents/realtime';

/**
 * An adapter transport for Cloudflare Workers (workerd) environments.
 *
 * This transport opens an outbound WebSocket with a `fetch()` request containing
 * `Upgrade: websocket`, then calls `accept()` on the returned `response.webSocket`.
 * Use it in workerd runtimes that provide these APIs. It plugs into the Realtime SDK
 * via the factory-based `createWebSocket` option.
 *
 * It behaves like `OpenAIRealtimeWebSocket`, but establishes the connection using `fetch()` and
 * sets `skipOpenEventListeners: true` since workerd sockets do not emit a traditional `open`
 * event after acceptance.
 *
 * Reference: Response API — `response.webSocket` (Cloudflare Workers).
 * https://developers.cloudflare.com/workers/runtime-apis/response/.
 */
export class CloudflareRealtimeTransportLayer
  extends OpenAIRealtimeWebSocket
  implements RealtimeTransportLayer
{
  protected _audioLengthMs: number = 0;

  constructor(options: OpenAIRealtimeWebSocketOptions) {
    super({
      ...options,
      createWebSocket: async ({ url, apiKey }) => {
        return await this.#buildCloudflareWebSocket({ url, apiKey });
      },
      skipOpenEventListeners: true,
    });
  }

  /**
   * Builds a WebSocket using Cloudflare's `fetch()` + `Upgrade: websocket` flow and accepts it.
   * Transforms `ws(s)` to `http(s)` for the upgrade request and forwards standard headers.
   */
  async #buildCloudflareWebSocket({
    url,
    apiKey,
  }: {
    url: string;
    apiKey: string;
  }): ReturnType<
    NonNullable<OpenAIRealtimeWebSocketOptions['createWebSocket']>
  > {
    const transformedUrl = url.replace(/^ws/i, 'http');
    if (!transformedUrl) {
      throw new Error('Realtime URL is not defined');
    }

    const response = await fetch(transformedUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Sec-WebSocket-Protocol': 'realtime',
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        ...this.getCommonRequestHeaders(),
      },
    });

    const upgradedSocket = (response as any).webSocket;
    if (!upgradedSocket) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Failed to upgrade websocket: ${response.status} ${body}`,
      );
    }

    upgradedSocket.accept();
    return upgradedSocket;
  }
}
