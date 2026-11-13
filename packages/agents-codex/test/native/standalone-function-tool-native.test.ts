import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  ToolOutput,
  ToolTimeoutError,
  standaloneTool,
  tool,
  type ToolInvocationContext,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('uses the same argument and result policies in direct and native Session calls', async () => {
  const application = { multiplier: 3 };
  const declaration = standaloneTool({
    name: 'scale',
    parameters: z.object({ amount: z.number() }),
    result: z.string().transform(Number),
    before(context: ToolInvocationContext<typeof application>) {
      expect(context.context).toBe(application);
      expect(context.originalArguments).toEqual({ amount: 2 });
      return { action: 'replaceArguments', arguments: { amount: 3 } };
    },
    execute({ amount }, context) {
      expect(context.effectiveArguments).toEqual({ amount: 3 });
      return String(amount * context.context.multiplier);
    },
  });
  expect(
    await declaration.invoke('{"amount":2}', { context: application }),
  ).toBe(9);

  const server = new ModelServer([
    [call('scale', { amount: 2 }, { callId: 'scale-1' })],
    [message('done')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-standalone',
    supportsWebsockets: false,
  });
  const agent = new Agent<typeof application>({
    instructions: 'Scale the amount.',
    tools: [declaration],
    provider,
  });
  expect((await agent.run('scale', { context: application })).finalOutput).toBe(
    'done',
  );
  expect(server.requests[1]!.input).toContainEqual(
    expect.objectContaining({
      type: 'function_call_output',
      call_id: 'scale-1',
      output: '9',
    }),
  );
  server.assertExhausted();
});

it('formats direct input and body failures in their own callback phases', async () => {
  const original = new Error('synthetic callback error');
  const execute = vi.fn(() => {
    throw original;
  });
  const declaration = standaloneTool({
    name: 'broken',
    parameters: z.object({ amount: z.number() }),
    execute,
    inputErrorFunction(context, error, raw) {
      expect(context.context).toBe('app');
      expect(context).not.toHaveProperty('submission');
      return `${error.name}: ${JSON.stringify(raw)}`;
    },
    errorFunction(context, error) {
      expect(error).toBe(original);
      expect(context.effectiveArguments).toEqual({ amount: 2 });
      return 'body failure';
    },
  });
  const failed = (text: string) =>
    new ToolOutput([{ type: 'inputText', text }], false);
  expect(await declaration.invoke('{', { context: 'app' })).toEqual(
    failed('SyntaxError: "{"'),
  );
  expect(
    await declaration.invoke({ amount: 'wrong' }, { context: 'app' }),
  ).toEqual(failed('ZodError: {"amount":"wrong"}'));
  expect(execute).not.toHaveBeenCalled();
  expect(await declaration.invoke({ amount: 2 }, { context: 'app' })).toEqual(
    failed('body failure'),
  );
  expect(execute).toHaveBeenCalledOnce();
});

it('joins a timed-out callback before formatting the failure', async () => {
  const { promise: enteredTimeout, resolve: observedTimeout } =
    Promise.withResolvers<unknown>();
  const { promise: release, resolve: finish } = Promise.withResolvers<void>();
  const after = vi.fn((output: ToolOutput) => output);
  const cleanup = vi.fn();
  const declaration = standaloneTool({
    name: 'slow',
    parameters: z.object({}),
    callbackTimeout: 0.015,
    timeoutBehavior: 'error_as_result',
    timeoutErrorFunction() {
      expect(cleanup).toHaveBeenCalledOnce();
      return 'deadline';
    },
    after,
    async execute(_args, context) {
      context.signal.addEventListener(
        'abort',
        () => observedTimeout(context.signal.reason),
        { once: true },
      );
      await release;
      cleanup();
      return 'too late';
    },
  });
  const pending = declaration.invoke({});
  expect(await enteredTimeout).toBeInstanceOf(ToolTimeoutError);
  expect(cleanup).not.toHaveBeenCalled();
  finish();
  expect(await pending).toEqual(
    new ToolOutput([{ type: 'inputText', text: 'deadline' }], false),
  );
  expect(after).not.toHaveBeenCalled();
});

it('validates direct results and returns a configured output policy replacement', async () => {
  const invalid = standaloneTool({
    name: 'invalid',
    parameters: z.object({}),
    result: z.number().positive(),
    execute: () => -1,
  });
  await expect(invalid.invoke({})).rejects.toThrow(
    'Tool result failed validation',
  );
  const transformed = standaloneTool({
    name: 'after',
    parameters: z.object({}),
    execute: () => 'original',
    after: () => new ToolOutput([{ type: 'inputText', text: 'replacement' }]),
  });
  expect(await transformed.invoke({})).toEqual(
    new ToolOutput([{ type: 'inputText', text: 'replacement' }]),
  );
});

it('keeps approval-gated declarations and pre-aborted calls from entering the body', async () => {
  const execute = vi.fn(() => 'result');
  const options = { name: 'guarded', parameters: z.object({}), execute };
  expect(tool({ ...options, needsApproval: true })).not.toHaveProperty(
    'invoke',
  );
  expect(() =>
    Reflect.apply(standaloneTool, undefined, [
      { ...options, needsApproval: true },
    ]),
  ).toThrow(
    'Standalone invocation requires an application function without approval',
  );

  const reason = new Error('synthetic external cancellation');
  await expect(
    standaloneTool(options).invoke({}, { signal: AbortSignal.abort(reason) }),
  ).rejects.toBe(reason);
  expect(execute).not.toHaveBeenCalled();
});
