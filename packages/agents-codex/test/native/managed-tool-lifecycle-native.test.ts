import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  ResponsesModel,
  isFunctionApprovalRequest,
  parseSessionState,
  tool,
  type ToolLifecycleEvent,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import { binding } from '../../src/runtime/binding';
import type { NativeThread } from '../../native/index';

afterEach(() => {
  vi.restoreAllMocks();
  return ModelServer.closeAll();
});

async function providerFor(server: ModelServer, borrowed = false) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-managed-lifecycle',
    supportsWebsockets: false,
    ...(borrowed
      ? {
          modelBackend: new ResponsesModel(
            new OpenAI({
              baseURL: (
                config['model_providers.fixture'] as { base_url: string }
              ).base_url,
              apiKey: 'synthetic-borrowed-lifecycle',
              maxRetries: 0,
            }),
            undefined,
            { stream: true },
          ),
        }
      : {}),
    requestMaxRetries: 0,
    streamMaxRetries: 0,
  });
}

it('orders run and source Agent callbacks around the admitted body with detached payloads', async () => {
  const events: string[] = [];
  const context = { owner: 'application' };
  let source: Agent<typeof context>;
  const agentHook = (event: ToolLifecycleEvent<typeof context>) => {
    expect(event.context).toBe(context);
    expect(event.agent).toBe(source);
    expect(event.tool.name).toBe('lookup');
    expect(event.callId).toBe('lookup-owner');
    expect(event.arguments).toEqual({ value: 'original' });
    events.push('agent:' + event.kind);
    if (event.kind === 'end') {
      expect(event.status).toBe('completed');
      expect(event.output?.contentItems).toEqual([
        { type: 'inputText', text: 'effect-result' },
      ]);
    }
  };
  const server = new ModelServer([
    [call('lookup', { value: 'original' }, { callId: 'lookup-owner' })],
    () => {
      expect(events).toEqual([
        'run:start',
        'agent:start',
        'body',
        'run:end',
        'agent:end',
      ]);
      return [message('done')];
    },
  ]);
  await using provider = await providerFor(server);
  const lookup = tool({
    name: 'lookup',
    description: 'Return a synthetic value.',
    parameters: z.object({ value: z.string() }),
    execute: ({ value }) => {
      expect(value).toBe('original');
      events.push('body');
      return 'effect-result';
    },
  });
  source = new Agent({
    name: 'source',
    provider,
    model: 'gpt-5.5',
    instructions: 'Use lookup.',
    tools: [lookup],
    onToolLifecycle: agentHook,
  });
  const result = await source.run('Go.', {
    context,
    onToolLifecycle(event) {
      expect(event.context).toBe(context);
      expect(event.agent).toBe(source);
      events.push('run:' + event.kind);
      (event.arguments as { value: string }).value = 'listener-local';
      if (event.output) event.output.contentItems.length = 0;
      // The synchronous listener contract never awaits a returned promise.
      return new Promise<void>(() => {});
    },
  });
  expect(result.finalOutput).toBe('done');
  expect(server.requests).toHaveLength(2);
});

it('propagates a start listener error before the body and later Agent listener', async () => {
  const events: string[] = [];
  let effects = 0;
  const failure = new Error('start policy failed');
  const server = new ModelServer([
    [call('lookup', {}, { callId: 'start-refused' })],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Use lookup.',
    tools: [
      tool({
        name: 'lookup',
        description: 'One physical effect.',
        parameters: z.object({}),
        execute: () => {
          effects++;
          return 'effect';
        },
      }),
    ],
    onToolLifecycle: (event) => {
      events.push('agent:' + event.kind);
    },
  });
  await using session = await agent.session({
    onToolLifecycle(event) {
      events.push('run:' + event.kind);
      throw failure;
    },
  });
  const turn = await session.submit('Go.');
  await expect(turn.wait()).rejects.toBe(failure);
  expect(events).toEqual(['run:start']);
  expect(effects).toBe(0);
  expect(server.requests).toHaveLength(1);
});

