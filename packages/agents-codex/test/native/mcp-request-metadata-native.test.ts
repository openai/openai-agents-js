import type { NativeThread, JsonObject } from '../../src/runtime/binding';
import { inspect } from 'node:util';
import { z } from 'zod';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  Agent,
  NativeProvider,
  Environment,
  NativeAgents,
  NativeError,
  StdioMCP,
  tool,
  type FunctionTool,
  type Session,
  type MCPMetadataContext,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

let directory: string;
const sessions: Session[] = [];
const providers: NativeProvider[] = [];
beforeEach(async () => {
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-metadata');
  directory = await mkdtemp(join(tmpdir(), 'agents-mcp-metadata-'));
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await Promise.all(providers.splice(0).map((p) => p.close()));
  await ModelServer.closeAll();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function setup(
  resolver: (ctx: MCPMetadataContext) => unknown,
  inCode = false,
  policies = false,
  state?: Awaited<ReturnType<Session['saveState']>>,
  profile?: 'root' | 'destination',
  enteredTool?: FunctionTool,
  family?: {
    environment: Environment;
    responses: ConstructorParameters<typeof ModelServer>[0];
  },
  metadataArguments?: JsonObject,
) {
  const roster = join(directory, 'roster.json'),
    calls = join(directory, 'calls.jsonl'),
    starts = join(directory, 'starts.jsonl');
  await Promise.all([
    writeFile(calls, ''),
    writeFile(starts, ''),
    writeFile(
      roster,
      JSON.stringify({
        tools: [
          {
            name: 'lookup',
            annotations: { readOnlyHint: true },
            inputSchema: {
              type: 'object',
              properties: { key: { type: 'string' } },
              required: ['key'],
            },
          },
        ],
        result: { content: [{ type: 'text', text: 'record' }] },
      }),
    ),
  ]);
  const order: string[] = [];
  const declaration = new StdioMCP({
    name: 'fixture',
    tools: ['lookup'],
    approvalMode: 'preapproved',
    // Child settlement uses the selected executor's actual stdio peer.
    ...(family ? { location: 'environment' as const } : {}),
    command: process.execPath,
    args: [resolve(import.meta.dirname, 'mcp-peer.mjs'), roster, calls, starts],
    ...(policies
      ? {
          before: () => {
            order.push('before');
            return {
              action: 'replaceArguments' as const,
              arguments: { key: 'effective' },
            };
          },
          approval: () => {
            order.push('approval');
            return true;
          },
        }
      : {}),
    requestMetadata: async (ctx) => {
      order.push('metadata');
      return (await resolver(ctx)) as never;
    },
  });
  const first = inCode
    ? {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'metadata-call',
        input: metadataArguments
          ? `text(await tools.mcp__fixture__lookup(JSON.parse(${JSON.stringify(JSON.stringify(metadataArguments))})));`
          : 'text(await tools.mcp__fixture__lookup({key:"original"}));',
      }
    : call('lookup', metadataArguments ?? { key: 'original' }, {
        callId: 'metadata-call',
        namespace: 'mcp__fixture',
      });
  const model = new ModelServer(
    family?.responses ?? [
      ...(profile === 'destination'
        ? [[call('transfer_to_b', {}, { callId: 'metadata-transfer' })]]
        : []),
      [
        ...(enteredTool
          ? [call(enteredTool.name, {}, { callId: 'held-callback' })]
          : []),
        first,
      ],
      [message('done')],
    ],
  );
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
  providers.push(provider);
  const target = profile
    ? new Agent({
        name: 'B',
        instructions: 'Read in B.',
        model: family
          ? 'gpt-5.6-terra'
          : profile === 'destination'
            ? 'gpt-5.5'
            : 'gpt-5',
        provider,
        tools: profile === 'destination' ? [declaration] : [],
      })
    : undefined;
  const agent = new Agent({
    name: 'A',
    instructions: 'Read the record.',
    model: family
      ? 'gpt-5.6-terra'
      : profile === 'destination'
        ? 'gpt-5.5'
        : 'gpt-5',
    provider,
    programmaticToolCalling: inCode,
    tools:
      profile === 'destination'
        ? []
        : [
            declaration,
            ...(enteredTool ? [enteredTool] : []),
            ...(family ? [new NativeAgents()] : []),
          ],
    ...(target ? { handoffs: [target] } : {}),
  });
  const session = await agent.session(
    family
      ? { environment: family.environment, ...(state ? { state } : {}) }
      : state
        ? { state }
        : undefined,
  );
  sessions.push(session);
  return { session, model, order, calls, agent };
}
async function records(path: string) {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((s) => JSON.parse(s));
}
it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  'metadata proof code=%s reserved=%s',
  async (inCode, reserved) => {
    const secret = 'private-metadata-3174';
    const contexts: MCPMetadataContext[] = [];
    const { session, model, order, calls } = await setup(
      (ctx) => {
        contexts.push(ctx);
        expect(ctx.arguments).toEqual({ key: 'effective' });
        return {
          'app/default': 'base',
          [reserved ? 'callId' : 'app/current']: secret,
        };
      },
      inCode,
      true,
    );
    const turn = await session.submit('read');
    if (reserved) {
      await expect(turn.wait()).rejects.toThrow(/Native MCP/);
      expect(model.requests).toHaveLength(1); // Invalid metadata fences native sampling before continuation.
    } else expect((await turn.wait()).finalOutput).toBe('done');
    const actual = await records(calls);
    expect(actual).toHaveLength(reserved ? 0 : 1);
    expect(order).toEqual(['before', 'approval', 'metadata']);
    expect(contexts).toHaveLength(1);
    if (!reserved) {
      expect(actual[0].arguments).toEqual({ key: 'effective' });
      expect(actual[0]._meta['app/current']).toBe(secret);
      expect(actual[0]._meta.callId).not.toBe(secret);
    }
    expect(JSON.stringify(model.requests)).not.toContain(secret);
    if (process.env.MCP_METADATA_EVIDENCE)
      await writeFile(
        join(
          process.env.MCP_METADATA_EVIDENCE,
          `code-${inCode}-reserved-${reserved}.json`,
        ),
        JSON.stringify(
          { requests: model.requests, toolCalls: actual, callbackOrder: order },
          null,
          2,
        ),
      );
  },
  20_000,
);

it.each([false, true])(
  'preserves literal prototype keys in effective metadata arguments code=%s',
  async (inCode) => {
    const arguments_ = JSON.parse(
      '{"key":"original","__proto__":{"metadataTop":true},"nested":{"__proto__":{"metadataNested":true},"constructor":{"prototype":"data"}}}',
    ) as JsonObject;
    const contexts: MCPMetadataContext[] = [];
    const { session, model, calls } = await setup(
      (ctx) => {
        contexts.push(ctx);
        return { 'app/argument-digest': JSON.stringify(ctx.arguments) };
      },
      inCode,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      arguments_,
    );
    expect((await (await session.submit('read')).wait()).finalOutput).toBe(
      'done',
    );
    expect(contexts).toHaveLength(1);
    const actual = await records(calls);
    expect(actual).toHaveLength(1);
    const captured = contexts[0].arguments;
    expect(Object.hasOwn(captured, '__proto__')).toBe(true);
    expect(Object.hasOwn(captured.nested as JsonObject, '__proto__')).toBe(
      true,
    );
    expect(captured).toEqual(arguments_);
    expect(actual[0].arguments).toEqual(arguments_);
    expect(actual[0]._meta['app/argument-digest']).toBe(
      JSON.stringify(actual[0].arguments),
    );
    expect(Object.getPrototypeOf(captured)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(captured.nested)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty('metadataTop');
    expect(Object.prototype).not.toHaveProperty('metadataNested');
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests)).not.toContain('app/argument-digest');
    model.assertExhausted();
  },
  20_000,
);

