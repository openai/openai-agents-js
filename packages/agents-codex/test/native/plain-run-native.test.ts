import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, NativeError, NativeProvider } from '../../src';
import { binding } from '../../src/runtime/binding';
import { ModelServer, message } from './fixtures/model-server';

function response(index: number, chunks = ['answer ', String(index)]) {
  const responseId = `plain-response-${index}`;
  const item = {
    ...message(chunks.join('')),
    id: `plain-message-${index}`,
  };
  const events = [
    { type: 'response.created', response: { id: responseId } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, content: [] },
    },
    ...chunks.map((delta) => ({
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta,
    })),
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        usage: {
          input_tokens: 20,
          input_tokens_details: { cached_tokens: 5 },
          output_tokens: 10,
          output_tokens_details: { reasoning_tokens: 3 },
          total_tokens: 30,
        },
      },
    },
  ];
  return {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'x-request-id': `plain-upstream-${index}`,
      'x-ratelimit-remaining-requests': '7',
    },
    body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  };
}

async function providerFor(server: ModelServer, streamMaxRetries = 0) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-plain-run',
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
  'plain Agent.run',
  () => {
    it('preserves the public result and ordered observations without opening a native thread', async () => {
      const server = new ModelServer([response(1), response(2)]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        instructions: 'Follow the application instructions.',
        model: 'gpt-5',
        modelSettings: { reasoningEffort: 'low' },
        provider,
      });
      const native = await binding();
      const run = vi.spyOn(native.Engine.prototype, '_plain_run');
      const open = vi.spyOn(
        native.Engine.prototype,
        'start_replaceable_thread',
      );
      const first = await agent.run('first input');
      agent.instructions = 'Updated application instructions.';
      const second = await agent.run('second input');

      expect([first.finalOutput, second.finalOutput]).toEqual([
        'answer 1',
        'answer 2',
      ]);
      expect(run).toHaveBeenCalledTimes(2);
      expect(open).not.toHaveBeenCalled();
      expect(first.turn.sessionId).not.toBe(second.turn.sessionId);
      expect(first.turn.turnId).not.toBe(second.turn.turnId);
      expect(first.turn.submissionId).not.toBe(second.turn.submissionId);
      expect(await first.turn.wait()).toBe(first);
      const aborted = AbortSignal.abort(new Error('only this late waiter'));
      expect(
        await first.turn.wait({ until: 'interaction', signal: aborted }),
      ).toBe(first);
      await expect(first.turn.cancel()).resolves.toBeUndefined();
      await expect(first.turn.steer('late input')).rejects.toBeInstanceOf(
        NativeError,
      );
      expect(first.repairAttempts).toEqual([]);
      expect(first.threadUsage?.totalTokenUsage).toEqual({
        inputTokens: 20,
        cachedInputTokens: 5,
        cacheWriteInputTokens: 0,
        outputTokens: 10,
        reasoningOutputTokens: 3,
        totalTokens: 30,
      });
      expect(first.threadUsage?.lastTokenUsage).toEqual(
        first.threadUsage?.totalTokenUsage,
      );

      const events = await Array.fromAsync(first.turn.events());
      expect(await Array.fromAsync(first.turn.events())).toEqual(events);
      const dispatch = events.find(
        (event) => event.type === 'model_request_dispatching',
      );
      expect(dispatch).toMatchObject({
        sessionId: first.turn.sessionId,
        turnId: first.turn.turnId,
        submissionId: first.turn.submissionId,
        model: 'gpt-5',
        reasoningEffort: 'low',
        wire: 'responses',
        transport: 'http_sse',
      });
      expect(
        events
          .filter((event) => event.type === 'output_text_delta')
          .map((event) => event.delta),
      ).toEqual(['answer ', '1']);
      expect(
        events
          .filter((event) => event.type === 'output_text_delta')
          .every((event) => event.itemId === 'plain-message-1'),
      ).toBe(true);
      expect(
        events.find((event) => event.type === 'api_rate_limits_updated'),
      ).toMatchObject({
        snapshot: { requests: { remaining: 7 } },
      });
      const types = events.map((event) => event.type);
      expect(types.indexOf('model_request_dispatching')).toBeLessThan(
        types.indexOf('output_text_delta'),
      );
      expect(types.indexOf('usage_updated')).toBeLessThan(
        types.indexOf('turn_finished'),
      );
      expect(
        events.find((event) => event.type === 'turn_finished'),
      ).toMatchObject({ status: 'completed' });
      expect(events.every(Object.isFrozen)).toBe(true);

      const firstRequest = JSON.stringify(server.requests[0]);
      const secondRequest = JSON.stringify(server.requests[1]);
      expect(firstRequest).toContain('Follow the application instructions.');
      expect(secondRequest).toContain('Updated application instructions.');
      expect(secondRequest).toContain('second input');
      expect(secondRequest).not.toContain('first input');
      expect(secondRequest).not.toContain('answer 1');
      expect(
        server.requests.every(
          (request) =>
            Array.isArray(request.tools) && request.tools.length === 0,
        ),
      ).toBe(true);
      expect(
        server.requestHeaders.map((headers) => headers.authorization),
      ).toEqual(['Bearer synthetic-plain-run', 'Bearer synthetic-plain-run']);
      server.assertExhausted();
    }, 30_000);

    it.each(['all', 'bounded'] as const)(
      'applies %s observation retention for independent late readers',
      async (retention) => {
        const chunks = Array.from({ length: 350 }, (_, index) => `${index},`);
        const server = new ModelServer([response(1, chunks)]);
        await using provider = await providerFor(server);
        const completed = await new Agent({
          instructions: 'Answer.',
          model: 'gpt-5',
          provider,
        }).run('start', { observationRetention: retention });
        const first = await Array.fromAsync(completed.turn.events());
        const second = await Array.fromAsync(completed.turn.events());
        expect(first).toEqual(second);
        const deltas = first
          .filter((event) => event.type === 'output_text_delta')
          .map((event) => event.delta);
        if (retention === 'all') {
          expect(first.some((event) => event.type === 'gap')).toBe(false);
          expect(deltas).toEqual(chunks);
        } else {
          expect(first[0]?.type).toBe('gap');
          expect(first.length).toBeLessThanOrEqual(257);
          expect(deltas.length).toBeGreaterThan(0);
          expect(deltas).toEqual(chunks.slice(-deltas.length));
        }
        expect(completed.finalOutput).toBe(chunks.join(''));
        server.assertExhausted();
      },
      30_000,
    );

    it('preserves exact token counts beyond JavaScript safe integers', async () => {
      const reply = response(1);
      reply.body = reply.body
        .replace('"input_tokens":20', '"input_tokens":9007199254740993')
        .replace('"total_tokens":30', '"total_tokens":9007199254741003');
      const server = new ModelServer([reply]);
      await using provider = await providerFor(server);
      const completed = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      }).run('start');
      expect(completed.threadUsage?.totalTokenUsage.inputTokens).toBe(
        9_007_199_254_740_993n,
      );
      expect(completed.threadUsage?.totalTokenUsage.totalTokens).toBe(
        9_007_199_254_741_003n,
      );
      expect(completed.threadUsage?.lastTokenUsage).toEqual(
        completed.threadUsage?.totalTokenUsage,
      );
      server.assertExhausted();
    }, 30_000);

    it('preserves HTTP error metadata after native authentication recovery', async () => {
      const rejection = {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'plain-rejected-request',
        },
        body: JSON.stringify({
          error: {
            message: 'Synthetic rejection',
            code: 'invalid_api_key',
            type: 'invalid_request_error',
          },
        }),
      };
      const server = new ModelServer([rejection, rejection]);
      await using provider = await providerFor(server);
      const native = await binding();
      const run = vi.spyOn(native.Engine.prototype, '_plain_run');
      const open = vi.spyOn(
        native.Engine.prototype,
        'start_replaceable_thread',
      );
      const failure: unknown = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      })
        .run('start')
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(NativeError);
      expect(failure).toMatchObject({
        statusCode: 401,
        code: 'invalid_api_key',
        requestId: 'plain-rejected-request',
      });
      expect(failure).not.toHaveProperty('body');
      expect(failure).not.toHaveProperty('headers');
      expect(run).toHaveBeenCalledTimes(1);
      expect(open).not.toHaveBeenCalled();
      expect(server.requests).toHaveLength(2);
      server.assertExhausted();
    }, 30_000);

    it('preserves response-integrity failures without a second model request', async () => {
      const server = new ModelServer([[]]);
      await using provider = await providerFor(server, 1);
      const failure: unknown = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      })
        .run('start')
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(NativeError);
      expect(failure).toMatchObject({
        responseIntegrityReason: 'missing_supported_terminal_output',
      });
      server.assertExhausted();
    }, 30_000);

    it('reuses native guidance when retrying a content-filter response', async () => {
      const terminal = JSON.stringify({
        type: 'response.incomplete',
        response: {
          id: 'response-1',
          incomplete_details: { reason: 'content_filter' },
          usage: { input_tokens: 7, output_tokens: 0, total_tokens: 7 },
        },
      });
      const server = new ModelServer([[], response(2)], [], undefined, [
        terminal,
      ]);
      await using provider = await providerFor(server, 1);
      const completed = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      }).run('start');
      expect(completed.finalOutput).toBe('answer 2');
      expect(server.requests).toHaveLength(2);
      const originalInput = server.requests[0]!.input as unknown[];
      const recoveredInput = server.requests[1]!.input as unknown[];
      expect(recoveredInput.slice(0, originalInput.length)).toEqual(
        originalInput,
      );
      expect(recoveredInput).toHaveLength(originalInput.length + 1);
      expect(recoveredInput.at(-1)).toMatchObject({ role: 'developer' });
      expect(JSON.stringify(recoveredInput.at(-1))).toContain(
        '<content_filter_guidance>',
      );
      server.assertExhausted();
    }, 30_000);

    it('reports a provider refusal without exposing its private text', async () => {
      const refusal = 'synthetic-private-refusal';
      const events = [
        {
          type: 'response.created',
          response: { id: 'plain-refused-response' },
        },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'message',
            id: 'plain-refusal',
            role: 'assistant',
            content: [],
          },
        },
        {
          type: 'response.refusal.delta',
          item_id: 'plain-refusal',
          content_index: 0,
          delta: refusal,
        },
        {
          type: 'response.refusal.done',
          item_id: 'plain-refusal',
          content_index: 0,
          refusal,
        },
      ];
      const server = new ModelServer([
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: events
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
        },
      ]);
      await using provider = await providerFor(server, 1);
      const failure: unknown = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      })
        .run('start')
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(NativeError);
      expect(failure).toMatchObject({
        responseIntegrityReason: 'provider_refusal',
      });
      expect(String(failure)).not.toContain(refusal);
      server.assertExhausted();
    }, 30_000);

    it('joins cancellation and keeps the Provider usable for a later run', async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const server = new ModelServer(
        [response(1), response(2)],
        [],
        undefined,
        undefined,
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      await using provider = await providerFor(server);
      const agent = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      });
      const controller = new AbortController();
      const reason = new Error('caller cancellation');
      const running = agent.run('cancel me', { signal: controller.signal });
      void running.catch(() => undefined);
      try {
        await entered.promise;
        controller.abort(reason);
        await expect(running).rejects.toBe(reason);
      } finally {
        release.resolve();
      }
      expect((await agent.run('after cancellation')).finalOutput).toBe(
        'answer 2',
      );
      server.assertExhausted();
    }, 30_000);

    it('preserves the prompt when reusing the owner after native preflight declines', async () => {
      const server = new ModelServer([response(1), response(2)]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        modelSettings: { reasoningEffort: 'low' },
        provider,
      });
      const preflight = vi
        .spyOn((await binding()).Engine.prototype, '_plain_run_supported')
        .mockResolvedValue(false);
      expect((await agent.run('same input')).finalOutput).toBe('answer 1');
      preflight.mockRestore();
      expect((await agent.run('same input')).finalOutput).toBe('answer 2');
      const prompt = (request: (typeof server.requests)[number]) =>
        JSON.stringify(
          {
            model: request.model,
            reasoning: request.reasoning,
            instructions: request.instructions,
            input: request.input,
            tools: request.tools,
            tool_choice: request.tool_choice,
          },
          // Per-run message identities; all roles, content and context retained.
          (key, value) => (key === 'id' ? undefined : value),
        ).replace(
          /msg_sdk_application_[A-Za-z0-9_-]+/g,
          'APPLICATION_REVISION',
        );
      expect(JSON.parse(prompt(server.requests[1]!))).toEqual(
        JSON.parse(prompt(server.requests[0]!)),
      );
      server.assertExhausted();
    }, 30_000);

    it.each([
      [undefined, false],
      [0, false],
      [1, false],
      [1, true],
    ] as const)(
      'preserves dropped-stream recovery with retry budget %s and completed item %s',
      async (streamMaxRetries, completedItem) => {
        const dropped = {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: [
            {
              type: 'response.created',
              response: { id: 'dropped-response' },
            },
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: {
                type: 'message',
                id: 'dropped-message',
                role: 'assistant',
                content: [],
              },
            },
            {
              type: 'response.output_text.delta',
              item_id: 'dropped-message',
              output_index: 0,
              content_index: 0,
              delta: 'partial output',
            },
            ...(completedItem
              ? [
                  {
                    type: 'response.output_item.done',
                    output_index: 0,
                    item: {
                      ...message('partial output'),
                      id: 'dropped-message',
                    },
                  },
                ]
              : []),
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
        };
        const server = new ModelServer([
          dropped,
          ...(streamMaxRetries === 0 ? [] : [response(2)]),
        ]);
        const config = await server.config();
        await using provider = new NativeProvider({
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'synthetic-plain-retry',
          supportsWebsockets: false,
          requestMaxRetries: 0,
          streamMaxRetries,
        });
        const agent = new Agent({
          instructions: 'Answer.',
          model: 'gpt-5',
          provider,
        });
        const running = agent.run('recover the response');
        if (streamMaxRetries === 0) {
          await expect(running).rejects.toBeInstanceOf(NativeError);
        } else {
          const completed = await running;
          expect(completed.finalOutput).toBe('answer 2');
          const originalInput = server.requests[0]!.input as unknown[];
          const recoveredInput = server.requests[1]!.input as unknown[];
          expect(recoveredInput.slice(0, originalInput.length)).toEqual(
            originalInput,
          );
          expect(recoveredInput).toHaveLength(
            originalInput.length + (completedItem ? 1 : 0),
          );
          if (completedItem) {
            expect(recoveredInput.at(-1)).toMatchObject({ role: 'assistant' });
            expect(JSON.stringify(recoveredInput.at(-1))).toContain(
              'partial output',
            );
          }
          const observations = await Array.fromAsync(completed.turn.events());
          expect(
            observations
              .filter((event) => event.type === 'output_text_delta')
              .map((event) => event.delta),
          ).toEqual(['partial output', 'answer ', '2']);
          const dispatched = observations.filter(
            (event) => event.type === 'model_request_dispatching',
          );
          expect(dispatched).toHaveLength(2);
          expect(new Set(dispatched.map((event) => event.requestId)).size).toBe(
            2,
          );
        }
        expect(server.requests).toHaveLength(streamMaxRetries === 0 ? 1 : 2);
        server.assertExhausted();
      },
      30_000,
    );

    it('matches ordinary model defaults after a different Agent uses the Provider', async () => {
      const server = new ModelServer([response(1), response(2), response(3)]);
      await using provider = await providerFor(server);
      await new Agent({
        instructions: 'First agent.',
        model: 'gpt-5',
        provider,
      }).run('first');
      const agent = new Agent({ instructions: 'Default model.', provider });
      expect((await agent.run('default model')).finalOutput).toBe('answer 2');
      vi.spyOn(
        (await binding()).Engine.prototype,
        '_plain_run_supported',
      ).mockResolvedValue(false);
      expect((await agent.run('ordinary default model')).finalOutput).toBe(
        'answer 3',
      );
      expect(server.requests[1]?.model).toBe(server.requests[2]?.model);
      server.assertExhausted();
    }, 30_000);

    it('uses ordinary Sessions for callbacks, invocation deadlines and explicit Sessions', async () => {
      const server = new ModelServer([response(1), response(2), response(3)]);
      await using provider = await providerFor(server);
      const beforeComplete = vi.fn();
      const agent = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
        beforeComplete,
      });
      const run = vi.spyOn((await binding()).Engine.prototype, '_plain_run');
      expect((await agent.run('callback')).finalOutput).toBe('answer 1');
      expect(beforeComplete).toHaveBeenCalledTimes(1);
      agent.beforeComplete = undefined;
      expect(
        (
          await agent.run('deadline', {
            modelSettings: { invocationTimeoutMs: 10_000 },
          })
        ).finalOutput,
      ).toBe('answer 2');
      await using session = await agent.session();
      expect(
        (await (await session.submit('explicit session')).wait()).finalOutput,
      ).toBe('answer 3');
      expect(run).not.toHaveBeenCalled();
      server.assertExhausted();
    }, 30_000);
  },
);
