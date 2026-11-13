import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Handoff,
  NativeProvider,
  shellTool,
  applyPatchTool,
  tool,
  manualTool,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import type { JsonObject } from '../../src/runtime/binding';

afterEach(() => ModelServer.closeAll());
const shell = (id: string): JsonObject => ({
  type: 'shell_call',
  call_id: id,
  action: { commands: [id], timeout_ms: 1000, max_output_length: 32 },
});
const patch = (id: string): JsonObject => ({
  type: 'apply_patch_call',
  id: `item-${id}`,
  call_id: id,
  status: 'completed',
  operation: { type: 'delete_file', path: id },
});
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-mixed-outcomes',
    supportsWebsockets: false,
  });
}
const shellOutput = () => ({
  output: [
    {
      stdout: 'done',
      stderr: '',
      outcome: { type: 'exit' as const, exit_code: 0 },
    },
  ],
});

// Application callbacks expose actual native admission without a privileged filesystem executor.
it.each(['shell', 'patch'] as const)(
  'preserves mixed mutation order with %s first',
  async (first) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const effects: string[] = [];
    const server = new ModelServer([
      first === 'shell'
        ? [shell('first'), patch('second'), shell('third')]
        : [patch('first'), shell('second'), patch('third')],
      [message('done')],
    ]);
    await using selected = await providerFor(server);
    const perform = async (id: string) => {
      effects.push(`${id}:start`);
      if (id === 'first') {
        entered.resolve();
        await release.promise;
      }
      effects.push(`${id}:end`);
    };
    const edit = async (op: { path: string }) => {
      await perform(op.path);
      return { output: 'done' };
    };
    const agent = new Agent({
      instructions: 'Use the supplied tools.',
      model: 'gpt-5',
      provider: selected,
      tools: [
        shellTool({
          async execute(value) {
            await perform(value.action.commands[0]);
            return shellOutput();
          },
        }),
        applyPatchTool({
          editor: { createFile: edit, updateFile: edit, deleteFile: edit },
        }),
      ],
    });
    await using session = await agent.session();
    try {
      const turn = await session.submit('Run the three ordered operations.');
      const result = turn.wait();
      await entered.promise;
      await new Promise((resolve) => setTimeout(resolve, 150));
      release.resolve();
      expect((await result).finalOutput).toBe('done');
      expect(effects).toEqual([
        'first:start',
        'first:end',
        'second:start',
        'second:end',
        'third:start',
        'third:end',
      ]);
    } finally {
      release.resolve();
    }
  },
  15000,
);

it('preserves the fatal function failure before admitting Shell or ApplyPatch', async () => {
  const original = new Error('synthetic-original-fatal-function');
  const effects: string[] = [];
  const server = new ModelServer([
    [
      call('fail', {}, { callId: 'fatal' }),
      shell('shell-after-failure'),
      patch('patch-after-failure'),
    ],
  ]);
  await using selected = await providerFor(server);
  const edit = () => {
    effects.push('patch');
    return { output: 'unexpected' };
  };
  const agent = new Agent({
    instructions: 'Use the supplied tools.',
    model: 'gpt-5',
    provider: selected,
    tools: [
      tool({
        name: 'fail',
        parameters: z.object({}),
        errorFunction: null,
        execute() {
          throw original;
        },
      }),
      shellTool({
        execute() {
          effects.push('shell');
          return shellOutput();
        },
      }),
      applyPatchTool({
        editor: { createFile: edit, updateFile: edit, deleteFile: edit },
      }),
    ],
  });
  await using session = await agent.session({ maxFunctionConcurrency: 1 });
  await expect(
    (await session.submit('Fail before mutation.')).wait(),
  ).rejects.toBe(original);
  expect(effects).toEqual([]);
  expect(server.requests).toHaveLength(1);
}, 15000);

it('cancels a held Shell callback without admitting its later mixed mutations', async () => {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const effects: string[] = [];
  const server = new ModelServer([
    [shell('first'), patch('second'), shell('third')],
  ]);
  await using selected = await providerFor(server);
  const edit = () => {
    effects.push('patch');
    return { output: 'unexpected' };
  };
  const agent = new Agent({
    instructions: 'Use the supplied tools.',
    model: 'gpt-5',
    provider: selected,
    tools: [
      shellTool({
        async execute(value, context) {
          effects.push(value.action.commands[0]);
          context.signal.addEventListener('abort', () => aborted.resolve(), {
            once: true,
          });
          entered.resolve();
          await release.promise;
          return shellOutput();
        },
      }),
      applyPatchTool({
        editor: { createFile: edit, updateFile: edit, deleteFile: edit },
      }),
    ],
  });
  await using session = await agent.session();
  try {
    const turn = await session.submit('Cancel during the first operation.');
    let settled = false;
    const result = turn.wait().then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await entered.promise;
    const stopped = turn.cancel();
    await aborted.promise;
    expect(settled).toBe(false);
    release.resolve();
    await stopped;
    expect(await result).toBeInstanceOf(Error);
    expect(effects).toEqual(['first']);
    expect(server.requests).toHaveLength(1);
  } finally {
    release.resolve();
  }
}, 15000);

