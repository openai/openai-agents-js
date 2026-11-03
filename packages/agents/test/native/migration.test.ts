import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { z as zod3 } from 'zod/v3';
import {
  Agent,
  Usage,
  ToolCallError,
  tool,
  setTracingDisabled,
  type ModelResponse,
  type RunContext,
} from '@openai/agents-core';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
  modelError,
  modelResponder,
} from '@openai/agents-core/testing';
import { SDKRunner, MigrationCleanupError } from '../../src/migration';
import { SelectedModelInvocation } from '../../src/migration/model';
import { NativeProvider } from '../../src/runtime/provider';
import { binding, type Engine } from '../../src/runtime/binding';
import { NativeProviderRoutes } from '../../src/runtime/http-model';
import type { AgentInputItem } from '@openai/agents-core/types';

setTracingDisabled(true);
afterEach(() => vi.restoreAllMocks());
const classic = (model: ScriptedModel) =>
  new Agent({
    name: 'Migration',
    instructions: 'Use supplied tools and return text.',
    model,
    modelSettings: {},
  });
const actual = (text: string, id: string): ModelResponse => ({
  responseId: id,
  requestId: `request-${id}`,
  output: [assistantMessage(text, { id: `message-${id}` })],
  usage: new Usage({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
});

describe('classic Model on the native turn loop', () => {
  it('captures fresh SDK text/images before await and uses the selected Model and original context', async () => {
    const image =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
    const storage = new AsyncLocalStorage<string>();
    const context = { tag: 'original' };
    const execute = vi.fn(
      (_args: Record<string, never>, current?: RunContext<typeof context>) => {
        expect(current?.context).toBe(context);
        expect(storage.getStore()).toBe('caller');
        return current!.context.tag;
      },
    );
    const model = new ScriptedModel([
      modelResponder((call) => {
        expect(storage.getStore()).toBe('caller');
        const user = (call.request.input as AgentInputItem[]).find(
          (item) => 'role' in item && item.role === 'user',
        );
        expect(user).toMatchObject({
          role: 'user',
          content: [
            { type: 'input_text', text: 'Before image.' },
            {
              type: 'input_image',
              image: expect.stringMatching(/^data:image\/[^,]+;base64,/),
            },
            { type: 'input_text', text: 'After image.' },
          ],
        });
        return {
          ...actual('', 'image-first'),
          output: [
            functionCall('observe_context', '{}', { callId: 'image-context' }),
          ],
        };
      }),
      modelResponder((call) => {
        expect(call.request.input).toContainEqual(
          expect.objectContaining({
            type: 'function_call_result',
            callId: 'image-context',
            output: 'original',
          }),
        );
        return actual('Image received.', 'image-final');
      }),
    ]);
    const fallback = new ScriptedModel([]);
    const provider = { getModel: vi.fn(async () => model) };
    const agent = new Agent<typeof context>({
      name: 'Image input',
      instructions: 'Inspect the image using supplied tools.',
      model: 'chosen-image',
      modelSettings: {},
      tools: [
        tool({
          name: 'observe_context',
          description: 'Observe original context.',
          parameters: z.object({}),
          execute,
        }),
      ],
    });
    const text = { type: 'input_text' as const, text: 'Before image.' };
    const picture = { type: 'input_image' as const, image };
    const parts = [
      text,
      picture,
      { type: 'input_text' as const, text: 'After image.' },
    ];
    const input: AgentInputItem[] = [{ role: 'user', content: parts }];
    const options = { context, modelProvider: provider, model: fallback };
    const running = storage.run('caller', () =>
      SDKRunner.run(agent, input, options),
    );
    text.text = 'Changed.';
    picture.image = 'https://invalid.example/image.png';
    parts.length = 0;
    input.length = 0;
    options.context = { tag: 'replacement' };
    const result = await running;
    expect(result.finalOutput).toBe('Image received.');
    expect(result.modelResponses.at(-1)?.responseId).toBe('image-final');
    expect(provider.getModel).toHaveBeenCalledExactlyOnceWith('chosen-image');
    expect(model.calls).toHaveLength(2);
    expect(fallback.calls).toHaveLength(0);
    expect(execute).toHaveBeenCalledOnce();
  });
  it.each(['response', 'stream'] as const)(
    'reports cumulative %s usage to classic tools',
    async (modelInvocation) => {
      const observed: Array<{ requests: number; totalTokens: number }> = [];
      let lastUsage: Usage | undefined;
      const observeUsage = tool({
        name: 'observe_usage',
        description: 'Record the usage visible to a classic tool.',
        parameters: z.object({}),
        execute: (_args, context) => {
          expect(context).toBeDefined();
          lastUsage = context!.usage;
          observed.push({
            requests: lastUsage.requests,
            totalTokens: lastUsage.totalTokens,
          });
          return 'Recorded.';
        },
      });
      const model = new ScriptedModel([
        ...[1, 2].map((index) =>
          modelResponse({
            ...actual('', `actual_usage_${index}`),
            output: [
              functionCall('observe_usage', '{}', {
                callId: `call_usage_${index}`,
              }),
            ],
          }),
        ),
        modelResponse(actual('Done.', 'actual_usage_final')),
      ]);
      const agent = classic(model);
      agent.tools = [observeUsage];
      const result = await SDKRunner.run(agent, 'Record usage twice.', {
        context: undefined,
        modelInvocation,
      });
      expect(result.finalOutput).toBe('Done.');
      expect(observed).toEqual([
        { requests: 1, totalTokens: 3 },
        { requests: 2, totalTokens: 6 },
      ]);
      expect(lastUsage).toMatchObject({ requests: 3, totalTokens: 9 });
      expect(model.calls.map((call) => call.streamed)).toEqual([
        modelInvocation === 'stream',
        modelInvocation === 'stream',
        modelInvocation === 'stream',
      ]);
    },
  );

  it('runs a function round trip with one classic transform and exact native/restored declarations', async () => {
    let transforms = 0;
    const execute = vi.fn(({ text }: { text: string }) => text);
    const echo = tool({
      name: 'echo',
      description: 'Echo text.',
      parameters: zod3.object({
        text: zod3
          .string()
          .min(2)
          .transform((value) => {
            transforms++;
            return value.toUpperCase();
          }),
      }) as any,
      execute,
    });
    const model = new ScriptedModel([
      modelResponse([
        functionCall('echo', ' { "text" : "hello" } ', { callId: 'call_echo' }),
      ]),
      modelResponder((call) => {
        const input = call.request.input;
        expect(Array.isArray(input)).toBe(true);
        expect(input).toContainEqual(
          expect.objectContaining({
            type: 'function_call',
            callId: 'call_echo',
          }),
        );
        expect(input).toContainEqual(
          expect.objectContaining({
            type: 'function_call_result',
            callId: 'call_echo',
            name: 'echo',
            output: 'HELLO',
          }),
        );
        return actual('Done.', 'actual_final');
      }),
    ]);
    const native = await binding();
    const restore = native.Engine.prototype._sentinel_restore_schemas;
    const generated: unknown[][] = [];
    vi.spyOn(
      native.Engine.prototype,
      '_sentinel_restore_schemas',
    ).mockImplementation(function (this: Engine, provider, ticket, body) {
      generated.push(JSON.parse(body).tools);
      return restore.call(this, provider, ticket, body);
    });
    const produce = SelectedModelInvocation.prototype.produce;
    const restored: unknown[][] = [];
    vi.spyOn(SelectedModelInvocation.prototype, 'produce').mockImplementation(
      function (this: SelectedModelInvocation, body, ...args) {
        restored.push(structuredClone(body.tools as unknown[]));
        return produce.call(this, body, ...args);
      },
    );
    const agent = classic(model);
    agent.tools = [echo];
    const result = await SDKRunner.run(agent, 'Echo hello.', {
      context: { trusted: true },
    });
    expect(result.finalOutput).toBe('Done.');
    expect(result.modelResponses).toHaveLength(2);
    expect(result.modelResponses[1].responseId).toBe('actual_final');
    expect(result.native.sessionId).toEqual(expect.any(String));
    expect(result.native.turnId).toEqual(expect.any(String));
    expect(result.native.usage).not.toBeNull();
    expect(transforms).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(generated[0]).toEqual([
      expect.objectContaining({ name: 'echo', strict: true }),
    ]);
    expect(restored[0]).toEqual([
      {
        type: 'function',
        name: 'echo',
        description: 'Echo text.',
        strict: true,
        parameters: echo.parameters,
      },
    ]);
    expect(model.calls[0].request.tools).toEqual([
      {
        type: 'function',
        name: 'echo',
        description: 'Echo text.',
        strict: true,
        parameters: echo.parameters,
      },
    ]);
  });

  it('rejects foreign root/control/turn, forged nonce and duplicate real native claims without another Model call', async () => {
    const native = await binding();
    const claim = native.Engine.prototype._sentinel_claim;
    const current = native.Engine.prototype._sentinel_current;
    const rejections: string[] = [];
    vi.spyOn(native.Engine.prototype, '_sentinel_claim').mockImplementation(
      async function (this: Engine, provider, ticket, expected) {
        const root = JSON.parse(expected);
        for (const field of ['thread', 'control', 'turn', 'model']) {
          await expect(
            claim.call(
              this,
              provider,
              ticket,
              JSON.stringify({ ...root, [field]: 'foreign' }),
            ),
          ).rejects.toBeDefined();
          rejections.push(field);
        }
        await expect(
          claim.call(
            this,
            provider,
            JSON.stringify({
              ...JSON.parse(ticket),
              sdk_sentinel_nonce: 'foreign',
            }),
            expected,
          ),
        ).rejects.toBeDefined();
        const receipt = await claim.call(this, provider, ticket, expected);
        await expect(
          claim.call(this, provider, ticket, expected),
        ).rejects.toBeDefined();
        await current.call(this, provider, ticket, expected);
        return receipt;
      },
    );
    const model = new ScriptedModel([
      modelResponse(actual('Claimed.', 'claimed')),
    ]);
    expect(
      (await SDKRunner.run(classic(model), 'Hello.', { context: undefined }))
        .finalOutput,
    ).toBe('Claimed.');
    expect(rejections).toEqual(['thread', 'control', 'turn', 'model']);
    expect(model.calls).toHaveLength(1);
  });

  it('refuses a revoked completion and joins its producer after caller abort', async () => {
    const native = await binding();
    const finish = native.Engine.prototype._sentinel_finish;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(native.Engine.prototype, '_sentinel_finish').mockImplementation(
      async function (this: Engine, ...args) {
        entered.resolve();
        await release.promise;
        return finish.apply(this, args);
      },
    );
    const model = new ScriptedModel([modelResponse(actual('Late.', 'late'))]);
    const controller = new AbortController();
    const reason = new Error('Caller stopped');
    let settled = false;
    const result = SDKRunner.run(classic(model), 'Hello.', {
      context: undefined,
      signal: controller.signal,
    }).finally(() => {
      settled = true;
    });
    result.catch(() => {});
    await entered.promise;
    controller.abort(reason);
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    await expect(result).rejects.toBe(reason);
    expect(model.calls).toHaveLength(1);
  });

  it.each(['return', 'throw signal', 'throw distinct', 'end hook'] as const)(
    'joins an entered function callback that will %s after caller cancellation',
    async (outcome) => {
      const entered = Promise.withResolvers<AbortSignal>();
      const release = Promise.withResolvers<void>();
      let effects = 0;
      const distinct = new Error('Independent callback failure');
      if (outcome === 'throw distinct') distinct.name = 'AbortError';
      const held = tool({
        name: 'held',
        description: 'Wait for release.',
        parameters: z.object({}),
        execute: async (_args, _context, details) => {
          effects++;
          entered.resolve(details!.signal!);
          await release.promise;
          if (outcome === 'throw signal') throw details!.signal!.reason;
          if (outcome === 'throw distinct') throw distinct;
          return 'Done';
        },
      });
      const model = new ScriptedModel([
        modelResponse({
          ...actual('', 'held'),
          output: [functionCall('held', '{}', { callId: 'held-call' })],
        }),
      ]);
      const agent = classic(model);
      agent.tools = [held];
      if (outcome === 'end hook')
        agent.on('agent_tool_end', () => {
          throw distinct;
        });
      const controller = new AbortController();
      const reason = new Error('Caller stopped held callback');
      let settled = false;
      const result = SDKRunner.run(agent, 'Hello.', {
        context: undefined,
        signal: controller.signal,
      }).finally(() => {
        settled = true;
      });
      void result.catch(() => {});
      try {
        const signal = await Promise.race([
          entered.promise,
          result.then(() => {
            throw new Error('Callback was not entered');
          }),
        ]);
        controller.abort(reason);
        await vi.waitFor(() => expect(signal.aborted).toBe(true));
        expect(settled).toBe(false);
        release.resolve();
        if (outcome === 'throw distinct' || outcome === 'end hook') {
          const failure = await result.catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(MigrationCleanupError);
          const cleanup = failure as MigrationCleanupError;
          expect(cleanup.cause).toBe(reason);
          expect(cleanup.errors).toContain(reason);
          expect(cleanup.errors).toContainEqual(
            expect.objectContaining({ error: distinct }),
          );
          expect(
            cleanup.errors.some((error) => error instanceof ToolCallError),
          ).toBe(true);
          await cleanup.retryCleanup().catch(() => {});
        } else {
          await expect(result).rejects.toBe(reason);
        }
        expect(effects).toBe(1);
        expect(model.calls).toHaveLength(1);
      } finally {
        release.resolve();
        await result.catch(() => {});
      }
    },
    30_000,
  );

  it('resolves a named Model once and preserves captured async context', async () => {
    const storage = new AsyncLocalStorage<string>();
    const model = new ScriptedModel([
      modelResponder(() => {
        expect(storage.getStore()).toBe('caller');
        return actual('Named.', 'actual_named');
      }),
    ]);
    const borrowedClose = vi.fn();
    const provider = {
      getModel: vi.fn(async () => {
        expect(storage.getStore()).toBe('caller');
        return model;
      }),
      close: borrowedClose,
    };
    const agent = new Agent({
      name: 'Named',
      instructions: 'Answer.',
      model: 'application-model',
      modelSettings: {},
    });
    const result = await storage.run('caller', () =>
      SDKRunner.run(agent, 'Hello.', {
        context: undefined,
        modelProvider: provider,
      }),
    );
    expect(result.finalOutput).toBe('Named.');
    expect(provider.getModel).toHaveBeenCalledExactlyOnceWith(
      'application-model',
    );
    expect(borrowedClose).not.toHaveBeenCalled();
    expect(model.calls[0].request).not.toHaveProperty('previousResponseId');
    expect(model.calls[0].request).not.toHaveProperty(
      '_internal.runnerManagedRetry',
    );
  });

  it('throws the original Model error once without retry or fallback', async () => {
    const error = new Error('Original connection failure');
    const model = new ScriptedModel([modelError(error)]);
    await expect(
      SDKRunner.run(classic(model), 'Hello.', { context: undefined }),
    ).rejects.toBe(error);
    expect(model.calls).toHaveLength(1);
  });

  it('completes buffered stream invocation through the same native loop', async () => {
    const model = new ScriptedModel([
      modelResponse(actual('Streamed.', 'actual_stream')),
    ]);
    const result = await SDKRunner.run(classic(model), 'Hello.', {
      context: undefined,
      modelInvocation: 'stream',
    });
    expect(result.finalOutput).toBe('Streamed.');
    expect(result.modelResponses[0].responseId).toBe('actual_stream');
    expect(model.calls[0].streamed).toBe(true);
  });

  it('retains closure-bound cleanup retry without replaying a successful run', async () => {
    const model = new ScriptedModel([
      modelResponse(actual('Done.', 'actual_cleanup')),
    ]);
    const close = NativeProvider.prototype.close;
    const rejected = new Error('Owned provider close failed');
    const gate = Promise.withResolvers<void>();
    let attempts = 0;
    vi.spyOn(NativeProvider.prototype, 'close').mockImplementation(
      async function (this: NativeProvider) {
        attempts++;
        if (attempts === 1) throw rejected;
        await gate.promise;
        return close.call(this);
      },
    );
    let failure: unknown;
    try {
      await SDKRunner.run(classic(model), 'Hello.', { context: undefined });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MigrationCleanupError);
    const cleanup = (failure as MigrationCleanupError).retryCleanup;
    const first = cleanup(),
      second = cleanup();
    expect(first).toBe(second);
    gate.resolve();
    await first;
    await cleanup();
    expect(attempts).toBe(2);
    expect(model.calls).toHaveLength(1);
    expect((failure as Error).cause).toBe(rejected);
  });

  it('retains failed opening cleanup for explicit retry without resolving or invoking again', async () => {
    const native = await binding();
    const openingError = new Error('Native engine opening failed');
    const closeError = new Error('Carrier cleanup failed');
    vi.spyOn(native, 'create_engine').mockRejectedValueOnce(openingError);
    const close = NativeProviderRoutes.prototype.close;
    let attempts = 0;
    vi.spyOn(NativeProviderRoutes.prototype, 'close').mockImplementation(
      function (this: NativeProviderRoutes) {
        if (++attempts === 1) return Promise.reject(closeError);
        return close.call(this);
      },
    );
    const model = new ScriptedModel([]);
    const getModel = vi.fn(async () => model);
    const agent = new Agent({
      name: 'Opening',
      model: 'named',
      modelSettings: {},
    });
    let failure: unknown;
    try {
      await SDKRunner.run(agent, '', {
        context: undefined,
        modelProvider: { getModel },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MigrationCleanupError);
    expect((failure as MigrationCleanupError).cause).toBe(openingError);
    expect((failure as MigrationCleanupError).errors).toEqual([
      openingError,
      closeError,
    ]);
    expect(attempts).toBe(1);
    await (failure as MigrationCleanupError).retryCleanup();
    expect(attempts).toBe(2);
    expect(getModel).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(0);
  });

  it('isolates concurrent invocation responses and roots', async () => {
    const models = ['left', 'right'].map(
      (name) => new ScriptedModel([modelResponse(actual(name, name))]),
    );
    const results = await Promise.all(
      models.map((model) =>
        SDKRunner.run(classic(model), 'Hello.', { context: undefined }),
      ),
    );
    expect(results.map((result) => result.finalOutput)).toEqual([
      'left',
      'right',
    ]);
    expect(results[0].native.sessionId).not.toBe(results[1].native.sessionId);
    expect(
      results.map((result) => result.modelResponses[0].responseId),
    ).toEqual(['left', 'right']);
  });
});