it.each(
  [false, true].flatMap((terminal) =>
    [false, true].map((borrowed) => ({ terminal, borrowed })),
  ),
)(
  'retains the performed typed result and blocks continuation (terminal=$terminal borrowed=$borrowed)',
  async ({ terminal, borrowed }) => {
    let effects = 0;
    const events: string[] = [];
    const failure = new Error('end policy failed');
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'end-refused' })],
    ]);
    await using provider = await providerFor(server, borrowed);
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Use lookup.',
      tools: [
        tool({
          name: 'lookup',
          description: 'One physical effect.',
          parameters: z.object({}),
          finishTurn: terminal,
          execute: () => {
            effects++;
            return 'physical-effect-117';
          },
        }),
      ],
      onToolLifecycle(event) {
        events.push('agent:' + event.kind);
        if (event.kind === 'end') throw failure;
      },
    });
    await using session = await agent.session();
    const turn = await session.submit('Go.');
    await expect(turn.wait()).rejects.toBe(failure);
    expect(effects).toBe(1);
    expect(events).toEqual(['agent:start', 'agent:end']);
    expect(server.requests).toHaveLength(1);
    const snapshot = await session.historySnapshot();
    const outputs = snapshot.items.filter((item) =>
      JSON.stringify(item).includes('physical-effect-117'),
    );
    expect(outputs).toHaveLength(1);
  },
);

it('does not emit body lifecycle events for malformed arguments', async () => {
  const events: string[] = [];
  let effects = 0;
  const server = new ModelServer([
    [call('lookup', { value: 42 }, { callId: 'bad-arguments' })],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Use lookup.',
    tools: [
      tool({
        name: 'lookup',
        description: 'One physical effect.',
        parameters: z.object({ value: z.string() }),
        execute: () => {
          effects++;
          return 'effect';
        },
      }),
    ],
    onToolLifecycle: (event) => {
      events.push(event.kind);
    },
  });
  await expect(agent.run('Go.')).rejects.toBeInstanceOf(z.ZodError);
  expect(events).toEqual([]);
  expect(effects).toBe(0);
});

