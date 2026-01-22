import { describe, expect, test } from 'vitest';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createAiSdkTextStreamResponse } from '../../src/ai-sdk-ui/index';

function stringStream(chunks: string[]): ReadableStream<string> {
  return NodeReadableStream.from(
    (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    })(),
  ) as ReadableStream<string>;
}

async function readResponseText(response: Response): Promise<string> {
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    output += decoder.decode(value, { stream: true });
  }

  output += decoder.decode();
  return output;
}

describe('createAiSdkTextStreamResponse', () => {
  test('streams text and applies default headers', async () => {
    const response = createAiSdkTextStreamResponse(
      stringStream(['Hello', ' ', 'world']),
    );

    expect(response.headers.get('content-type')).toBe(
      'text/plain; charset=utf-8',
    );
    expect(response.headers.get('cache-control')).toBe('no-cache');
    await expect(readResponseText(response)).resolves.toBe('Hello world');
  });

  test('accepts a toTextStream source and respects header overrides', async () => {
    const response = createAiSdkTextStreamResponse(
      {
        toTextStream: () => stringStream(['One', ' ', 'more']),
      },
      {
        headers: {
          'cache-control': 'no-store',
        },
        status: 201,
      },
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(readResponseText(response)).resolves.toBe('One more');
  });
});
