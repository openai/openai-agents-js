import OpenAI from 'openai';
import { expect, it } from 'vitest';
import {
  ResponsesModel,
  pumpModelStream,
  type ModelRequest,
} from '../src/runtime/models';

it('aborts an opened borrowed SSE transport when native admission fails before its first event', async () => {
  let transportSignal: AbortSignal | null | undefined;
  const client = new OpenAI({
    apiKey: 'synthetic',
    maxRetries: 0,
    fetch: async (_url, options) => {
      transportSignal = options?.signal;
      return new Response(
        'data: {"type":"response.created","response":{"id":"resp_pending"}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const controller = new AbortController();
  const request: ModelRequest = {
    body: { model: 'fixture', input: [] },
    context: undefined,
    sessionId: 'session',
    turnId: 'turn',
    signal: controller.signal,
  };
  const model = new ResponsesModel(client, undefined, { stream: true });
  const stream = await model.stream!(request);
  const stopped = new Error('Stopped before provider events.');
  expect(transportSignal?.aborted).toBe(false);
  await expect(
    pumpModelStream(stream, {
      check: () => {
        throw stopped;
      },
      start: () => {
        throw new Error('Cancelled stream entered native execution.');
      },
      push: async () => {
        throw new Error('Cancelled stream admitted provider output.');
      },
      finish: () => {
        throw new Error('Cancelled stream completed native execution.');
      },
    }),
  ).rejects.toBe(stopped);
  expect(transportSignal?.aborted).toBe(true);
});