const RESERVED = [
  'callId',
  'x-codex-turn-metadata',
  '_codex_apps',
  'plugin_id',
  'openai/confirmation_policies',
  'threadId',
  'sessionId',
  'windowId',
  'itemId',
  'codex/sandbox-state-meta',
  'codex_bridge_mcp_call_id',
  'openai/entitlementContext',
  'openai/readOnly',
  'traceparent',
  'tracestate',
  'progressToken',
];
it.each([undefined, null, {}, { 'app/value': [null, true, 2, 'ok'] }])(
  'metadata optional JSON value %j',
  async (value) => {
    let seen = 0;
    const { session, model, calls } = await setup(() => {
      seen++;
      return value;
    });
    expect((await (await session.submit('read')).wait()).finalOutput).toBe(
      'done',
    );
    const actual = await records(calls);
    expect(actual).toHaveLength(1);
    expect(typeof actual[0]._meta.callId).toBe('string');
    expect(seen).toBe(1);
    expect(model.requests).toHaveLength(2);
  },
);
it.each([
  ...RESERVED,
  'array',
  'nan',
  'infinity',
  'bigint',
  'function',
  'oversized',
  'exception',
])(
  'invalid metadata %s never dispatches',
  async (kind) => {
    const secret = 'private-error-payload-9219';
    const { session, model, calls } = await setup(() => {
      if (kind === 'exception') throw new Error(secret);
      if (kind === 'array') return [];
      if (kind === 'nan') return { 'app/value': NaN };
      if (kind === 'infinity') return { 'app/value': Infinity };
      if (kind === 'bigint') return { 'app/value': 1n };
      if (kind === 'function') return { 'app/value': () => secret };
      if (kind === 'oversized')
        return { 'app/value': 'x'.repeat(1024 * 1024 + 1) };
      return { [kind]: secret };
    });
    const failure = await (
      await session.submit('read')
    )
      .wait()
      .catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(secret);
    expect(await records(calls)).toEqual([]);
    // Every rejected metadata result fences sampling before the answer request.
    expect(model.requests).toHaveLength(1);
    expect(JSON.stringify(model.requests)).not.toContain(secret);
  },
  20_000,
);
it('restore selects the fresh declaration and never replays accepted metadata/effects', async () => {
  const old = await setup(() => ({ 'app/owner': 'old-private-metadata-9218' }));
  expect((await (await old.session.submit('old')).wait()).finalOutput).toBe(
    'done',
  );
  expect(await records(old.calls)).toHaveLength(1);
  const saved = await old.session.saveState();
  expect(JSON.stringify(saved)).not.toContain('old-private-metadata-9218');
  await old.session.close();
  let seen = 0;
  const fresh = await setup(
    () => {
      seen++;
      return { 'app/owner': 'fresh-private-metadata-9218' };
    },
    false,
    false,
    saved,
  );
  expect(await records(fresh.calls)).toEqual([]);
  expect((await (await fresh.session.submit('fresh')).wait()).finalOutput).toBe(
    'done',
  );
  const actual = await records(fresh.calls);
  expect(actual).toHaveLength(1);
  expect(actual[0]._meta['app/owner']).toBe('fresh-private-metadata-9218');
  expect(seen).toBe(1);
  expect(JSON.stringify(fresh.model.requests)).not.toContain(
    'private-metadata-9218',
  );
}, 20_000);
it.each([false, true])(
  'close joins held metadata code=%s and never publishes its late return',
  async (inCode) => {
    let entered!: () => void, release!: () => void;
    let returned = false;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    const { session, calls } = await setup(async () => {
      entered();
      await held;
      returned = true;
      return { 'app/owner': 'late' };
    }, inCode);
    const turn = await session.submit('read');
    const observed = turn.wait().catch((error) => error);
    await started;
    let finished = false;
    const closing = session.close().then(() => {
      finished = true;
    });
    // The callback's physical promise is still held; release it after close starts.
    await Promise.resolve();
    expect(returned).toBe(false);
    expect(finished).toBe(false);
    release();
    await closing;
    await observed;
    expect(returned).toBe(true);
    expect(await records(calls)).toEqual([]);
  },
  20_000,
);