it('keeps the issuing Agent snapshot across body mutation and subsequent handoff', async () => {
  const events: string[] = [];
  const context = { owner: 'handoff-context' };
  const server = new ModelServer([
    [call('lookup', {}, { callId: 'source-lookup' })],
    [call('transfer_to_target', {}, { callId: 'transfer-owner' })],
    [call('lookup', {}, { callId: 'target-lookup' })],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  let source: Agent<typeof context>;
  let effects = 0;
  const lookup = tool({
    name: 'lookup',
    parameters: z.object({}),
    execute: () => {
      effects++;
      source.onToolLifecycle = () => {
        throw new Error('late mutation');
      };
      return 'effect:' + effects;
    },
  });
  const target = new Agent<typeof context>({
    name: 'target',
    provider,
    model: 'gpt-5.5',
    instructions: 'Use lookup.',
    tools: [lookup],
    onToolLifecycle(event) {
      expect(event.agent).toBe(target);
      expect(event.context).toBe(context);
      events.push('target:' + event.kind);
    },
  });
  source = new Agent<typeof context>({
    name: 'source',
    provider,
    model: 'gpt-5.5',
    instructions: 'Transfer after lookup.',
    tools: [lookup],
    handoffs: [target],
    onToolLifecycle(event) {
      expect(event.agent).toBe(source);
      expect(event.context).toBe(context);
      events.push('source:' + event.kind);
    },
  });
  expect(
    (
      await source.run('Go.', {
        context,
        onToolLifecycle(event) {
          events.push('run:' + event.agent!.name + ':' + event.kind);
        },
      })
    ).finalOutput,
  ).toBe('done');
  expect(effects).toBe(2);
  expect(events).toEqual([
    'run:source:start',
    'source:start',
    'run:source:end',
    'source:end',
    'run:target:start',
    'target:start',
    'run:target:end',
    'target:end',
  ]);
});

it('inherits the run callback into a configured child with its real Agent and context', async () => {
  const context = { owner: 'configured-context' };
  const events: string[] = [];
  const parentModel = new ModelServer([
    [call('nested_child', { input: 'Use lookup.' }, { callId: 'child-owner' })],
    [message('parent done')],
  ]);
  const childModel = new ModelServer([
    [call('lookup', {}, { callId: 'inner-owner' })],
    [message('child done')],
  ]);
  await using parentProvider = await providerFor(parentModel);
  await using childProvider = await providerFor(childModel);
  let effects = 0;
  const child = new Agent<typeof context>({
    name: 'child',
    provider: childProvider,
    model: 'gpt-5.5',
    instructions: 'Use lookup.',
    tools: [
      tool({
        name: 'lookup',
        parameters: z.object({}),
        execute: () => {
          effects++;
          return 'effect';
        },
      }),
    ],
    onToolLifecycle(event) {
      expect(event.agent).toBe(child);
      expect(event.context).toBe(context);
      events.push('child:' + event.kind);
    },
  });
  const parent = new Agent<typeof context>({
    name: 'parent',
    provider: parentProvider,
    model: 'gpt-5.5',
    instructions: 'Use child.',
    tools: [child.asTool({ toolName: 'nested_child' })],
    onToolLifecycle(event) {
      expect(event.agent).toBe(parent);
      events.push('parent:' + event.kind);
    },
  });
  expect(
    (
      await parent.run('Go.', {
        context,
        onToolLifecycle(event) {
          expect(event.context).toBe(context);
          expect(event.agent === parent || event.agent === child).toBe(true);
          events.push('run:' + event.agent!.name + ':' + event.kind);
        },
      })
    ).finalOutput,
  ).toBe('parent done');
  expect(effects).toBe(1);
  expect(events).toEqual([
    'run:parent:start',
    'parent:start',
    'run:child:start',
    'child:start',
    'run:child:end',
    'child:end',
    'run:parent:end',
    'parent:end',
  ]);
});

it.each(['unformatted', 'formatted'] as const)(
  'preserves %s body failure semantics',
  async (mode) => {
    const failure = new Error('body rejected');
    const events: string[] = [];
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'failed-body' })],
      ...(mode === 'formatted' ? [[message('handled failure')]] : []),
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Use lookup.',
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          ...(mode === 'formatted'
            ? { errorFunction: () => 'safe failure' }
            : {}),
          execute: () => {
            throw failure;
          },
        }),
      ],
      onToolLifecycle(event) {
        events.push(event.kind + (event.status ? ':' + event.status : ''));
        if (event.kind === 'end') {
          expect(event.output?.success).toBe(false);
          expect(event.output?.contentItems).toEqual([
            { type: 'inputText', text: 'safe failure' },
          ]);
        }
      },
    });
    if (mode === 'formatted') {
      expect((await agent.run('Go.')).finalOutput).toBe('handled failure');
      expect(events).toEqual(['start', 'end:failed']);
    } else {
      await expect(agent.run('Go.')).rejects.toBe(failure);
      expect(events).toEqual(['start']);
    }
  },
);

it('joins one cancelled end event after an entered body aborts', async () => {
  const entered = Promise.withResolvers<void>();
  const controller = new AbortController();
  const events: string[] = [];
  let joined = false;
  const server = new ModelServer([
    [call('lookup', {}, { callId: 'cancelled-body' })],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Use lookup.',
    tools: [
      tool({
        name: 'lookup',
        parameters: z.object({}),
        execute: async (_args, context) => {
          try {
            await new Promise<void>((_resolve, reject) => {
              context.signal.addEventListener(
                'abort',
                () => reject(context.signal.reason),
                { once: true },
              );
              entered.resolve();
            });
            return 'unreachable';
          } finally {
            joined = true;
          }
        },
      }),
    ],
    onToolLifecycle(event) {
      events.push(event.kind + (event.status ? ':' + event.status : ''));
      if (event.kind === 'end') {
        expect(joined).toBe(true);
        expect(event.signal.aborted).toBe(true);
        expect(event.output).toBeUndefined();
      }
    },
  });
  const pending = agent.run('Go.', { signal: controller.signal });
  void pending.catch(() => {});
  await entered.promise;
  controller.abort(new Error('application cancellation'));
  await expect(pending).rejects.toBeDefined();
  expect(joined).toBe(true);
  expect(events).toEqual(['start', 'end:cancelled']);
  expect(server.requests).toHaveLength(1);
});

