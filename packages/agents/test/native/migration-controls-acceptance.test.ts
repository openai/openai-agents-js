import { setImmediate } from 'node:timers/promises';
import { createServer } from 'node:http';
import OpenAI from 'openai';
import { OpenAIProvider } from '@openai/agents-openai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  MemorySession,
  Runner,
  tool,
  Usage,
  ModelTimeoutError,
  setTracingDisabled,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ModelSettings,
} from '@openai/agents/classic';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelError,
  modelResponse,
} from '@openai/agents/classic/testing';
import { reportModelFailureUsage } from '@openai/agents-core/utils/internal';
import { SDKRunner, MigrationCleanupError } from '@openai/agents/migration';

setTracingDisabled(true);

const response = (): ModelResponse => ({
  responseId: 'selected-response',
  requestId: 'selected-request',
  output: [assistantMessage('Selected model completed.')],
  usage: new Usage({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
});

describe('migration selected-model acceptance and settings policy', () => {
  it.each([
    ['response', 'agent name'],
    ['stream', 'agent name'],
    ['response', 'run name'],
    ['stream', 'run name'],
    ['response', 'agent Model'],
    ['stream', 'agent Model'],
    ['response', 'run Model'],
    ['stream', 'run Model'],
  ] as const)(
    'delivers classic precedence and supported settings to the selected %s provider for %s',
    async (modelInvocation, selection) => {
      const observedSettings: ModelSettings[] = [];
      for (const runtime of ['classic', 'migration'] as const) {
        const selected = new ScriptedModel([modelResponse(response())]);
        const unselected = new ScriptedModel([]);
        const names: Array<string | undefined> = [];
        const modelProvider = {
          getModel(name?: string) {
            names.push(name);
            return selected;
          },
        };
        const agent = new Agent({
          name: 'Acceptance',
          instructions: 'Return text.',
          ...(selection === 'agent name'
            ? { model: 'agent-selected' }
            : selection === 'agent Model'
              ? { model: selected }
              : {}),
          modelSettings: {
            temperature: 0.2,
            frequencyPenalty: 0.1,
            presencePenalty: 0.3,
            store: false,
          },
        });
        const config = {
          model:
            selection === 'agent Model'
              ? unselected
              : selection === 'run Model'
                ? selected
                : 'run-selected',
          modelProvider,
          modelSettings: {
            temperature: 0.8,
            topP: 0.9,
            maxTokens: 128,
            toolChoice: 'auto' as const,
          },
        };
        if (runtime === 'migration') {
          const result = await SDKRunner.run(agent, 'Hello.', {
            ...config,
            context: undefined,
            modelInvocation,
          });
          expect(result.finalOutput).toBe('Selected model completed.');
          expect(result.modelResponses).toHaveLength(1);
          expect(result.modelResponses[0]).toMatchObject({
            responseId: 'selected-response',
            requestId: 'selected-request',
            usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          });
          expect(result.native.sessionId).toEqual(expect.any(String));
          expect(result.native.turnId).toEqual(expect.any(String));
        } else {
          const runner = new Runner({ ...config, tracingDisabled: true });
          if (modelInvocation === 'stream') {
            const result = await runner.run(agent, 'Hello.', { stream: true });
            for await (const _event of result) {
              // Drain the public stream before observing its completed result.
            }
            await result.completed;
            expect(result.finalOutput).toBe('Selected model completed.');
          } else {
            expect((await runner.run(agent, 'Hello.')).finalOutput).toBe(
              'Selected model completed.',
            );
          }
        }
        expect(names).toEqual(
          selection === 'agent Model' || selection === 'run Model'
            ? []
            : [selection === 'agent name' ? 'agent-selected' : 'run-selected'],
        );
        expect(unselected.calls).toHaveLength(0);
        expect(selected.calls).toHaveLength(1);
        expect(selected.calls[0].streamed).toBe(modelInvocation === 'stream');
        expect(selected.calls[0].request).toMatchObject({
          outputType: 'text',
          tools: [],
        });
        expect(JSON.stringify(selected.calls[0].request.input)).toContain(
          'Hello.',
        );
        observedSettings.push(selected.calls[0].request.modelSettings);
        selected.assertComplete();
      }
      const expected = {
        temperature: 0.2,
        topP: 0.9,
        frequencyPenalty: 0.1,
        presencePenalty: 0.3,
        maxTokens: 128,
        store: false,
        toolChoice: 'auto',
      };
      expect(observedSettings).toEqual([expected, expected]);
    },
    30_000,
  );

  it.each(['response', 'stream'] as const)(
    'preserves the selected %s Model failure without another provider request',
    async (modelInvocation) => {
      const failure = new Error('Selected Model failed.');
      const selected = new ScriptedModel([modelError(failure)]);
      const names: Array<string | undefined> = [];
      const agent = new Agent({
        name: 'Failure',
        instructions: 'Return text.',
        model: 'selected',
        modelSettings: {},
      });
      await expect(
        SDKRunner.run(agent, 'Hello.', {
          context: undefined,
          modelInvocation,
          modelProvider: {
            getModel(name?: string) {
              names.push(name);
              return selected;
            },
          },
        }),
      ).rejects.toBe(failure);
      expect(names).toEqual(['selected']);
      expect(selected.calls).toHaveLength(1);
      expect(selected.calls[0].streamed).toBe(modelInvocation === 'stream');
      selected.assertComplete();
    },
    30_000,
  );

  it.each(['response', 'stream'] as const)(
    'joins an abort-ignoring %s producer before caller cancellation settles',
    async (modelInvocation) => {
      const entered = Promise.withResolvers<ModelRequest>();
      const producerRelease = Promise.withResolvers<void>();
      const returnEntered = Promise.withResolvers<void>();
      const returnRelease = Promise.withResolvers<void>();
      let calls = 0;
      let returned = false;
      // ScriptedModel checks abort itself; this double deliberately retains work.
      const model: Model = {
        async getResponse(request) {
          calls++;
          entered.resolve(request);
          await producerRelease.promise;
          return response();
        },
        getStreamedResponse(request) {
          calls++;
          entered.resolve(request);
          return {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  await producerRelease.promise;
                  return { done: true as const, value: undefined };
                },
                async return() {
                  returnEntered.resolve();
                  await returnRelease.promise;
                  returned = true;
                  return { done: true as const, value: undefined };
                },
              };
            },
          };
        },
      };
      const agent = new Agent({
        name: 'Cancellation',
        instructions: 'Return text.',
        model,
        modelSettings: {},
      });
      const controller = new AbortController();
      const reason = new Error('Caller cancelled.');
      let settled = false;
      const result = SDKRunner.run(agent, 'Hello.', {
        context: undefined,
        modelInvocation,
        signal: controller.signal,
      }).finally(() => {
        settled = true;
      });
      void result.catch(() => {});
      try {
        const request = await entered.promise;
        const aborted = Promise.withResolvers<void>();
        request.signal!.addEventListener('abort', () => aborted.resolve(), {
          once: true,
        });
        controller.abort(reason);
        await aborted.promise;
        await setImmediate();
        expect(settled).toBe(false);
        producerRelease.resolve();
        if (modelInvocation === 'stream') {
          await returnEntered.promise;
          await setImmediate();
          expect(settled).toBe(false);
          returnRelease.resolve();
        }
        await expect(result).rejects.toBe(reason);
        expect(calls).toBe(1);
        expect(request.signal!.aborted).toBe(true);
        expect(returned).toBe(modelInvocation === 'stream');
      } finally {
        controller.abort(reason);
        producerRelease.resolve();
        returnRelease.resolve();
        await result.catch(() => {});
      }
    },
    30_000,
  );

  it.each(['response', 'stream'] as const)(
    'retries a safe %s Model attempt without another native root or provider resolution',
    async (modelInvocation) => {
      const failure = new Error('Transient selected failure');
      const selected = new ScriptedModel([
        modelError(failure, { replaySafety: 'safe' }),
        modelResponse(response()),
      ]);
      let resolutions = 0;
      const result = await SDKRunner.run(
        new Agent({
          name: 'Retry',
          instructions: 'Answer.',
          model: 'selected',
          modelSettings: {},
        }),
        'Hello.',
        {
          context: undefined,
          modelInvocation,
          modelProvider: {
            getModel() {
              resolutions++;
              return selected;
            },
          },
          modelSettings: {
            retry: {
              maxRetries: 1,
              policy: () => ({ retry: true, delayMs: 0 }),
            },
          },
        },
      );
      expect(result.finalOutput).toBe('Selected model completed.');
      expect(resolutions).toBe(1);
      expect(selected.calls).toHaveLength(2);
      expect(selected.calls[0]!.request).not.toHaveProperty(
        '_internal.runnerManagedRetry',
      );
      expect(selected.calls[1]!.request).toHaveProperty(
        '_internal.runnerManagedRetry',
        true,
      );
      expect(result.runContext.usage.requests).toBe(2);
    },
  );

  it('retries before the captured approval and persists only the approved completion', async () => {
    const session = new MemorySession();
    const append = vi.spyOn(session, 'addItems');
    const execute = vi.fn(() => 'approved result');
    const selected = new ScriptedModel([
      modelError(new Error('Retry this attempt'), { replaySafety: 'safe' }),
      modelResponse([
        functionCall('lookup', {}, { callId: 'retry-approval-call' }),
      ]),
      modelResponse([assistantMessage('Approved completion.')]),
    ]);
    const getModel = vi.fn(() => selected);
    const controller = new AbortController();
    const held = await SDKRunner.run(
      new Agent({
        name: 'Retry then approve',
        instructions: 'Use lookup and answer.',
        model: 'selected',
        modelSettings: {},
        tools: [
          tool({
            name: 'lookup',
            description: 'Read a record.',
            parameters: z.strictObject({}),
            needsApproval: true,
            execute,
          }),
        ],
      }),
      'Hello.',
      {
        context: undefined,
        approvals: 'manual',
        session,
        signal: controller.signal,
        modelProvider: { getModel },
        modelSettings: {
          timeoutMs: 30_000,
          retry: { maxRetries: 1, policy: () => ({ retry: true, delayMs: 0 }) },
        },
      },
    );
    try {
      if (!('status' in held) || held.status !== 'paused')
        throw new Error('Expected the retried Model call to await approval');
      expect(held.interruptions[0]?.rawItem).toMatchObject({
        type: 'function_call',
        callId: 'retry-approval-call',
      });
      expect(selected.calls).toHaveLength(2);
      expect(execute).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
      held.approve(held.interruptions[0]!);
      const result = await held.continue();
      expect(result.finalOutput).toBe('Approved completion.');
      expect(result.native.sessionId).toBe(held.native.sessionId);
      expect(getModel).toHaveBeenCalledTimes(1);
      expect(selected.calls).toHaveLength(3);
      expect(selected.calls[1]!.request).toHaveProperty(
        '_internal.runnerManagedRetry',
        true,
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect(append).toHaveBeenCalledTimes(1);
      expect(await session.getItems()).toEqual(result.toInputList());
      selected.assertComplete();
    } finally {
      controller.abort();
      if ('completed' in held) await held.completed.catch(() => {});
      append.mockRestore();
    }
  });

  it('captures retry callbacks and backoff for the selected Agent tool Model', async () => {
    const child = new ScriptedModel([
      modelError(new Error('Retry the child'), { replaySafety: 'safe' }),
      modelResponse([assistantMessage('Child completed.')]),
    ]);
    const parent = new ScriptedModel([
      modelResponse([
        functionCall(
          'ask_child',
          { input: 'Answer.' },
          { callId: 'retry-child' },
        ),
      ]),
      modelResponse([assistantMessage('Parent completed.')]),
    ]);
    const getModel = vi.fn((name?: string) => {
      if (name === 'parent') return parent;
      if (name === 'child') return child;
      throw new Error(`Unexpected selected Model ${name}`);
    });
    const childAgent = new Agent({
      name: 'Retry child',
      instructions: 'Answer.',
      model: 'child',
      modelSettings: {},
    });
    const policy = vi.fn(() => ({ retry: true, delayMs: 0 }));
    const modelSettings = {
      timeoutMs: 30_000,
      retry: { maxRetries: 1, policy, backoff: { initialDelayMs: 0 } },
    };
    const pending = SDKRunner.run(
      new Agent({
        name: 'Retry parent',
        instructions: 'Ask the child.',
        model: 'parent',
        modelSettings: {},
        tools: [
          childAgent.asTool({
            toolName: 'ask_child',
            toolDescription: 'Ask the child.',
          }),
        ],
      }),
      'Hello.',
      { context: undefined, modelProvider: { getModel }, modelSettings },
    );
    modelSettings.retry.backoff.initialDelayMs = 999;
    const result = await pending;
    expect(result.finalOutput).toBe('Parent completed.');
    expect(getModel.mock.calls.map(([name]) => name)).toEqual([
      'parent',
      'child',
    ]);
    expect(policy).toHaveBeenCalledTimes(1);
    expect(child.calls).toHaveLength(2);
    expect(child.calls[0]!.request.modelSettings.retry?.policy).toBe(policy);
    expect(
      child.calls[0]!.request.modelSettings.retry?.backoff?.initialDelayMs,
    ).toBe(0);
    expect(child.calls[1]!.request).toHaveProperty(
      '_internal.runnerManagedRetry',
      true,
    );
    parent.assertComplete();
    child.assertComplete();
  });

  it('joins an abort-ignoring response before reporting its cooperative timeout', async () => {
    const entered = Promise.withResolvers<ModelRequest>();
    const release = Promise.withResolvers<void>();
    const selected: Model = {
      async getResponse(request) {
        entered.resolve(request);
        await release.promise;
        return response();
      },
      getStreamedResponse() {
        throw new Error('Unexpected stream');
      },
    };
    let settled = false;
    const result = SDKRunner.run(
      new Agent({
        name: 'Timeout',
        instructions: 'Answer.',
        model: selected,
        modelSettings: {},
      }),
      'Hello.',
      {
        context: undefined,
        modelSettings: { timeoutMs: 10 },
      },
    ).finally(() => {
      settled = true;
    });
    void result.catch(() => {});
    try {
      const request = await Promise.race([
        entered.promise,
        result.then(() => {
          throw new Error('Not entered');
        }),
      ]);
      await new Promise<void>((resolve) =>
        request.signal!.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      );
      expect(settled).toBe(false);
      release.resolve();
      await expect(result).rejects.toBeInstanceOf(ModelTimeoutError);
    } finally {
      release.resolve();
      await result.catch(() => {});
    }
  });

  it.each([
    'advice after abort',
    'policy',
    'failing advice after abort',
    'failing policy',
  ] as const)(
    'joins entered %s before settling caller cancellation',
    async (stage) => {
      const modelEntered = Promise.withResolvers<void>();
      const modelRelease = Promise.withResolvers<ModelResponse>();
      const callbackEntered = Promise.withResolvers<void>();
      const callbackRelease = Promise.withResolvers<void>();
      const late = new Error('Independent retry callback failure');
      const callback = async () => {
        callbackEntered.resolve();
        await callbackRelease.promise;
        if (stage.startsWith('failing')) throw late;
      };
      const advice = stage.includes('advice');
      const selected: Model = {
        async getResponse() {
          modelEntered.resolve();
          return modelRelease.promise;
        },
        getStreamedResponse() {
          throw new Error('Unexpected stream');
        },
        async getRetryAdvice() {
          if (advice) await callback();
          return { replaySafety: 'safe' };
        },
      };
      const controller = new AbortController();
      const reason = new Error('Caller stopped retry callbacks');
      let settled = false;
      const result = SDKRunner.run(
        new Agent({
          name: 'Retry callbacks',
          instructions: 'Answer.',
          model: selected,
          modelSettings: {},
        }),
        'Hello.',
        {
          context: undefined,
          signal: controller.signal,
          modelSettings: {
            timeoutMs: 30_000,
            retry: {
              maxRetries: 1,
              policy: async () => {
                if (!advice) await callback();
                return true;
              },
            },
          },
        },
      ).finally(() => {
        settled = true;
      });
      void result.catch(() => {});
      try {
        await Promise.race([modelEntered.promise, result]);
        if (advice) controller.abort(reason);
        modelRelease.reject(new Error('Attempt failed'));
        await callbackEntered.promise;
        if (!advice) controller.abort(reason);
        await setImmediate();
        expect(settled).toBe(false);
        callbackRelease.resolve();
        if (stage.startsWith('failing')) {
          const failure = await result.catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(MigrationCleanupError);
          expect((failure as MigrationCleanupError).cause).toBe(reason);
          expect((failure as MigrationCleanupError).errors).toContain(late);
        } else await expect(result).rejects.toBe(reason);
      } finally {
        modelRelease.resolve(response());
        callbackRelease.resolve();
        await result.catch(() => {});
      }
    },
  );

  it('joins a failed stream close and vetoes retry before advice or policy', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const primary = new Error('Stream attempt failed');
    const cleanup = new Error('Iterator close failed');
    let calls = 0,
      advice = 0,
      policy = 0,
      closes = 0,
      settled = false;
    const selected: Model = {
      async getResponse() {
        throw new Error('Unexpected response');
      },
      getStreamedResponse() {
        calls++;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                throw primary;
              },
              async return() {
                closes++;
                entered.resolve();
                await release.promise;
                throw cleanup;
              },
            };
          },
        };
      },
      getRetryAdvice() {
        advice++;
        return { replaySafety: 'safe' };
      },
    };
    const result = SDKRunner.run(
      new Agent({
        name: 'Stream cleanup',
        instructions: 'Answer.',
        model: selected,
        modelSettings: {},
      }),
      'Hello.',
      {
        context: undefined,
        modelInvocation: 'stream',
        modelSettings: {
          retry: {
            maxRetries: 1,
            policy: () => {
              policy++;
              return true;
            },
          },
        },
      },
    ).finally(() => {
      settled = true;
    });
    void result.catch(() => {});
    try {
      await Promise.race([entered.promise, result]);
      await setImmediate();
      expect(settled).toBe(false);
      release.resolve();
      const failure = await result.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MigrationCleanupError);
      expect((failure as MigrationCleanupError).cause).toBe(primary);
      expect((failure as MigrationCleanupError).errors).toContain(cleanup);
      expect([calls, closes, advice, policy]).toEqual([1, 1, 0, 0]);
    } finally {
      release.resolve();
      await result.catch(() => {});
    }
  });

  it.each(['response', 'stream'] as const)(
    'preserves first-attempt HTTP provider retries and disables them on %s replay',
    async (modelInvocation) => {
      const retryCounts: Array<string | undefined> = [];
      const responseBody = {
        id: 'http-selected',
        object: 'response',
        status: 'completed',
        model: 'selected',
        output: [
          {
            id: 'http-message',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'HTTP selected.', annotations: [] },
            ],
          },
        ],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      };
      const server = createServer(async (request, reply) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        expect(body.model).toBe('selected');
        retryCounts.push(
          request.headers['x-stainless-retry-count'] as string | undefined,
        );
        if (retryCounts.length < 3) {
          reply
            .writeHead(500, {
              'content-type': 'application/json',
              'retry-after-ms': '1',
            })
            .end(
              JSON.stringify({ error: { message: 'Transient HTTP failure' } }),
            );
        } else if (body.stream) {
          reply.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const event of [
            {
              type: 'response.created',
              response: { ...responseBody, status: 'in_progress', output: [] },
            },
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: responseBody.output[0],
            },
            {
              type: 'response.output_item.done',
              output_index: 0,
              item: responseBody.output[0],
            },
            { type: 'response.completed', response: responseBody },
          ])
            reply.write(`data: ${JSON.stringify(event)}\n\n`);
          reply.end();
        } else
          reply
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(responseBody));
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing HTTP port');
      const provider = new OpenAIProvider({
        openAIClient: new OpenAI({
          apiKey: 'synthetic',
          baseURL: `http://127.0.0.1:${address.port}/v1`,
          maxRetries: 1,
        }),
        useResponses: true,
        useResponsesWebSocket: false,
      });
      let resolutions = 0;
      try {
        const result = await SDKRunner.run(
          new Agent({
            name: 'HTTP retry',
            instructions: 'Answer.',
            model: 'selected',
            modelSettings: {},
          }),
          'Hello.',
          {
            context: undefined,
            modelInvocation,
            modelProvider: {
              getModel(name) {
                resolutions++;
                return provider.getModel(name);
              },
            },
            modelSettings: {
              retry: {
                maxRetries: 1,
                policy: () => ({ retry: true, delayMs: 0 }),
              },
            },
          },
        );
        expect(result.finalOutput).toBe('HTTP selected.');
        expect(result.lastResponseId).toBe('http-selected');
        expect(retryCounts).toEqual(['0', '1', '0']);
        expect(resolutions).toBe(1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it('preserves the caller cause through an operational OpenAI HTTP abort', async () => {
    const entered = Promise.withResolvers<void>();
    const server = createServer(async (request) => {
      for await (const _chunk of request) {
        // Drain the body before signalling that the HTTP call is held.
      }
      entered.resolve();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing HTTP port');
    const provider = new OpenAIProvider({
      apiKey: 'synthetic',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      useResponses: true,
      useResponsesWebSocket: false,
    });
    const controller = new AbortController();
    const reason = { caller: 'original abort value' };
    const result = SDKRunner.run(
      new Agent({
        name: 'HTTP abort',
        instructions: 'Answer.',
        model: 'selected',
        modelSettings: {},
      }),
      'Hello.',
      {
        context: undefined,
        signal: controller.signal,
        modelProvider: provider,
        modelSettings: { timeoutMs: 30_000 },
      },
    );
    void result.catch(() => {});
    try {
      await Promise.race([entered.promise, result]);
      controller.abort(reason);
      await expect(result).rejects.toBe(reason);
    } finally {
      controller.abort(reason);
      await result.catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('accounts for reported failed-attempt usage once before publishing successful usage', async () => {
    let calls = 0;
    const selected: Model = {
      async getResponse(request) {
        if (++calls === 1) {
          const error = new Error('Known failed attempt');
          reportModelFailureUsage(
            request,
            error,
            new Usage({ requests: 1, inputTokens: 5, totalTokens: 5 }),
          );
          throw error;
        }
        return response();
      },
      getStreamedResponse() {
        throw new Error('Unexpected stream');
      },
    };
    const result = await SDKRunner.run(
      new Agent({
        name: 'Usage',
        instructions: 'Answer.',
        model: selected,
        modelSettings: {},
      }),
      'Hello.',
      {
        context: undefined,
        modelSettings: {
          retry: { maxRetries: 1, policy: () => ({ retry: true, delayMs: 0 }) },
        },
      },
    );
    expect(result.runContext.usage).toMatchObject({
      requests: 2,
      totalTokens: 8,
    });
    expect(result.modelResponses).toHaveLength(1);
    expect(result.modelResponses[0]!.usage.totalTokens).toBe(3);
  });

  it('joins timed-out stream next and explicit return before reporting failure', async () => {
    const entered = Promise.withResolvers<ModelRequest>();
    const releaseNext = Promise.withResolvers<void>();
    const returned = Promise.withResolvers<void>();
    const releaseReturn = Promise.withResolvers<void>();
    const selected: Model = {
      async getResponse() {
        throw new Error('Unexpected response');
      },
      getStreamedResponse(request) {
        entered.resolve(request);
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                await releaseNext.promise;
                return { done: true as const, value: undefined };
              },
              async return() {
                returned.resolve();
                await releaseReturn.promise;
                return { done: true as const, value: undefined };
              },
            };
          },
        };
      },
    };
    let settled = false;
    const result = SDKRunner.run(
      new Agent({
        name: 'Stream timeout',
        instructions: 'Answer.',
        model: selected,
        modelSettings: {},
      }),
      'Hello.',
      {
        context: undefined,
        modelInvocation: 'stream',
        modelSettings: { timeoutMs: 10 },
      },
    ).finally(() => {
      settled = true;
    });
    void result.catch(() => {});
    try {
      const request = await Promise.race([
        entered.promise,
        result.then(() => {
          throw new Error('Not entered');
        }),
      ]);
      await new Promise<void>((resolve) => {
        if (request.signal!.aborted) resolve();
        else
          request.signal!.addEventListener('abort', () => resolve(), {
            once: true,
          });
      });
      expect(settled).toBe(false);
      releaseNext.resolve();
      await returned.promise;
      expect(settled).toBe(false);
      releaseReturn.resolve();
      await expect(result).rejects.toBeInstanceOf(ModelTimeoutError);
    } finally {
      releaseNext.resolve();
      releaseReturn.resolve();
      await result.catch(() => {});
    }
  });

  it('never replays visible stream output even when the retry policy would approve', async () => {
    const failure = new Error('Failure after visible output');
    let calls = 0,
      policies = 0;
    const selected: Model = {
      async getResponse() {
        throw new Error('Unexpected response');
      },
      async *getStreamedResponse() {
        calls++;
        yield { type: 'output_text_delta', delta: 'visible' };
        throw failure;
      },
      getRetryAdvice() {
        return { replaySafety: 'safe' };
      },
    };
    await expect(
      SDKRunner.run(
        new Agent({
          name: 'Visible stream',
          instructions: 'Answer.',
          model: selected,
          modelSettings: {},
        }),
        'Hello.',
        {
          context: undefined,
          modelInvocation: 'stream',
          modelSettings: {
            retry: {
              maxRetries: 1,
              policy: () => {
                policies++;
                return true;
              },
            },
          },
        },
      ),
    ).rejects.toBe(failure);
    expect([calls, policies]).toEqual([1, 0]);
  });

  it.each(['response', 'stream'] as const)(
    'does not retry %s without an opt-in policy',
    async (modelInvocation) => {
      const failure = new Error('No policy');
      const selected = new ScriptedModel([
        modelError(failure),
        modelResponse(response()),
      ]);
      await expect(
        SDKRunner.run(
          new Agent({
            name: 'No policy',
            instructions: 'Answer.',
            model: selected,
            modelSettings: {},
          }),
          'Hello.',
          {
            context: undefined,
            modelInvocation,
            modelSettings: { retry: { maxRetries: 2 } },
          },
        ),
      ).rejects.toBe(failure);
      expect(selected.calls).toHaveLength(1);
    },
  );

  it.each([
    ['parallelToolCalls', { parallelToolCalls: false }],
    [
      'toolChoice without enabled tools',
      { toolChoice: 'required' },
      'Migration requires an enabled ordinary-function tool choice',
    ],
  ] satisfies Array<[string, ModelSettings, string?]>)(
    'refuses unsupported %s before resolving or invoking the selected provider',
    async (
      setting,
      modelSettings,
      expectedMessage = `Migration does not support model setting ${setting}`,
    ) => {
      const selected = new ScriptedModel([]);
      const names: Array<string | undefined> = [];
      const agent = new Agent({
        name: 'Unsupported settings',
        instructions: 'Return text.',
        model: 'selected',
        modelSettings,
      });
      await expect(
        SDKRunner.run(agent, 'Hello.', {
          context: undefined,
          modelProvider: {
            getModel(name?: string) {
              names.push(name);
              return selected;
            },
          },
        }),
      ).rejects.toThrow(expectedMessage);
      expect(names).toEqual([]);
      expect(selected.calls).toHaveLength(0);
    },
  );
});