it.each(['root', 'destination'] as const)(
  'retains metadata selection for captured %s profile',
  async (profile) => {
    const contexts: MCPMetadataContext[] = [];
    const secret = 'private-profile-metadata';
    const { session, model, order, calls } = await setup(
      (ctx) => {
        contexts.push(ctx);
        return { 'app/profile': secret };
      },
      false,
      false,
      undefined,
      profile,
    );
    const turn = await session.submit('Read.');
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(contexts).toHaveLength(1);
    expect(contexts[0].submission).toBe(turn);
    expect(order).toEqual(['metadata']);
    const actual = await records(calls);
    expect(actual).toHaveLength(1);
    expect(actual[0]._meta['app/profile']).toBe(secret);
    expect(model.requests).toHaveLength(profile === 'destination' ? 3 : 2);
    expect(JSON.stringify(model.requests)).not.toContain(secret);
    expect(JSON.stringify(await session.saveState())).not.toContain(secret);
    model.assertExhausted();
  },
  30000,
);

it.each(['throw', 'reserved'] as const)(
  'fences failed metadata before continuation and joins entered SDK work (%s)',
  async (mode) => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const privateFailure = new Error('owned private metadata callback failure');
    let effects = 0;
    const held = tool({
      name: 'held',
      parameters: z.object({}),
      async execute(_args, context) {
        context.signal.addEventListener('abort', () => aborted.resolve(), {
          once: true,
        });
        entered.resolve();
        await release.promise;
        effects += 1;
        return 'must-not-publish-held-result';
      },
    });
    const { session, model, calls } = await setup(
      async () => {
        await entered.promise;
        if (mode === 'throw') throw privateFailure;
        return { 'codex/sandbox-state-meta': privateFailure.message };
      },
      false,
      false,
      undefined,
      undefined,
      held,
    );
    const turn = await session.submit('Read.');
    const completed = (async () => {
      let found = false;
      for await (const event of turn.events()) {
        if (event.type === 'turn_finished' && event.status === 'completed')
          found = true;
      }
      return found;
    })();
    let settled = false;
    const result = turn
      .wait()
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      await aborted.promise;
      expect(settled).toBe(false);
      expect(effects).toBe(0);
      expect(await records(calls)).toEqual([]);
      expect(model.requests).toHaveLength(1);
    } finally {
      release.resolve();
    }
    const outcome = await result;
    const observedError = 'error' in outcome ? outcome.error : undefined;
    expect(observedError).toBeInstanceOf(NativeError);
    expect(observedError).toMatchObject({
      message: 'Native MCP result policy failed',
    });
    await expect(turn.wait()).rejects.toBe(observedError);
    expect(effects).toBe(1);
    expect(await completed).toBe(false);
    const saved = JSON.stringify(await session.saveState());
    expect(saved).not.toContain('must-not-publish-held-result');
    expect(saved).not.toContain(privateFailure.message);
    expect(JSON.stringify(model.requests)).not.toContain(
      privateFailure.message,
    );
    const successor = await session.submit('Continue explicitly.');
    expect((await successor.wait()).finalOutput).toBe('done');
    expect(model.requests).toHaveLength(2);
    model.assertExhausted();
  },
  30000,
);