it.each(['complete', 'end-error', 'terminal-error'] as const)(
  'binds newly supplied lifecycle callbacks to a cold pending approval: %s',
  async (mode) => {
    const events: string[] = [];
    const context = { owner: 'current-context' };
    const failure = new Error('restored end policy failed');
    let effects = 0;
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'cold-managed-owner' })],
      ...(mode === 'complete' ? [[message('cold done')]] : []),
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent<typeof context>({
      provider,
      model: 'gpt-5.5',
      instructions: 'Use lookup.',
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          needsApproval: true,
          finishTurn: mode === 'terminal-error',
          execute: () => {
            effects++;
            return 'cold-effect-188';
          },
        }),
      ],
    });
    async function approval(session: {
      interactions(): AsyncIterable<unknown>;
    }) {
      for await (const request of session.interactions())
        if (isFunctionApprovalRequest(request)) return request;
      throw new Error('Missing current approval');
    }
    let serialized: string;
    {
      await using source = await agent.session({ context });
      const turn = await source.submit('Go.');
      void turn.wait().catch(() => {});
      await approval(source);
      expect(effects).toBe(0);
      serialized = JSON.stringify(await source.suspend());
    }
    const state = parseSessionState(serialized, {
      expectedSha256: createHash('sha256').update(serialized).digest('hex'),
    });
    await using restored = await agent.session({
      state,
      context,
      onToolLifecycle(event) {
        expect(event.agent).toBe(agent);
        expect(event.context).toBe(context);
        expect(event.callId).toBe('cold-managed-owner');
        events.push(event.kind);
        if (mode !== 'complete' && event.kind === 'end') throw failure;
      },
    });
    const request = await approval(restored);
    expect(events).toEqual([]);
    expect(effects).toBe(0);
    const done = restored.restoredTurn!.wait();
    void done.catch(() => {});
    await restored.respond(request.approve());
    if (mode !== 'complete') await expect(done).rejects.toBe(failure);
    else expect((await done).finalOutput).toBe('cold done');
    expect(effects).toBe(1);
    expect(events).toEqual(['start', 'end']);
    expect(server.requests).toHaveLength(mode === 'complete' ? 2 : 1);
    let retainedOutputs: unknown[] | undefined;
    await expect
      .poll(
        async () => {
          try {
            retainedOutputs = (await restored.historySnapshot()).items.filter(
              (item) => JSON.stringify(item).includes('cold-effect-188'),
            );
            return retainedOutputs.length === 1;
          } catch (error) {
            if (
              error instanceof Error &&
              /requires a settled open session/.test(error.message)
            )
              return false;
            throw error;
          }
        },
        { timeout: 3000 },
      )
      .toBe(true);
    expect(retainedOutputs).toHaveLength(1);
  },
);

it('refuses early native publication before the current reply is accepted and after its owner retires', async () => {
  const NativeThreadClass = (await binding()).NativeThread;
  const current = NativeThreadClass.prototype._manual_tool_current;
  const owners: NativeThread[] = [];
  vi.spyOn(
    NativeThreadClass.prototype,
    '_manual_tool_current',
  ).mockImplementation(function (
    this: NativeThread,
    ...args: Parameters<typeof current>
  ) {
    owners.push(this);
    return current.apply(this, args);
  });
  const server = new ModelServer([
    [call('lookup', {}, { callId: 'private-publication-owner' })],
  ]);
  await using provider = await providerFor(server);
  let effects = 0;
  const agent = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Use lookup.',
    tools: [
      tool({
        name: 'lookup',
        parameters: z.object({}),
        needsApproval: true,
        finishTurn: true,
        execute: () => {
          effects++;
          return 'flag-control-effect';
        },
      }),
    ],
  });
  async function approval(session: { interactions(): AsyncIterable<unknown> }) {
    for await (const request of session.interactions())
      if (isFunctionApprovalRequest(request)) return request;
    throw new Error('Missing current approval');
  }
  let serialized: string;
  {
    await using source = await agent.session();
    const turn = await source.submit('Go.');
    void turn.wait().catch(() => {});
    await approval(source);
    serialized = JSON.stringify(await source.suspend());
  }
  const state = parseSessionState(serialized, {
    expectedSha256: createHash('sha256').update(serialized).digest('hex'),
  });
  await using restored = await agent.session({ state });
  const request = await approval(restored);
  const reply = request.approve();
  const native = owners.at(-1)!;
  expect(native).toBeDefined();
  await expect(
    native._complete_manual_continuation(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      true,
    ),
  ).rejects.toThrow();
  expect(effects).toBe(0);
  expect(server.requests).toHaveLength(1);
  await restored.respond(reply);
  expect((await restored.restoredTurn!.wait()).finalOutput).toBe(
    'flag-control-effect',
  );
  expect(effects).toBe(1);
  await expect(
    native._complete_manual_continuation(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      true,
    ),
  ).rejects.toThrow();
  expect(effects).toBe(1);
  expect(server.requests).toHaveLength(1);
});

