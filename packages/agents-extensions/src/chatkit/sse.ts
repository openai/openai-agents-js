import type {
  ChatKitSseResponseOptions,
  ChatKitSseSource,
  ChatKitThreadStreamEvent,
} from './types';
import { resolveEventSource } from './utils';

export async function* encodeChatKitSse(
  events: AsyncIterable<ChatKitThreadStreamEvent>,
): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  for await (const event of events) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    yield encoder.encode(payload);
  }
}

function asyncIterableToReadableStream<T>(
  iterable: AsyncIterable<T>,
): ReadableStream<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<T>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel() {
      if (typeof iterator.return === 'function') {
        await iterator.return();
      }
    },
  });
}

function withDefaultHeaders(
  headers?: Headers | Record<string, string> | Array<[string, string]>,
): Headers {
  const result = new Headers(headers);
  if (!result.has('content-type')) {
    result.set('content-type', 'text/event-stream; charset=utf-8');
  }
  if (!result.has('cache-control')) {
    result.set('cache-control', 'no-cache');
  }
  return result;
}

export function createChatKitSseResponse(
  source: ChatKitSseSource,
  options: ChatKitSseResponseOptions = {},
): Response {
  const streamEvents = resolveEventSource(source);
  const body = asyncIterableToReadableStream(encodeChatKitSse(streamEvents));
  const headers = withDefaultHeaders(options.headers);

  return new Response(body, {
    status: options.status ?? 200,
    statusText: options.statusText,
    headers,
  });
}