it('redacts late metadata callback errors while cancellation joins entered work', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const secret = 'private-metadata-cleanup-error';
  const { session, model, calls } = await setup(async () => {
    entered.resolve();
    await release.promise;
    throw new Error(secret);
  });
  const { binding } = await import('../../src/runtime/binding');
  const { NativeThread: Thread } = await binding();
  const requestStop = Thread.prototype._request_graph_stop;
  const observers: Array<{ mockRestore(): void }> = [];
  const requestedStops: Array<{ scope: string; mode: string }> = [];
  let settlementEntered = false;
  let nativeSettled = false;
  observers.push(
    vi
      .spyOn(Thread.prototype, '_request_graph_stop')
      .mockImplementation(function (this: NativeThread, scope, mode) {
        const receipt = requestStop.call(this, scope, mode);
        const settle = receipt.settle.bind(receipt);
        observers.push(
          vi.spyOn(receipt, 'settle').mockImplementation(() => {
            const pending = settle();
            settlementEntered = true;
            return pending.then((value) => {
              nativeSettled = true;
              return value;
            });
          }),
        );
        requestedStops.push({ scope, mode });
        return receipt;
      }),
  );
  const turn = await session.submit('Read.');
  let resultSettled = false;
  const result = turn
    .wait()
    .catch((error: unknown) => error)
    .finally(() => {
      resultSettled = true;
    });
  let cancellation: Promise<unknown> | undefined;
  let settled = false;
  try {
    await entered.promise;
    cancellation = turn
      .cancel()
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(settlementEntered).toBe(true));
    expect(requestedStops).toEqual([{ scope: 'root', mode: 'force' }]);
    await vi.waitFor(() => expect(nativeSettled).toBe(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(resultSettled).toBe(false);
    expect(await records(calls)).toEqual([]);
    expect(model.requests).toHaveLength(1);
  } finally {
    release.resolve();
    for (const observer of observers.reverse()) observer.mockRestore();
  }
  expect(inspect(await result, { depth: 12 })).not.toContain(secret);
  expect(inspect(await cancellation, { depth: 12 })).not.toContain(secret);
  const cleanup = await session.close().catch((error: unknown) => error);
  expect(inspect(cleanup, { depth: 12 })).not.toContain(secret);
  const index = sessions.indexOf(session);
  if (index >= 0) sessions.splice(index, 1);
}, 30000);