// Native model dispatch is required: the regression sits before JS admission.
it('keeps a manual sibling live while a Shell callback awaits its decision', async () => {
  const entered = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const decision = manualTool({
    name: 'decision',
    description: 'Supply the decision awaited by the Shell callback.',
    parameters: z.object({}),
    result: z.string(),
  });
  const server = new ModelServer([
    [
      {
        type: 'shell_call',
        call_id: 'held-shell',
        action: {
          commands: ['hold'],
          timeout_ms: 1000,
          max_output_length: 32,
        },
      },
      call('decision', {}, { callId: 'decision' }),
    ],
    [message('done')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-mutation-progress',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions: 'Use Shell and the manual decision.',
    model: 'gpt-5',
    provider,
    tools: [
      decision,
      shellTool({
        async execute() {
          entered.resolve();
          await release.promise;
          return {
            output: [
              {
                stdout: 'done',
                stderr: '',
                outcome: {
                  type: 'exit' as const,
                  exit_code: 0,
                },
              },
            ],
          };
        },
      }),
    ],
  });
  await using session = await agent.session({
    async onInteraction(action) {
      const request = decision.match(action);
      if (!request) throw new Error('Unexpected interaction');
      await Promise.race([entered.promise, release.promise]);
      answered.resolve();
      return request.reply('yes');
    },
  });
  const turn = await session.submit('Run both.');
  const result = turn.wait();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Keep Shell entered throughout this assertion, then always join it below.
    await Promise.race([
      Promise.all([entered.promise, answered.promise]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Manual sibling was blocked by Shell')),
          1500,
        );
      }),
    ]);
    release.resolve();
    expect((await result).finalOutput).toBe('done');
    server.assertExhausted();
  } finally {
    if (timer) clearTimeout(timer);
    release.resolve();
    await result.catch(() => {});
  }
}, 15000);

it('keeps a manual sibling live while an automatic callback delays later workspace mutations', async () => {
  const entered = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const effects: string[] = [];
  const decision = manualTool({
    name: 'decision',
    description: 'Supply a decision.',
    parameters: z.object({}),
    result: z.string(),
  });
  const server = new ModelServer([
    [
      call('hold', {}, { callId: 'held-function' }),
      call('decision', {}, { callId: 'manual' }),
      shell('after-function'),
      patch('after-shell'),
    ],
    [message('done')],
  ]);
  await using selected = await providerFor(server);
  const edit = () => {
    effects.push('patch');
    return { output: 'done' };
  };
  const agent = new Agent({
    instructions: 'Use the supplied tools.',
    model: 'gpt-5',
    provider: selected,
    tools: [
      decision,
      tool({
        name: 'hold',
        parameters: z.object({}),
        async execute() {
          entered.resolve();
          await release.promise;
          effects.push('function');
          return 'done';
        },
      }),
      shellTool({
        execute() {
          effects.push('shell');
          return shellOutput();
        },
      }),
      applyPatchTool({
        editor: { createFile: edit, updateFile: edit, deleteFile: edit },
      }),
    ],
  });
  await using session = await agent.session({
    maxFunctionConcurrency: 1,
    async onInteraction(action) {
      const request = decision.match(action);
      if (!request) throw new Error('Unexpected interaction');
      await Promise.race([entered.promise, release.promise]);
      answered.resolve();
      return request.reply('yes');
    },
  });
  const result = (await session.submit('Run the four calls.')).wait();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([entered.promise, answered.promise]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error('Manual sibling was blocked by function admission'),
            ),
          1500,
        );
      }),
    ]);
    expect(effects).toEqual([]);
    release.resolve();
    expect((await result).finalOutput).toBe('done');
    expect(effects).toEqual(['function', 'shell', 'patch']);
  } finally {
    if (timer) clearTimeout(timer);
    release.resolve();
    await result.catch(() => {});
  }
}, 15000);

