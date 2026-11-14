import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { beforeAll, expect, it } from 'vitest';
import * as api from '../src/runtime/workerd';
import type { JsonObject } from '../src/runtime/binding';
import {
  googleRawResponse,
  responsesRawFrames,
  rawFileData,
  workerRawProviderFixture,
  stopWorkerRawFixture,
} from './fixtures/worker-raw-provider';
let control: WebAssembly.Module;
beforeAll(async () => {
  control = new WebAssembly.Module(
    await readFile(
      new URL('../native/codex-turn-control.wasm', import.meta.url),
    ),
  );
});
it.each(['google', 'responses'] as const)(
  'observes real %s provider parts independently of canonical state',
  async (carrier) => {
    const bodies: JsonObject[] = [];
    const server = createServer(async (request, reply) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      bodies.push(JSON.parse(body));
      reply.setHeader('content-type', 'text/event-stream');
      const events =
        carrier === 'google' ? [googleRawResponse] : responsesRawFrames;
      reply.end(
        events
          .map((event) => 'data: ' + JSON.stringify(event) + '\n\n')
          .join(''),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
      for (const capture of [false, true]) {
        const result = await workerRawProviderFixture(
          api,
          control,
          base,
          carrier,
          capture,
        );
        expect(result.held).toBe(false);
        expect(result.snapshot).not.toContain(rawFileData);
        if (carrier === 'google')
          expect(JSON.stringify(result.normalized)).not.toContain(rawFileData);
        expect(
          result.normalized
            .filter((e) => e.type === 'response.output_text.delta')
            .map((e) => e.delta),
        ).toEqual(['Visible answer.', 'Visible answer.']);
        if (!capture) expect(result.raw).toEqual([]);
        else if (carrier === 'google')
          expect(result.raw.filter((e) => e.type === 'file')).toEqual(
            [0, 1].map(() => ({
              type: 'file',
              mediaType: 'image/png',
              data: { type: 'data', data: rawFileData },
            })),
          );
        else
          expect(result.raw).toEqual([
            ...responsesRawFrames,
            ...responsesRawFrames,
          ]);
      }
      expect(bodies).toHaveLength(4);
      for (const body of bodies)
        expect(
          JSON.stringify(carrier === 'google' ? body.contents : body.input),
        ).not.toContain(rawFileData);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  30_000,
);

it('keeps unmarked projected response frames off the raw callback', async () => {
  const raw: unknown[] = [];
  const observed: unknown[] = [];
  const result = await api.runWorkerText('first', {
    control,
    model: 'fixture',
    instructions: 'Reply.',
    provider: {
      complete() {
        throw new Error('Unexpected buffered call');
      },
      async *stream() {
        yield* responsesRawFrames;
      },
    },
    observe: (e) => {
      observed.push(e);
    },
    observeRaw: (e) => {
      raw.push(e);
    },
  });
  expect(result).toBe('Visible answer.');
  expect(observed).toHaveLength(responsesRawFrames.length);
  expect(raw).toEqual([]);
});

it('observes tagged wire once without treating synthetic hosted projections as raw', async () => {
  const { markRawModelPart, markResponsesWebSocketStream } =
    await import('../src/runtime/models');
  const wire = {
    type: 'response.paused',
    response: { id: 'provider_physical_response' },
  };
  const raw: unknown[] = [];
  const result = await api.runWorkerText('first', {
    control,
    model: 'fixture',
    instructions: 'Reply.',
    provider: {
      complete() {
        throw new Error('Unexpected buffered call');
      },
      stream() {
        return markResponsesWebSocketStream(
          (async function* () {
            yield markRawModelPart(wire);
            yield* responsesRawFrames;
          })(),
        );
      },
    },
    observeRaw: (event) => {
      raw.push(event);
    },
  });
  expect(result).toBe('Visible answer.');
  expect(raw).toEqual([wire]);
});

it.each(['throw', 'abort'] as const)(
  'joins the real Responses reader when the raw observer stops by %s',
  async (mode) => {
    let closed = false;
    const server = createServer(async (request, reply) => {
      for await (const _chunk of request) {
        // Read the request body before sending the fixture response.
      }
      reply.on('close', () => {
        closed = true;
      });
      reply.setHeader('content-type', 'text/event-stream');
      reply.write('data: ' + JSON.stringify(responsesRawFrames[0]) + '\n\n');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const result = await stopWorkerRawFixture(
        api,
        control,
        `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        mode,
      );
      await expect.poll(() => closed).toBe(true);
      expect(result).toEqual({
        mode,
        observed: 1,
        saved: false,
        released: true,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