it('keeps child metadata ownership across parent completion and rejects before dispatch', async () => {
  const { startPublicExecutor } = await import('./fixtures/public-executor');
  const executor = await startPublicExecutor();
  const heldEntered = Promise.withResolvers<void>();
  const releaseHeld = Promise.withResolvers<void>();
  const releaseMetadata = Promise.withResolvers<void>();
  const releaseRoot = Promise.withResolvers<void>();
  const contexts: MCPMetadataContext[] = [];
  let effects = 0;
  let selectedSession: Session | undefined;
  let rootId: string | undefined;
  let rootRequests = 0;
  let childRequests = 0;
  try {
    const held = tool({
      name: 'held',
      parameters: z.object({}),
      async execute() {
        heldEntered.resolve();
        await releaseHeld.promise;
        effects += 1;
        return 'completed-child-held-result';
      },
    });
    const respond = async (request: Record<string, any>) => {
      const id = JSON.parse(request.client_metadata['x-codex-turn-metadata'])
        .thread_id as string;
      rootId ??= id;
      if (id === rootId) {
        if (++rootRequests === 1)
          return [
            call(
              'spawn_agent',
              { task_name: 'metadata_child', message: 'Read.' },
              { namespace: 'collaboration', callId: 'metadata-child-spawn' },
            ),
          ];
        await releaseRoot.promise;
        return [message('root done')];
      }
      childRequests += 1;
      return [
        call('held', {}, { callId: 'child-held' }),
        call(
          'lookup',
          { key: 'original' },
          { namespace: 'mcp__fixture', callId: 'child-metadata' },
        ),
      ];
    };
    const { session, model, calls } = await setup(
      async (ctx) => {
        contexts.push(ctx);
        await releaseMetadata.promise;
        return {
          'codex/sandbox-state-meta': 'private-child-rejected-metadata',
        };
      },
      false,
      false,
      undefined,
      undefined,
      held,
      {
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
        responses: Array.from({ length: 3 }, () => respond),
      },
    );
    selectedSession = session;
    const root = await session.submit('Delegate.');
    let rootSettled = false;
    const rootResult = root.wait().then((value) => {
      rootSettled = true;
      return value;
    });
    await heldEntered.promise;
    // This route serializes the calls. Complete held before waiting for metadata.
    releaseHeld.resolve();
    await vi.waitFor(() => expect(contexts).toHaveLength(1), {
      timeout: 10000,
    });
    const captured = contexts[0];
    expect(rootSettled).toBe(false);
    expect(effects).toBe(1);
    expect(await records(calls)).toEqual([]);
    // Parent completion must neither retire nor rebind its child's captured callback.
    releaseRoot.resolve();
    expect((await rootResult).finalOutput).toBe('root done');
    const children = await vi.waitUntil(
      async () => {
        const values = await Array.fromAsync(session.subagents());
        return values.length === 1 && values[0].turn ? values : false;
      },
      { timeout: 10000 },
    );
    const child = children[0];
    let settled = false;
    const result = child
      .turn!.wait()
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    expect(captured.call).toMatchObject({
      sessionId: session.id,
      childId: child.id,
      turnId: child.turn!.turnId,
      callId: 'child-metadata',
      tool: { name: 'lookup', namespace: 'mcp__fixture' },
      route: 'direct',
    });
    expect(captured.call.childIncarnation).toEqual(expect.any(String));
    expect(captured.arguments).toEqual({ key: 'original' });
    expect(contexts).toEqual([captured]);
    expect(settled).toBe(false);
    expect(await records(calls)).toEqual([]);
    expect(rootRequests).toBe(2);
    expect(childRequests).toBe(1);
    releaseMetadata.resolve();
    expect(await result).toBeInstanceOf(NativeError);
    expect(await result).toMatchObject({
      message: 'Native MCP result policy failed',
    });
    expect((await root.wait()).finalOutput).toBe('root done');
    expect(await records(calls)).toEqual([]);
    expect(effects).toBe(1);
    expect(contexts).toEqual([captured]);
    expect(rootRequests).toBe(2);
    expect(childRequests).toBe(1);
    expect(JSON.stringify(model.requests)).not.toContain(
      'private-child-rejected-metadata',
    );
    model.assertExhausted();
  } finally {
    releaseHeld.resolve();
    releaseMetadata.resolve();
    releaseRoot.resolve();
    try {
      await selectedSession?.close();
    } finally {
      await executor.close();
    }
  }
}, 30000);
