import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, NativeError, NativeProvider } from '../../src';
import { binding } from '../../src/runtime/binding';
import type { Engine, _PlainRun } from '../../native/index.js';
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

// Pass through the original promises; record only successful native owners.
async function observeOwners() {
  const native = await binding();
  const owners: { engine: Engine; run?: _PlainRun; root?: string }[] = [];
  const closed: Engine[] = [];
  const plain = native.Engine.prototype._plain_run;
  vi.spyOn(native.Engine.prototype, '_plain_run').mockImplementation(function (
    this: Engine,
    ...args
  ) {
    const pending = plain.apply(this, args);
    void pending.then(
      (run) => {
        owners.push({ engine: this, run });
      },
      () => {},
    );
    return pending;
  });
  const start = native.Engine.prototype.start_replaceable_thread;
  vi.spyOn(
    native.Engine.prototype,
    'start_replaceable_thread',
  ).mockImplementation(function (this: Engine, ...args) {
    const pending = start.apply(this, args);
    void pending.then(
      (thread) => {
        owners.push({ engine: this, root: thread.id });
      },
      () => {},
    );
    return pending;
  });
  const reuse = native.Engine.prototype._private_start_thread;
  vi.spyOn(native.Engine.prototype, '_private_start_thread').mockImplementation(
    function (this: Engine, ...args) {
      const pending = reuse.apply(this, args);
      void pending.then(
        (thread) => {
          if (thread) owners.push({ engine: this, root: thread.id });
        },
        () => {},
      );
      return pending;
    },
  );
  const close = native.Engine.prototype._close_report;
  vi.spyOn(native.Engine.prototype, '_close_report').mockImplementation(
    function (this: Engine, ...args) {
      const pending = close.apply(this, args);
      void pending.then(
        () => {
          closed.push(this);
        },
        () => {},
      );
      return pending;
    },
  );
  return { native, owners, closed };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
      const completedUsageIndex = events.findLastIndex(
        (event) => event.type === 'usage_updated' && event.usage !== null,
      );
      expect(types.lastIndexOf('output_text_delta')).toBeLessThan(
        completedUsageIndex,
      );
      expect(events[completedUsageIndex]).toMatchObject({
        usage: completed.threadUsage,
      });
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
      const observed = await observeOwners();
      const running = agent.run('abort', { signal: controller.signal });
      void running.catch(() => undefined);
      try {
        await entered.promise;
        controller.abort(reason);
        await expect(running).rejects.toBe(reason);
      } finally {
        release.resolve();
      }
      expect(observed.owners).toHaveLength(1);
      expect(observed.closed).toContain(observed.owners[0]!.engine);
      const completed = await agent.run('next');
      expect(observed.owners).toHaveLength(2);
      expect(observed.owners[1]!.engine).not.toBe(observed.owners[0]!.engine);
      expect(completed.finalOutput).toBe('next answer');
      await provider.close();
      expect(observed.closed).toContain(observed.owners[1]!.engine);
      expect(await completed.turn.wait()).toBe(completed);
      expect(server.requests).toHaveLength(2);
      server.assertExhausted();
    }, 30_000);

    it('reuses the buffered plain Engine with distinct joined runs and public IDs', async () => {
      const server = new ModelServer([
        jsonResponse('reuse-first', ['first answer']),
        jsonResponse('reuse-second', ['second answer']),
      ]);
      await using provider = await bufferedProvider(server);
      const observed = await observeOwners();
      const bind = vi.spyOn(observed.native.Engine.prototype, '_sentinel_bind');
      const agent = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      });
      const first = await agent.run('first reuse marker');
      const second = await agent.run('second reuse marker');
      expect([first.finalOutput, second.finalOutput]).toEqual([
        'first answer',
        'second answer',
      ]);
      expect(observed.owners).toHaveLength(2);
      const [a, b] = observed.owners;
      expect(a!.engine).toBe(b!.engine);
      expect(a!.run).toBeDefined();
      expect(b!.run).toBeDefined();
      expect(a!.run).not.toBe(b!.run);
      expect(observed.owners.every((owner) => owner.root === undefined)).toBe(
        true,
      );
      expect(bind).toHaveBeenCalledTimes(1);
      expect(bind.mock.contexts[0]).toBe(a!.engine);
      expect(bind.mock.calls[0]![3]).toBeTruthy();
      expect(first.turn.sessionId).not.toBe(second.turn.sessionId);
      expect(first.turn.turnId).not.toBe(second.turn.turnId);
      expect(first.turn.submissionId).not.toBe(second.turn.submissionId);
      expect(server.requests).toHaveLength(2);
      for (const request of server.requests) {
        expect(request.stream).toBe(false);
        expect(request).not.toHaveProperty('stream_options');
      }
      expect(JSON.stringify(server.requests[1]!.input)).toContain(
        'second reuse marker',
      );
      expect(JSON.stringify(server.requests[1]!.input)).not.toContain(
        'first reuse marker',
      );
      expect(JSON.stringify(server.requests[1]!.input)).not.toContain(
        'first answer',
      );
      await provider.close();
      expect(observed.closed).toEqual([a!.engine]);
      server.assertExhausted();
    }, 30_000);

    it('reuses buffered Engines for the real dormant-beforeCompact fallback with fresh roots', async () => {
      const server = new ModelServer([
        jsonResponse('fallback-first', ['fallback answer one']),
        jsonResponse('fallback-second', ['fallback answer two']),
      ]);
      await using provider = await bufferedProvider(server);
      const observed = await observeOwners();
      const beforeCompact = vi.fn(async () => undefined);
      const agent = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
        beforeCompact,
      });
      const first = await agent.run('first fallback marker');
      const second = await agent.run('second fallback marker');
      expect([first.finalOutput, second.finalOutput]).toEqual([
        'fallback answer one',
        'fallback answer two',
      ]);
      expect(beforeCompact).not.toHaveBeenCalled();
      expect(observed.owners).toHaveLength(2);
      const [a, b] = observed.owners;
      expect(a!.engine).toBe(b!.engine);
      expect(a!.run).toBeUndefined();
      expect(b!.run).toBeUndefined();
      expect(a!.root).toBeTruthy();
      expect(b!.root).toBeTruthy();
      expect(a!.root).not.toBe(b!.root);
      expect(first.turn.sessionId).not.toBe(second.turn.sessionId);
      expect(server.requests).toHaveLength(2);
      for (const request of server.requests) {
        expect(request.stream).toBe(false);
        expect(request).not.toHaveProperty('stream_options');
      }
      expect(JSON.stringify(server.requests[1]!.input)).toContain(
        'second fallback marker',
      );
      expect(JSON.stringify(server.requests[1]!.input)).not.toContain(
        'first fallback marker',
      );
      expect(JSON.stringify(server.requests[1]!.input)).not.toContain(
        'fallback answer one',
      );
      await provider.close();
      expect(observed.closed).toContain(a!.engine);
      server.assertExhausted();
    }, 30_000);

    it('resets buffered ownership for changed effort, model and captured environment key', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'synthetic-buffered-key-A');
      const models = ['gpt-5', 'gpt-5', 'gpt-5.1', 'gpt-5.1'];
      const server = new ModelServer(
        models.map((model, index) => {
          const reply = jsonResponse(`reset-${index}`, [`answer ${index}`]);
          reply.body = reply.body.replace(
            '"model":"gpt-5"',
            `"model":"${model}"`,
          );
          return reply;
        }),
      );
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        responseMode: 'buffered',
        supportsWebsockets: false,
        requestMaxRetries: 0,
        streamMaxRetries: 0,
      });
      const observed = await observeOwners();
      const outputs: string[] = [];
      for (let index = 0; index < models.length; index++) {
        if (index === 3)
          vi.stubEnv('OPENAI_API_KEY', 'synthetic-buffered-key-B');
        const result = await new Agent({
          instructions: 'Answer.',
          model: models[index]!,
          provider,
          modelSettings: { reasoningEffort: index === 0 ? 'low' : 'high' },
        }).run(`reset marker ${index}`);
        outputs.push(result.finalOutput);
      }
      expect(outputs).toEqual(['answer 0', 'answer 1', 'answer 2', 'answer 3']);
      expect(observed.owners).toHaveLength(4);
      for (let index = 1; index < observed.owners.length; index++) {
        expect(observed.owners[index]!.engine).not.toBe(
          observed.owners[index - 1]!.engine,
        );
      }
      expect(server.requests).toHaveLength(4);
      expect(server.requests.map((request) => request.model)).toEqual(models);
      expect(server.requests.map((request) => request.reasoning)).toMatchObject(
        [
          { effort: 'low' },
          { effort: 'high' },
          { effort: 'high' },
          { effort: 'high' },
        ],
      );
      expect(
        server.requestHeaders.map((headers) => headers.authorization),
      ).toEqual([
        'Bearer synthetic-buffered-key-A',
        'Bearer synthetic-buffered-key-A',
        'Bearer synthetic-buffered-key-A',
        'Bearer synthetic-buffered-key-B',
      ]);
      for (const [index, request] of server.requests.entries()) {
        expect(request.stream).toBe(false);
        expect(request).not.toHaveProperty('stream_options');
        const input = JSON.stringify(request.input);
        expect(input).toContain(`reset marker ${index}`);
        for (let previous = 0; previous < index; previous++) {
          expect(input).not.toContain(`reset marker ${previous}`);
          expect(input).not.toContain(`answer ${previous}`);
        }
      }
      await provider.close();
      for (const owner of observed.owners)
        expect(observed.closed).toContain(owner.engine);
      server.assertExhausted();
    }, 30_000);

    it('keeps overlapping buffered owners independent and rejects close until both settle', async () => {
      const entered = [
        Promise.withResolvers<void>(),
        Promise.withResolvers<void>(),
      ];
      const release = [
        Promise.withResolvers<void>(),
        Promise.withResolvers<void>(),
      ];
      let nextBody = 0;
      const server = new ModelServer(
        [
          jsonResponse('concurrent-first', ['concurrent answer one']),
          jsonResponse('concurrent-second', ['concurrent answer two']),
        ],
        [],
        undefined,
        undefined,
        async () => {
          const index = nextBody++;
          entered[index]!.resolve();
          await release[index]!.promise;
        },
      );
      await using provider = await bufferedProvider(server);
      const observed = await observeOwners();
      const agent = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      });
      const first = agent.run('concurrent first');
      void first.catch(() => undefined);
      let second: ReturnType<typeof agent.run> | undefined;
      try {
        await entered[0]!.promise;
        second = agent.run('concurrent second');
        void second.catch(() => undefined);
        await entered[1]!.promise;
        await expect(provider.close()).rejects.toThrow(
          'open or opening sessions',
        );
      } finally {
        for (const body of release) body.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
      expect(second).toBeDefined();
      const results = await Promise.all([first, second!]);
      expect(results.map((result) => result.finalOutput)).toEqual([
        'concurrent answer one',
        'concurrent answer two',
      ]);
      expect(observed.owners).toHaveLength(2);
      expect(observed.owners.every((owner) => owner.run !== undefined)).toBe(
        true,
      );
      expect(observed.owners[0]!.engine).not.toBe(observed.owners[1]!.engine);
      expect(results[0]!.turn.sessionId).not.toBe(results[1]!.turn.sessionId);
      expect(server.requests).toHaveLength(2);
      expect(server.requests.map((request) => request.stream)).toEqual([
        false,
        false,
      ]);
      await provider.close();
      for (const owner of observed.owners)
        expect(observed.closed).toContain(owner.engine);
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
