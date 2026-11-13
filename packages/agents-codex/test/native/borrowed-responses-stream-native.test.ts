import OpenAI from 'openai';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, ResponsesModel, tool } from '../../src';
import type { JsonObject } from '../../src/runtime/binding';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

it.each([false, true])(
  'preserves borrowed SSE original usage and request IDs across tool continuation (capture=%s)',
  async (capture) => {
    const effects: string[] = [];
    const usage = {
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
      provider_extension: { values: [false, null, 0] },
    };
    let requests = 0;
    const client = new OpenAI({
      apiKey: 'synthetic',
      maxRetries: 0,
      fetch: async (_url, options) => {
        const body = JSON.parse(String(options?.body));
        expect(body.stream).toBe(true);
        const index = ++requests;
        if (index === 2) {
          expect(body.input).toContainEqual(
            expect.objectContaining({
              type: 'function_call_output',
              call_id: 'call_record',
            }),
          );
        }
        const item =
          index === 1
            ? {
                type: 'function_call',
                id: 'item_record',
                call_id: 'call_record',
                name: 'record',
                arguments: '{"value":"once"}',
              }
            : {
                type: 'message',
                id: 'msg_usage',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Done.' }],
              };
        const frames = [
          {
            type: 'response.created',
            response: { id: `resp_usage_${index}` },
          },
          { type: 'response.output_item.done', output_index: 0, item },
          {
            type: 'response.completed',
            response: { id: `resp_usage_${index}`, usage },
          },
        ];
        return new Response(
          frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
          {
            headers: {
              'content-type': 'text/event-stream',
              'x-request-id': `req_usage_${index}`,
            },
          },
        );
      },
    });
    await using provider = new NativeProvider({
      modelBackend: new ResponsesModel(client, undefined, { stream: true }),
    });
    const result = await new Agent({
      provider,
      model: 'fixture',
      instructions: 'Respond.',
      tools: [
        tool({
          name: 'record',
          description: 'Record one value.',
          parameters: z.object({ value: z.string() }),
          execute: ({ value }) => {
            effects.push(value);
            return 'Recorded.';
          },
        }),
      ],
    }).run('Begin.', { returnRawUsage: capture });
    expect(result.finalOutput).toBe('Done.');
    expect(effects).toEqual(['once']);
    expect(requests).toBe(2);
    if (capture)
      expect(result.rawUsage).toEqual(
        [1, 2].map((index) => ({
          responseId: `resp_usage_${index}`,
          upstreamRequestId: `req_usage_${index}`,
          usage,
        })),
      );
    else expect(result).not.toHaveProperty('rawUsage');
  },
  20_000,
);

it.each([false, true])(
  'delivers borrowed Responses deltas and preserves opt-in raw events (%s)',
  async (capture) => {
    const frames: JsonObject[] = [
      { type: 'response.created', response: { id: 'resp_borrowed' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_borrowed',
          role: 'assistant',
          content: [],
        },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_borrowed',
        output_index: 0,
        content_index: 0,
        delta: 'Visible.',
        fixture: { values: [false, null, 0] },
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_borrowed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Visible.' }],
        },
      },
      { type: 'response.completed', response: { id: 'resp_borrowed' } },
    ];
    const release = deferred();
    let requests = 0;
    const client = new OpenAI({
      apiKey: 'synthetic',
      baseURL: 'https://borrowed.invalid/v1',
      maxRetries: 0,
      fetch: async (url, options) => {
        expect(new URL(String(url)).pathname).toBe('/v1/responses');
        expect(new Headers(options?.headers).get('x-sdk-fixture')).toBe(
          'borrowed',
        );
        expect(JSON.parse(String(options?.body)).stream).toBe(true);
        requests++;
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            for (const [index, frame] of frames.entries()) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
              );
              if (index === 2) await release.promise;
            }
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    await using provider = new NativeProvider({
      modelBackend: new ResponsesModel(client, undefined, {
        stream: true,
        requestOptions: { headers: { 'x-sdk-fixture': 'borrowed' } },
      }),
    });
    await using session = await new Agent({
      provider,
      model: 'fixture',
      instructions: 'Respond.',
    }).session({
      includeRawProviderEvents: capture,
      observationRetention: 'all',
    });
    const turn = await session.submit('Begin.');
    const raw: JsonObject[] = [];
    const deltas: string[] = [];
    try {
      for await (const event of turn.events({
        includeExecutionDetails: true,
      })) {
        if (event.type === 'raw_provider_event') raw.push(event.payload);
        if (event.type === 'output_text_delta') {
          deltas.push(event.delta);
          release.resolve();
        }
      }
    } finally {
      release.resolve();
    }
    expect((await turn.wait()).finalOutput).toBe('Visible.');
    expect(deltas).toEqual(['Visible.']);
    expect(raw).toEqual(capture ? frames : []);
    expect(requests).toBe(1);
  },
  20_000,
);

it('closes the borrowed response iterator when the native turn is cancelled', async () => {
  const waiting = deferred();
  const closed = deferred();
  const client = {
    responses: {
      async create(body: JsonObject, options: { signal: AbortSignal }) {
        expect(body.stream).toBe(true);
        return (async function* () {
          try {
            yield {
              type: 'response.created',
              response: { id: 'resp_pending' },
            };
            yield {
              type: 'response.output_text.delta',
              delta: 'Partial.',
              item_id: 'msg_pending',
              output_index: 0,
              content_index: 0,
            };
            waiting.resolve();
            await new Promise<void>((resolve) => {
              if (options.signal.aborted) resolve();
              else
                options.signal.addEventListener('abort', () => resolve(), {
                  once: true,
                });
            });
          } finally {
            closed.resolve();
          }
        })();
      },
    },
    close() {
      throw new Error('The application owns the borrowed client');
    },
  };
  await using provider = new NativeProvider({
    modelBackend: new ResponsesModel(client, undefined, { stream: true }),
  });
  await using session = await new Agent({
    provider,
    model: 'fixture',
    instructions: 'Respond.',
  }).session();
  const turn = await session.submit('Begin.');
  const stopped = expect(turn.wait()).rejects.toThrow();
  await waiting.promise;
  await turn.cancel();
  await stopped;
  await closed.promise;
}, 20_000);