it.each([false, true])(
  'publishes only the fresh accepted reply beside a serialized terminal sibling (laterTerminal=%s)',
  async (laterTerminal) => {
    const failure = new Error('mixed current end observer failed');
    const effects: string[] = [];
    const server = new ModelServer([
      [
        call('current', {}, { callId: 'current-mixed' }),
        call('earlier', {}, { callId: 'earlier-mixed' }),
      ],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Run both tools.',
      tools: [
        tool({
          name: 'current',
          parameters: z.object({}),
          needsApproval: true,
          finishTurn: laterTerminal,
          execute: () => {
            effects.push('current');
            return 'CURRENT_LIVE_ACCEPTED_RESULT';
          },
        }),
        tool({
          name: 'earlier',
          parameters: z.object({}),
          finishTurn: true,
          execute: () => {
            effects.push('earlier');
            return 'SERIALIZED_EARLIER_TERMINAL_RESULT';
          },
        }),
      ],
    });
    async function approval(session: {
      interactions(): AsyncIterable<unknown>;
    }) {
      for await (const request of session.interactions())
        if (isFunctionApprovalRequest(request)) return request;
      throw Error('Missing mixed current approval');
    }
    let serialized: string;
    {
      await using source = await agent.session();
      const turn = await source.submit('Go.');
      void turn.wait().catch(() => {});
      await approval(source);
      serialized = JSON.stringify(await source.suspend());
    }
    expect(effects).toEqual(['earlier']);
    const raw = JSON.parse(serialized);
    expect(JSON.stringify(raw.manual_continuation)).toContain(
      'SERIALIZED_EARLIER_TERMINAL_RESULT',
    );
    const state = parseSessionState(serialized, {
      expectedSha256: createHash('sha256').update(serialized).digest('hex'),
    });
    await using restored = await agent.session({
      state,
      onToolLifecycle(event) {
        expect(event.callId).toBe('current-mixed');
        if (event.kind === 'end') throw failure;
      },
    });
    const request = await approval(restored);
    const done = restored.restoredTurn!.wait();
    void done.catch(() => {});
    await restored.respond(request.approve());
    await expect(done).rejects.toBe(failure);
    expect(effects).toEqual(['earlier', 'current']);
    expect(server.requests).toHaveLength(1);
    let rows: readonly unknown[] = [];
    await expect
      .poll(
        async () => {
          try {
            rows = (await restored.historySnapshot()).items;
            return rows.some((item) =>
              JSON.stringify(item).includes('CURRENT_LIVE_ACCEPTED_RESULT'),
            );
          } catch (error) {
            if (
              error instanceof Error &&
              /requires a settled open session/.test(error.message)
            )
              return false;
            throw error;
          }
        },
        { timeout: 3000 },
      )
      .toBe(true);
    expect(
      rows.filter((item) =>
        JSON.stringify(item).includes('CURRENT_LIVE_ACCEPTED_RESULT'),
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(
      'SERIALIZED_EARLIER_TERMINAL_RESULT',
    );
  },
);
