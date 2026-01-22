import type { StreamedRunResult } from '@openai/agents';

export type AiSdkTextStreamSource =
  | ReadableStream<string>
  | StreamedRunResult<any, any>
  | { toTextStream: () => ReadableStream<string> };

export type AiSdkTextStreamHeaders =
  | Headers
  | Record<string, string>
  | Array<[string, string]>;

export type AiSdkTextStreamResponseOptions = {
  headers?: AiSdkTextStreamHeaders;
  status?: number;
  statusText?: string;
};

function resolveTextStream(
  source: AiSdkTextStreamSource,
): ReadableStream<string> {
  if (
    typeof (source as { toTextStream?: unknown }).toTextStream === 'function'
  ) {
    return (
      source as { toTextStream: () => ReadableStream<string> }
    ).toTextStream();
  }
  return source as ReadableStream<string>;
}

function encodeTextStream(
  textStream: ReadableStream<string>,
): ReadableStream<Uint8Array> {
  if (typeof TextEncoderStream !== 'undefined') {
    return textStream.pipeThrough(new TextEncoderStream());
  }

  const encoder = new TextEncoder();
  return textStream.pipeThrough(
    new TransformStream<string, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(encoder.encode(chunk));
      },
    }),
  );
}

function withDefaultHeaders(headers?: AiSdkTextStreamHeaders): Headers {
  const result = new Headers(headers);
  if (!result.has('content-type')) {
    result.set('content-type', 'text/plain; charset=utf-8');
  }
  if (!result.has('cache-control')) {
    result.set('cache-control', 'no-cache');
  }
  return result;
}

/**
 * Creates a text-only streaming Response compatible with AI SDK UI text streams.
 */
export function createAiSdkTextStreamResponse(
  source: AiSdkTextStreamSource,
  options: AiSdkTextStreamResponseOptions = {},
): Response {
  const textStream = resolveTextStream(source);
  const body = encodeTextStream(textStream);
  const headers = withDefaultHeaders(options.headers);

  return new Response(body, {
    status: options.status ?? 200,
    statusText: options.statusText,
    headers,
  });
}
