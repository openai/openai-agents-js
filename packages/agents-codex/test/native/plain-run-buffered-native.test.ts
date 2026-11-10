import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, NativeError, NativeProvider } from '../../src';
import { binding } from '../../src/runtime/binding';
import { ModelServer, message } from './fixtures/model-server';

function jsonResponse(id: string, parts: readonly string[]) {
  return {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-request-id': `upstream-${id}`,
      'x-ratelimit-remaining-requests': '7',
    },
    body: JSON.stringify({
      id,
      object: 'response',
      model: 'gpt-5',
      status: 'completed',
      output: [
        {
          ...message(''),
          id: `${id}-message`,
          content: parts.map((text) => ({ type: 'output_text', text })),
        },
      ],
      usage: {
        input_tokens: 20,
        input_tokens_details: { cached_tokens: 5 },
        output_tokens: 10,
        output_tokens_details: { reasoning_tokens: 3 },
        total_tokens: 30,
      },
    }),
  };
}

async function bufferedProvider(server: ModelServer, streamMaxRetries = 0) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-buffered-plain',
    responseMode: 'buffered',
    supportsWebsockets: false,
    requestMaxRetries: 0,
    streamMaxRetries,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'buffered plain Agent.run',
  () => {
    it('uses the actual plain JSON owner with exact metadata, usage and multipart replay', async () => {
      const parts = ['first "🦀"\n', 'second\\\u0000'];
      const reply = jsonResponse('buffered-result', parts);
      reply.body = reply.body
        .replace('"input_tokens":20', '"input_tokens":9007199254740993')
        .replace('"total_tokens":30', '"total_tokens":9007199254741003');
      const server = new ModelServer([reply]);
      await using provider = await bufferedProvider(server);
      const native = await binding();
      const start = native.Engine.prototype._plain_run;
      const wireResults: { responseId: string; requestId: string }[] = [];
      const run = vi
        .spyOn(native.Engine.prototype, '_plain_run')
        .mockImplementation(async function (
          this: typeof native.Engine.prototype,
          input: string,
        ) {
          const owned = await start.call(this, input);
          const wait = owned.wait;
          vi.spyOn(owned, 'wait').mockImplementation(async () => {
            const result = await wait.call(owned);
            wireResults.push(JSON.parse(result));
            return result;
          });
          return owned;
        });
      const open = vi.spyOn(
        native.Engine.prototype,
        'start_replaceable_thread',
      );
      const completed = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        modelSettings: { reasoningEffort: 'low' },
        provider,
      }).run('buffered input');
      expect(run).toHaveBeenCalledTimes(1);
      expect(open).not.toHaveBeenCalled();
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]).toMatchObject({
        stream: false,
        client_metadata: {
          session_id: completed.turn.sessionId,
          thread_id: completed.turn.sessionId,
          turn_id: completed.turn.turnId,
        },
      });
      expect(server.requests[0]).not.toHaveProperty('stream_options');
      expect(server.requestHeaders[0]?.accept).toBe('application/json');
      expect(wireResults).toMatchObject([
        {
          responseId: 'buffered-result',
          requestId: 'upstream-buffered-result',
        },
      ]);
      expect(completed.finalOutput).toBe(parts.join(''));
      expect(completed.threadUsage?.totalTokenUsage).toEqual({
        inputTokens: 9_007_199_254_740_993n,
        cachedInputTokens: 5,
        cacheWriteInputTokens: 0,
        outputTokens: 10,
        reasoningOutputTokens: 3,
        totalTokens: 9_007_199_254_741_003n,
      });
      const events = await Array.fromAsync(completed.turn.events());
      expect(
        events
          .filter((event) => event.type === 'output_text_delta')
          .map((event) => event.delta),
      ).toEqual(parts);
      expect(
        events.find((event) => event.type === 'model_request_dispatching'),
      ).toMatchObject({ transport: 'http_json' });
      expect(
        events.find((event) => event.type === 'api_rate_limits_updated'),
      ).toMatchObject({ snapshot: { requests: { remaining: 7 } } });
      const types = events.map((event) => event.type);
      expect(types.indexOf('model_request_dispatching')).toBeLessThan(
        types.indexOf('output_text_delta'),
      );
      expect(types.lastIndexOf('output_text_delta')).toBeLessThan(
        types.indexOf('usage_updated'),
      );
      expect(await Array.fromAsync(completed.turn.events())).toEqual(events);
      server.assertExhausted();
    }, 30_000);

    it.each([0, 1])(
      'handles truncated JSON with retry budget %s without retaining its prefix',
      async (streamMaxRetries) => {
        const truncated = jsonResponse('truncated', ['discarded prefix']);
        truncated.body = truncated.body.slice(0, -1);
        const server = new ModelServer([
          truncated,
          ...(streamMaxRetries
            ? [jsonResponse('recovered', ['recovered answer'])]
            : []),
        ]);
        await using provider = await bufferedProvider(server, streamMaxRetries);
        const run = vi.spyOn((await binding()).Engine.prototype, '_plain_run');
        const running = new Agent({
          instructions: 'Answer.',
          model: 'gpt-5',
          provider,
        }).run('recover');
        if (streamMaxRetries === 0) {
          await expect(running).rejects.toBeInstanceOf(NativeError);
        } else {
          const completed = await running;
          expect(completed.finalOutput).toBe('recovered answer');
          expect(server.requests[1]?.input).toEqual(server.requests[0]?.input);
          const events = await Array.fromAsync(completed.turn.events());
          expect(
            events
              .filter((event) => event.type === 'output_text_delta')
              .map((event) => event.delta),
          ).toEqual(['recovered answer']);
        }
        expect(run).toHaveBeenCalledTimes(1);
        expect(server.requests).toHaveLength(streamMaxRetries + 1);
        server.assertExhausted();
      },
      30_000,
    );

    it('joins an abort after JSON headers and leaves the next run usable', async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const server = new ModelServer(
        [
          jsonResponse('aborted', ['unused']),
          jsonResponse('next', ['next answer']),
        ],
        [],
        undefined,
        undefined,
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      await using provider = await bufferedProvider(server);
      const agent = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      });
      const controller = new AbortController();
      const reason = new Error('caller body cancellation');
      const running = agent.run('abort', { signal: controller.signal });
      void running.catch(() => undefined);
      try {
        await entered.promise;
        controller.abort(reason);
        await expect(running).rejects.toBe(reason);
      } finally {
        release.resolve();
      }
      const completed = await agent.run('next');
      expect(completed.finalOutput).toBe('next answer');
      await provider.close();
      expect(await completed.turn.wait()).toBe(completed);
      expect(server.requests).toHaveLength(2);
      server.assertExhausted();
    }, 30_000);

    it('keeps explicit streaming on the existing SSE owner', async () => {
      const server = new ModelServer([[message('streamed answer')]]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-explicit-streaming',
        responseMode: 'streaming',
        supportsWebsockets: false,
      });
      const run = vi.spyOn((await binding()).Engine.prototype, '_plain_run');
      const completed = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      }).run('stream');
      expect(completed.finalOutput).toBe('streamed answer');
      expect(run).toHaveBeenCalledTimes(1);
      expect(server.requests[0]?.stream).toBe(true);
      expect(server.requestHeaders[0]?.accept).toBe('text/event-stream');
      server.assertExhausted();
    }, 30_000);
  },
);
