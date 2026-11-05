import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  ToolOutput,
  tool,
  type ToolContext,
} from '@openai/agents';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function provider(server: ModelServer) {
  const config = await server.config();
  const selected = config['model_providers.fixture'] as { base_url: string };
  return new NativeProvider({
    baseUrl: selected.base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}

function recordedToolText(server: ModelServer, callId: string): string {
  const items = server.requests[1].input as Array<{
    type: string;
    call_id?: string;
    output?: string | Array<{ text?: string }>;
  }>;
  const output = items.find(
    (item) => item.type === 'function_call_output' && item.call_id === callId,
  )?.output;
  expect(output).toBeDefined();
  return typeof output === 'string'
    ? output
    : output!.map((part) => part.text ?? '').join('');
}

it('uses revalidated replacements and publishes only the result accepted by after', async () => {
  const server = new ModelServer([
    [call('lookup', { key: ' original ' }, { callId: 'policy-1' })],
    [message('done')],
  ]);
  const selected = await provider(server);
  const context = { records: new Map([['effective', 'private-result']]) };
  const stages: string[] = [];
  let observed: ToolContext<typeof context> | undefined;
  const agent = new Agent<typeof context>({
    instructions: 'Use lookup.',
    model: 'gpt-5',
    provider: selected,
    tools: [
      tool({
        name: 'lookup',
        parameters: z.object({
          key: z.string().trim(),
          limit: z.number().default(2),
        }),
        async before(info: ToolContext<typeof context>) {
          stages.push('before');
          expect(info.originalArguments).toEqual({ key: ' original ' });
          expect(info.effectiveArguments).toEqual({
            key: 'original',
            limit: 2,
          });
          return {
            action: 'replaceArguments',
            arguments: { key: ' effective ' },
          };
        },
        execute(args, info) {
          stages.push('execute');
          observed = info;
          expect(args).toEqual({ key: 'effective', limit: 2 });
          return info.context.records.get(args.key)!;
        },
        result: z.string().transform((value) => ({ value })),
        async after(output, info) {
          stages.push('after');
          expect(output.contentItems).toEqual([
            { type: 'inputText', text: '{"value":"private-result"}' },
          ]);
          expect(info.effectiveArguments).toEqual({
            key: 'effective',
            limit: 2,
          });
          return new ToolOutput([{ type: 'inputText', text: 'public-result' }]);
        },
      }),
    ],
  });
  const session = await agent.session({ context });
  try {
    const turn = await session.submit('start');
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(stages).toEqual(['before', 'execute', 'after']);
    expect(observed?.context).toBe(context);
    expect(observed?.submission).toBe(turn);
    expect(observed?.callId).toBe('policy-1');
    expect(recordedToolText(server, 'policy-1')).toBe('public-result');
    const items = [];
    for await (const item of session.items()) items.push(item);
    expect(JSON.stringify(items)).toContain('public-result');
    expect(JSON.stringify(items)).not.toContain('private-result');
    server.assertExhausted();
  } finally {
    await session.close();
    await selected.close();
  }
});

it('delivers a local denial, records failed tool status, and continues the same turn', async () => {
  const server = new ModelServer([
    [call('denied', {}, { callId: 'denied-1' })],
    [message('continued')],
  ]);
  const selected = await provider(server);
  const execute = vi.fn(() => 'unused');
  const after = vi.fn((output: ToolOutput) => output);
  const validateResult = vi.fn(() => true);
  const agent = new Agent({
    instructions: 'Call denied.',
    model: 'gpt-5',
    provider: selected,
    tools: [
      tool({
        name: 'denied',
        parameters: z.object({}),
        execute,
        after,
        result: z.string().refine(validateResult),
        before: () => ({ action: 'deny', reason: 'Unavailable' }),
      }),
    ],
  });
  const session = await agent.session();
  try {
    const turn = await session.submit('start');
    expect((await turn.wait()).finalOutput).toBe('continued');
    expect(recordedToolText(server, 'denied-1')).toBe('Unavailable');
    expect(execute).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expect(validateResult).not.toHaveBeenCalled();
    const finished = [];
    for await (const event of session.events()) {
      if (event.type === 'tool_finished') finished.push(event);
      if (event.type === 'turn_finished') break;
    }
    expect(finished).toMatchObject([{ callId: 'denied-1', status: 'failed' }]);
    server.assertExhausted();
  } finally {
    await session.close();
    await selected.close();
  }
});

it('fails an invalid declared result without publishing it or rerunning the callback', async () => {
  const server = new ModelServer([
    [call('invalid', {}, { callId: 'invalid-1' })],
    [message('recovered')],
  ]);
  const selected = await provider(server);
  const execute = vi.fn(() => 'synthetic-private-invalid-value');
  const after = vi.fn((output: ToolOutput) => output);
  const agent = new Agent({
    instructions: 'Use invalid.',
    model: 'gpt-5',
    provider: selected,
    tools: [
      tool({
        name: 'invalid',
        parameters: z.object({}),
        execute,
        after,
        result: z.string().regex(/^accepted$/),
      }),
    ],
  });
  const session = await agent.session();
  try {
    const turn = await session.submit('start');
    await expect(turn.wait()).rejects.toThrow('Tool result failed validation');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(after).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(1);
    const items = [];
    for await (const item of session.items()) items.push(item);
    expect(JSON.stringify(items)).not.toContain(
      'synthetic-private-invalid-value',
    );
    expect((await (await session.submit('continue')).wait()).finalOutput).toBe(
      'recovered',
    );
    expect(execute).toHaveBeenCalledTimes(1);
    server.assertExhausted();
  } finally {
    await session.close();
    await selected.close();
  }
});

it('rejects invalid replacements before the execution callback can have an effect', async () => {
  const server = new ModelServer([
    [call('restricted', { amount: 1 }, { callId: 'replacement-1' })],
  ]);
  const selected = await provider(server);
  const execute = vi.fn(() => 'effect');
  const agent = new Agent({
    instructions: 'Use restricted.',
    model: 'gpt-5',
    provider: selected,
    tools: [
      tool({
        name: 'restricted',
        parameters: z.object({ amount: z.number().positive() }),
        before: () => ({
          action: 'replaceArguments',
          arguments: { amount: -1 },
        }),
        execute,
      }),
    ],
  });
  try {
    await expect(agent.run('start')).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(1);
    server.assertExhausted();
  } finally {
    await selected.close();
  }
});

it.each(['before', 'after'] as const)(
  'joins a cancelled %s policy and withholds its late result',
  async (phase) => {
    const server = new ModelServer([
      [call('held', {}, { callId: 'held-policy-1' })],
    ]);
    const selected = await provider(server);
    const lateValue = 'synthetic-late-policy-value';
    let release!: () => void;
    const finish = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let aborted!: () => void;
    const stopped = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const hold = async (context: ToolContext) => {
      context.signal.addEventListener('abort', aborted, { once: true });
      entered();
      await finish;
    };
    const execute = vi.fn(() => 'completed body');
    const after = vi.fn(async (output: ToolOutput, context: ToolContext) => {
      if (phase === 'after') {
        await hold(context);
        return new ToolOutput([{ type: 'inputText', text: lateValue }]);
      }
      return output;
    });
    const agent = new Agent({
      instructions: 'Use held.',
      model: 'gpt-5',
      provider: selected,
      tools: [
        tool({
          name: 'held',
          parameters: z.object({}),
          execute,
          after,
          async before(context) {
            if (phase === 'before') await hold(context);
            return { action: 'allow' };
          },
        }),
      ],
    });
    const session = await agent.session();
    try {
      const turn = await session.submit('start');
      let settled = false;
      const outcome = turn.wait().then(
        (result) => {
          settled = true;
          return result;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await started;
      const interrupt = session.interrupt();
      await stopped;
      expect(settled).toBe(false);
      release();
      await interrupt;
      expect(await outcome).toBeInstanceOf(Error);
      expect(execute).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1);
      expect(after).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1);
      expect(server.requests).toHaveLength(1);
      expect(JSON.stringify(server.requests)).not.toContain(lateValue);
      const items = [];
      for await (const item of session.items()) items.push(item);
      expect(JSON.stringify(items)).not.toContain(lateValue);
      server.assertExhausted();
    } finally {
      release();
      await session.close();
      await selected.close();
    }
  },
);
