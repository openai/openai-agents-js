import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  tool,
  type ToolErrorFormatter,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
afterEach(() => ModelServer.closeAll());
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}
it.each(['custom', 'empty', 'undefined', 'throws', 'invalid'] as const)(
  'has been preserving unknown-tool rejection with %s presentation before later valid execution',
  async (policy) => {
    const server = new ModelServer([
      [call('missing_tool', {}, { callId: 'missing' })],
      [call('lookup', {}, { callId: 'valid' })],
      [message('recovered')],
    ]);
    const execute = vi.fn(() => 'valid result');
    const seen: Parameters<ToolErrorFormatter>[0][] = [];
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Recover from unavailable tools.',
      provider,
      tools: [tool({ name: 'lookup', parameters: z.object({}), execute })],
    }).session({
      toolErrorFormatter: (context) => {
        seen.push(context);
        expect(execute).not.toHaveBeenCalled();
        if (policy === 'throws') throw new Error('private formatter failure');
        if (policy === 'invalid')
          return { name: 'lookup' } as unknown as string;
        return policy === 'custom'
          ? 'public unavailable'
          : policy === 'empty'
            ? ''
            : undefined;
      },
    });
    expect(
      (
        await (
          await session.submit('start', {
            toolNotFoundBehavior: 'return_error_to_model',
          })
        ).wait()
      ).finalOutput,
    ).toBe('recovered');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      phase: 'execution',
      reason: 'tool_not_found',
      call: { tool: { name: 'missing_tool' }, callId: 'missing' },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const input = server.requests[1].input as Array<{
      type: string;
      call_id: string;
      output: unknown;
    }>;
    const output = input.find((item) => item.type === 'function_call_output')!;
    expect(output).toMatchObject({ call_id: 'missing' });
    const text =
      typeof output.output === 'string'
        ? output.output
        : JSON.stringify(output.output);
    expect(text).not.toContain('private formatter failure');
    if (policy === 'custom') expect(text).toBe('public unavailable');
    else if (policy === 'empty') expect(text).toBe('');
    else expect(text).toContain('missing_tool');
    server.assertExhausted();
  },
);
it('has been preserving strict unknown rejection ahead of formatting and execution', async () => {
  const server = new ModelServer([
    [call('missing_tool', {}, { callId: 'missing' })],
  ]);
  const formatter = vi.fn(() => 'must not replace fatal error');
  const execute = vi.fn(() => 'not admitted');
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use a tool.',
    provider,
    tools: [tool({ name: 'lookup', parameters: z.object({}), execute })],
  }).session({ toolErrorFormatter: formatter });
  await expect(
    (
      await session.submit('start', { toolNotFoundBehavior: 'raise_error' })
    ).wait(),
  ).rejects.toThrow();
  expect(formatter).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(server.requests).toHaveLength(1);
  server.assertExhausted();
});

it('has been joining entered unknown-tool formatting on cancellation without publishing late text', async () => {
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = new ModelServer([
    [call('missing_tool', {}, { callId: 'missing' })],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use a tool.',
    provider,
  }).session({
    toolErrorFormatter: async (context) => {
      entered.resolve();
      context.signal.addEventListener('abort', () => cancelled.resolve(), {
        once: true,
      });
      await release.promise;
      throw new Error('private late formatter rejection');
    },
  });
  const turn = await session.submit('start', {
    toolNotFoundBehavior: 'return_error_to_model',
  });
  const result = turn.wait().catch((error) => error);
  await entered.promise;
  let finished = false;
  const stopping = turn.cancel().then(() => {
    finished = true;
  });
  try {
    await cancelled.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);
    expect(server.requests).toHaveLength(1);
  } finally {
    release.resolve();
  }
  await stopping;
  await result;
  expect(server.requests).toHaveLength(1);
  server.assertExhausted();
});