it('settles a later-position fatal callback before any workspace effects while manual progress stays live', async () => {
  const answered = Promise.withResolvers<void>();
  const effects: string[] = [];
  const original = new Error('synthetic-later-fatal-function');
  const decision = manualTool({
    name: 'decision',
    description: 'Unblock the remaining provider response.',
    parameters: z.object({}),
    result: z.string(),
  });
  const server = new ModelServer(
    [
      [
        shell('first'),
        patch('second'),
        call('decision', {}, { callId: 'manual' }),
        call('fail', {}, { callId: 'fatal-last' }),
      ],
    ],
    [],
    async (_item, index) => {
      if (index === 3) await answered.promise;
    },
  );
  await using selected = await providerFor(server);
  const edit = () => {
    effects.push('patch');
    return { output: 'unexpected' };
  };
  const agent = new Agent({
    instructions: 'Use the supplied tools.',
    model: 'gpt-5',
    provider: selected,
    tools: [
      decision,
      tool({
        name: 'fail',
        parameters: z.object({}),
        errorFunction: null,
        execute() {
          throw original;
        },
      }),
      shellTool({
        execute() {
          effects.push('shell');
          return shellOutput();
        },
      }),
      applyPatchTool({
        editor: { createFile: edit, updateFile: edit, deleteFile: edit },
      }),
    ],
  });
  await using session = await agent.session({
    maxFunctionConcurrency: 1,
    onInteraction(action) {
      const request = decision.match(action);
      if (!request) throw new Error('Unexpected interaction');
      answered.resolve();
      return request.reply('yes');
    },
  });
  await expect(
    (await session.submit('Fail before any workspace effects.')).wait(),
  ).rejects.toBe(original);
  expect(effects).toEqual([]);
  expect(server.requests).toHaveLength(1);
}, 15000);

it('keeps mutations behind a held automatic handoff callback', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const effects: string[] = [];
  const original = new Error('fatal wrapped handoff callback');
  const route = tool({
    name: 'route',
    parameters: z.object({}),
    errorFunction: null,
    async execute() {
      entered.resolve();
      await release.promise;
      throw original;
    },
  });
  const server = new ModelServer([
    [shell('blocked'), call('route', {}, { callId: 'wrapped-route' })],
  ]);
  await using selected = await providerFor(server);
  const target = new Agent({ instructions: 'Target.' });
  const agent = new Agent({
    instructions: 'Source.',
    model: 'gpt-5',
    provider: selected,
    handoffs: [new Handoff(target, route)],
    tools: [
      shellTool({
        execute() {
          effects.push('shell');
          return shellOutput();
        },
      }),
    ],
  });
  await using session = await agent.session();
  const turn = await session.submit('Route before mutation.');
  const settled = turn.wait().then(
    () => undefined,
    (error: unknown) => error,
  );
  let effectsWhileHeld: string[] = [];
  try {
    await entered.promise;
    await new Promise((resolve) => setTimeout(resolve, 50));
    effectsWhileHeld = [...effects];
  } finally {
    release.resolve();
  }
  expect(await settled).toBe(original);
  expect(effectsWhileHeld).toEqual([]);
  expect(effects).toEqual([]);
  expect(server.requests).toHaveLength(1);
}, 15000);

it.each(['success', 'fatal'] as const)(
  'settles a held namespaced automatic callback before mutations (%s)',
  async (outcome) => {
    const entered = Promise.withResolvers<void>();
    const answered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const effects: string[] = [];
    const original = new Error('fatal namespaced callback');
    const decision = manualTool({
      name: 'decision',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      [
        shell('first'),
        patch('second'),
        call('hold', {}, { namespace: 'records', callId: 'held-function' }),
        call('decision', {}, { callId: 'manual' }),
      ],
      [message('done')],
    ]);
    await using selected = await providerFor(server);
    const edit = () => {
      effects.push('patch');
      return { output: 'done' };
    };
    const agent = new Agent({
      instructions: 'Use the supplied tools.',
      model: 'gpt-5',
      provider: selected,
      tools: [
        decision,
        tool({
          namespace: 'records',
          name: 'hold',
          parameters: z.object({}),
          errorFunction: null,
          async execute() {
            entered.resolve();
            await release.promise;
            if (outcome === 'fatal') throw original;
            effects.push('function');
            return 'done';
          },
        }),
        shellTool({
          execute() {
            effects.push('shell');
            return shellOutput();
          },
        }),
        applyPatchTool({
          editor: { createFile: edit, updateFile: edit, deleteFile: edit },
        }),
      ],
    });
    await using session = await agent.session({
      maxFunctionConcurrency: 1,
      async onInteraction(action) {
        const request = decision.match(action);
        if (!request) throw new Error('Unexpected interaction');
        await entered.promise;
        answered.resolve();
        return request.reply('yes');
      },
    });
    const result = (await session.submit('Run the mixed batch.')).wait().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let whileHeld: string[] = [];
    try {
      await Promise.race([
        Promise.all([entered.promise, answered.promise]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Manual sibling blocked')),
            1500,
          );
        }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      whileHeld = [...effects];
    } finally {
      if (timer) clearTimeout(timer);
      release.resolve();
    }
    const settled = await result;
    expect(whileHeld).toEqual([]);
    if (outcome === 'fatal') {
      expect('error' in settled && settled.error).toBe(original);
      expect(effects).toEqual([]);
      expect(server.requests).toHaveLength(1);
    } else {
      expect('value' in settled && settled.value.finalOutput).toBe('done');
      expect(effects).toEqual(['function', 'shell', 'patch']);
      server.assertExhausted();
    }
  },
  15000,
);
