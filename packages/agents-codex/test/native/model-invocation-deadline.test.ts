/** Real native model deadline tests. Peers control I/O, never fabricate native results. */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeError,
  NativeProvider,
  fileSessionStore,
  type ModelSettings,
  type SessionState,
  type SessionStore,
  tool,
} from '../../src';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

const MODEL_MS = 1_000;
const CALLBACK_MS = 2_000;
const USAGE = { input_tokens: 11, output_tokens: 3, total_tokens: 14 };
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
function gate() {
  return {
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  };
}
function track<T>(promise: Promise<T>) {
  let done = false;
  const outcome = promise
    .then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    )
    .finally(() => {
      done = true;
    });
  return { outcome, done: () => done };
}
async function expectDeadline<T>(pending: ReturnType<typeof track<T>>) {
  const { error } = await pending.outcome;
  expect(error).toBeInstanceOf(NativeError);
  const native = error as NativeError;
  expect(native.code).toBe('model_invocation_deadline_exceeded');
  expect(native.category).toBe('model_invocation_deadline_exceeded');
  expect(native.retryable).toBe(false);
  expect(native.retryAfterMs).toBeNull();
  return native;
}
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-deadline-key',
    supportsWebsockets: false,
  });
}
function latestSettings(saved: SessionState) {
  const snapshot = JSON.parse(JSON.stringify(saved)) as {
    sourceSessionId?: string;
    source_session_id?: string;
    history: Array<{ type: string; payload?: Record<string, any> }>;
  };
  const rows = snapshot.history.filter(
    (row) =>
      row.type === 'event_msg' &&
      row.payload?.type === 'thread_settings_applied',
  );
  expect(rows.length).toBeGreaterThan(0);
  return rows.at(-1)!.payload!.thread_settings as Record<string, unknown>;
}

it.each([null, 1, 4_294_967_295])(
  'captures and restores native deadline=%s; null clears',
  async (value) => {
    // API-SET/API-CAPTURE/API-RESTORE: accepted Core settings and actual reopen.
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const settings: ModelSettings = { invocationTimeoutMs: value };
    const agent = new Agent({
      instructions: 'Answer.',
      provider,
      modelSettings: settings,
    });
    settings.invocationTimeoutMs = 999;
    let saved: SessionState;
    {
      await using session = await agent.session();
      saved = await session.saveState();
      expect(latestSettings(saved).invocation_timeout_ms ?? null).toBe(value);
      await session.update({ modelSettings: { invocationTimeoutMs: null } });
      expect(
        latestSettings(await session.saveState()).invocation_timeout_ms ?? null,
      ).toBeNull();
    }
    {
      await using restored = await agent.session({ state: saved });
      expect(
        latestSettings(await restored.saveState()).invocation_timeout_ms ??
          null,
      ).toBe(value);
    }
    expect(server.requests).toHaveLength(0);
  },
);

it.each([0, -1, true, false, 1.5, NaN, Infinity, 4_294_967_296, '1'])(
  'rejects invalid invocationTimeoutMs=%s before dispatch',
  async (value) => {
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    await expect(
      (async () => {
        const agent = new Agent({
          instructions: 'Answer.',
          provider,
          modelSettings: {
            invocationTimeoutMs: value,
          } as unknown as ModelSettings,
        });
        await using session = await agent.session();
        expect(session).toBeDefined();
      })(),
    ).rejects.toThrow(/invocationTimeoutMs/);
    expect(server.requests).toHaveLength(0);
  },
);

it.each(['headers', 'body'] as const)(
  'expires held %s without another model request',
  async (phase) => {
    // HTTP-HEAD/HTTP-BODY/DEADLINE-FIRST: inspect actual wire requests and late output.
    const held = gate();
    const server = new ModelServer(
      [
        async () => {
          if (phase === 'headers') {
            held.entered.resolve();
            await held.release.promise;
          }
          return [message('late-must-not-win')];
        },
      ],
      USAGE,
      async () => {
        if (phase === 'body') {
          held.entered.resolve();
          await held.release.promise;
        }
      },
    );
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Answer.',
      provider,
      modelSettings: { invocationTimeoutMs: MODEL_MS },
    });
    await using session = await agent.session();
    const result = track((await session.submit('one')).wait());
    try {
      await held.entered.promise;
      await expectDeadline(result);
      const recorded = await Array.fromAsync(session.turns());
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        status: 'failed',
        error: { code: 'model_invocation_deadline_exceeded' },
      });
      await using restored = await agent.session({
        state: await session.saveState(),
      });
      expect((await Array.fromAsync(restored.turns()))[0].error).toEqual(
        recorded[0].error,
      );
      expect(server.requests).toHaveLength(1);
      expect(server.completedFrames).toHaveLength(0);
    } finally {
      held.release.resolve();
    }
  },
);

it('continuous response progress cannot reset the absolute allowance', async () => {
  // HTTP-BODY: several real output frames arrive; the terminal remains unaccepted.
  const stop = Promise.withResolvers<void>();
  let sent = 0;
  const server = new ModelServer(
    [Array.from({ length: 100 }, (_, n) => message(`partial-${n}`))],
    USAGE,
    async () => {
      await Promise.race([delay(20), stop.promise]);
      sent++;
    },
  );
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
    modelSettings: { invocationTimeoutMs: MODEL_MS },
  }).session();
  try {
    await expectDeadline(track((await session.submit('stream')).wait()));
    expect(sent).toBeGreaterThanOrEqual(2);
    expect(server.completedFrames).toHaveLength(0);
    expect(server.requests).toHaveLength(1);
  } finally {
    stop.resolve();
  }
});

it('omission preserves a held invocation and busy settings updates reject', async () => {
  // NONE-CONTROL/API-CAPTURE. The harness does not cancel the observer during its wait.
  const held = gate();
  const server = new ModelServer([
    async () => {
      held.entered.resolve();
      await held.release.promise;
      return [message('finished')];
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
  }).session();
  const result = track((await session.submit('one')).wait());
  try {
    await held.entered.promise;
    await delay(MODEL_MS * 2);
    expect(result.done()).toBe(false);
    await expect(
      session.update({ modelSettings: { invocationTimeoutMs: MODEL_MS } }),
    ).rejects.toThrow();
  } finally {
    held.release.resolve();
  }
  expect((await result.outcome).value?.finalOutput).toBe('finished');
  server.assertExhausted();
});

it('earlier user cancellation stays cancellation', async () => {
  const held = gate();
  const server = new ModelServer([
    async () => {
      held.entered.resolve();
      await held.release.promise;
      return [message('late')];
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
    modelSettings: { invocationTimeoutMs: 60_000 },
  }).session();
  const turn = await session.submit('one');
  const result = track(turn.wait());
  try {
    await held.entered.promise;
    await turn.cancel();
    const { error } = await result.outcome;
    expect(error).toBeDefined();
    expect((error as NativeError).code).not.toBe(
      'model_invocation_deadline_exceeded',
    );
  } finally {
    held.release.resolve();
  }
  expect(server.requests).toHaveLength(1);
});

it('expiry denies queued validators and waits for the entered callback', async () => {
  // CAP-QUEUE/CAP-CLEANUP/CLOSE: real automatic-only native parallel dispatch.
  const body = gate();
  const terminal = gate();
  const validated: number[] = [],
    hooks: number[] = [],
    effects: number[] = [];
  const addon = await binding();
  const original = addon.NativeThread.prototype._check_python_tool;
  const requests = new Map<string, { thread: NativeThread; raw: string }>();
  vi.spyOn(
    addon.NativeThread.prototype,
    '_check_python_tool',
  ).mockImplementation(function (this: NativeThread, raw) {
    requests.set(raw, { thread: this, raw });
    return original.call(this, raw);
  });
  const server = new ModelServer(
    [
      [
        call('work', { id: 0 }, { callId: 'call-0' }),
        call('work', { id: 1 }, { callId: 'call-1' }),
        message('held-before-terminal'),
      ],
      [call('work', { id: 2 }, { callId: 'call-next' })],
      [message('reused')],
    ],
    USAGE,
    async (item) => {
      if (item.type === 'message') {
        terminal.entered.resolve();
        await terminal.release.promise;
      }
    },
  );
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use work.',
    model: 'gpt-5',
    provider,
    modelSettings: { invocationTimeoutMs: CALLBACK_MS },
    tools: [
      tool({
        name: 'work',
        parameters: z.object({ id: z.number() }).transform((args) => {
          validated.push(args.id);
          return args;
        }),
        before: ({ originalArguments }) => {
          hooks.push(Number(originalArguments.id));
          return { action: 'allow' };
        },
        async execute({ id }) {
          effects.push(id);
          body.entered.resolve();
          await body.release.promise;
          return 'effect';
        },
      }),
    ],
  }).session({ maxFunctionConcurrency: 1 });
  // Hold provider terminal, not merely callback cleanup: the clock must still be active.
  // ModelServer's final output hook is below a second marker item for that purpose.
  const result = track((await session.submit('two calls')).wait());
  let enteredValue: number;
  try {
    await body.entered.promise;
    enteredValue = effects[0]!;
    expect([0, 1]).toContain(enteredValue);
    await vi.waitFor(() => expect(requests.size).toBeGreaterThan(0));
    await vi.waitFor(
      () => {
        for (const captured of requests.values()) {
          expect(original.call(captured.thread, captured.raw)).toBe(false);
        }
      },
      { timeout: 10_000 },
    );
    expect(validated).toEqual([enteredValue!]);
    expect(hooks).toEqual([enteredValue!]);
    expect(effects).toEqual([enteredValue!]);
    expect(result.done()).toBe(false);
  } finally {
    body.release.resolve();
    terminal.release.resolve();
  }
  await expectDeadline(result);
  expect(validated).toEqual([enteredValue!]);
  expect(effects).toEqual([enteredValue!]);
  // A settled owner can accept a new turn; its old clock and cap are retired.
  await session.update({ modelSettings: { invocationTimeoutMs: null } });
  const next = await (await session.submit('again')).wait();
  expect(next.finalOutput).toBe('reused');
  expect(validated).toEqual([enteredValue!, 2]);
  expect(effects).toEqual([enteredValue!, 2]);
  expect(server.requests).toHaveLength(3);
});

it.each(['owner', 'generation', 'instance'] as const)(
  'denies foreign %s before application code',
  async (identity) => {
    const addon = await binding();
    const original = addon.NativeThread.prototype._check_python_tool;
    const effects: number[] = [];
    let otherId = '';
    vi.spyOn(
      addon.NativeThread.prototype,
      '_check_python_tool',
    ).mockImplementation(function (this: NativeThread, raw) {
      const request = JSON.parse(raw);
      if (identity === 'owner') request._sdk_python_tool.thread = otherId;
      if (identity === 'generation') request._sdk_python_tool.generation++;
      if (identity === 'instance')
        request._sdk_python_tool.instance = 'wrong-incarnation';
      return original.call(this, JSON.stringify(request));
    });
    const server = new ModelServer([
      [call('work', { id: 1 }, { callId: 'foreign' })],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Use work.',
      provider,
      modelSettings: { invocationTimeoutMs: CALLBACK_MS },
      tools: [
        tool({
          name: 'work',
          parameters: z.object({ id: z.number() }),
          execute({ id }) {
            effects.push(id);
            return 'effect';
          },
        }),
      ],
    });
    await using session = await agent.session();
    await using other = await agent.session();
    otherId = other.id;
    await expect((await session.submit('one')).wait()).rejects.toThrow();
    expect(effects).toEqual([]);
    expect(server.requests).toHaveLength(1);
  },
);

// Test-only decoding of the version1 append journal owned by native/rust/custom_storage.rs.
// SessionStore snapshots remain opaque to application code.
function committedItems(snapshot: string): Array<Record<string, any>> {
  const document = JSON.parse(snapshot);
  expect(document.version).toBe(1);
  expect(Array.isArray(document.mutations)).toBe(true);
  return document.mutations.flatMap((mutation: Record<string, any>) =>
    mutation.operation === 'append' ? mutation.items : [],
  );
}

it.each([
  ['response_observation_record', true],
  ['token_usage_record', false],
] as const)(
  'holds %s on the correct side of terminal acceptance',
  async (boundary, expires) => {
    // OBS-HELD/TERMINAL-FIRST: real persistent backend and accepted Core records.
    const directory = await mkdtemp(join(tmpdir(), 'deadline-store-'));
    directories.push(directory);
    const durable = fileSessionStore(directory);
    const held = gate();
    let fired = false;
    const committed: unknown[] = [];
    const storage: SessionStore = {
      ...durable,
      async commit(...args) {
        const snapshot = { items: committedItems(args[4]) };
        if (!fired && snapshot.items.some((item) => item.type === boundary)) {
          fired = true;
          held.entered.resolve();
          await held.release.promise;
        }
        await durable.commit(...args);
        committed.push(snapshot);
      },
    };
    const server = new ModelServer([[message('finished')]], USAGE);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      provider,
      modelSettings: { invocationTimeoutMs: MODEL_MS },
    }).session({ storage });
    const result = track((await session.submit('one')).wait());
    try {
      await held.entered.promise;
      await delay(MODEL_MS * 2);
      expect(result.done()).toBe(false);
    } finally {
      held.release.resolve();
    }
    if (expires) await expectDeadline(result);
    else expect((await result.outcome).value?.finalOutput).toBe('finished');
    expect(fired).toBe(true);
    expect(committed.length).toBeGreaterThan(0);
    expect(server.requests).toHaveLength(1);
  },
);

it('Retry-After backoff uses the same allowance and never retries local expiry', async () => {
  const server = new ModelServer([
    {
      status: 429,
      body: JSON.stringify({
        error: { message: 'synthetic retry', code: 'rate_limit' },
      }),
      headers: { 'content-type': 'application/json', 'Retry-After': '5' },
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
    modelSettings: { invocationTimeoutMs: MODEL_MS },
  }).session();
  await expectDeadline(track((await session.submit('one')).wait()));
  expect(server.requests).toHaveLength(1);
});

it('applies the accepted invocation deadline to a separate prompted repair', async () => {
  const held = gate();
  const server = new ModelServer(
    [[message('not-json')], [message('{"value":7}')]],
    USAGE,
    async (_item, _index, request) => {
      if (server.requests.indexOf(request) === 1) {
        held.entered.resolve();
        await held.release.promise;
      }
    },
  );
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Return a report.',
    provider,
    outputType: {
      mode: 'prompted',
      schema: z.object({ value: z.number() }),
      maxRetries: 1,
    },
    modelSettings: { invocationTimeoutMs: 60_000 },
  });
  await using source = await agent.session();
  await source.update({ modelSettings: { invocationTimeoutMs: MODEL_MS } });
  const saved = await source.saveState();
  await source.close();
  await using session = await agent.session({ state: saved });
  const result = track(
    (await session.submit('one', { budget: { maxRequests: 2 } })).wait(),
  );
  const releaseHeld = setTimeout(() => held.release.resolve(), MODEL_MS * 2);
  try {
    await held.entered.promise;
    await expectDeadline(result);
  } finally {
    clearTimeout(releaseHeld);
    held.release.resolve();
  }
  expect(server.requests).toHaveLength(2);
  expect(server.requests[1]?.tools ?? []).toEqual([]);
});

it('starts a fresh invocation clock for each prompted correction', async () => {
  const server = new ModelServer([
    async () => {
      await delay(MODEL_MS * 0.6);
      return [message('not-json')];
    },
    async () => {
      await delay(MODEL_MS * 0.6);
      return [message('{"value":7}')];
    },
  ]);
  await using provider = await providerFor(server);
  const result = await new Agent({
    instructions: 'Return a report.',
    provider,
    outputType: {
      mode: 'prompted',
      schema: z.object({ value: z.number() }),
      maxRetries: 1,
    },
    modelSettings: { invocationTimeoutMs: MODEL_MS },
  }).run('one', { budget: { maxRequests: 2 } });
  expect(result.finalOutput).toEqual({ value: 7 });
  expect(server.requests).toHaveLength(2);
  server.assertExhausted();
});

it.each([null, MODEL_MS])(
  'preserves the accepted fork deadline %s through portable reopen',
  async (timeout) => {
    const held = gate();
    const server = new ModelServer([
      async () => {
        held.entered.resolve();
        await held.release.promise;
        return [message('fork finished')];
      },
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Answer.',
      provider,
      modelSettings: { invocationTimeoutMs: 60_000 },
    });
    await using source = await agent.session();
    await source.update({ modelSettings: { invocationTimeoutMs: timeout } });
    const state = await source.fork();
    expect(latestSettings(state).invocation_timeout_ms ?? null).toBe(timeout);
    expect(
      latestSettings(await source.saveState()).invocation_timeout_ms ?? null,
    ).toBe(timeout);
    await using restored = await agent.session({ state });
    expect(
      latestSettings(await restored.saveState()).invocation_timeout_ms ?? null,
    ).toBe(timeout);
    const result = track((await restored.submit('continue')).wait());
    try {
      await held.entered.promise;
      if (timeout === null) {
        held.release.resolve();
        expect((await result.outcome).value?.finalOutput).toBe('fork finished');
      } else {
        await expectDeadline(result);
      }
    } finally {
      held.release.resolve();
    }
    expect(server.requests).toHaveLength(1);
  },
);

it.each([false, true])(
  'settles a real entered receipt writer after expiry (failure=%s)',
  async (failWriter) => {
    // WRITER-ACCEPTED/WRITER-FAIL/CAP-CLEANUP: keep the real durable adapter.
    const directory = await mkdtemp(join(tmpdir(), 'deadline-receipt-'));
    directories.push(directory);
    const durable = fileSessionStore(directory);
    const writer = gate(),
      terminal = gate();
    const effects: number[] = [],
      validated: number[] = [];
    const committed: Array<{ items: Array<Record<string, any>> }> = [];
    const errors: unknown[] = [];
    let fired = false;
    const storage: SessionStore = {
      ...durable,
      async commit(...args) {
        const snapshot = { items: committedItems(args[4]) };
        if (
          !fired &&
          snapshot.items.some(
            (item) =>
              item.type === 'response_item' &&
              item.payload?.type === 'function_call_output',
          )
        ) {
          fired = true;
          writer.entered.resolve();
          await writer.release.promise;
          if (failWriter) throw new Error('deadline-storage-failure');
        }
        await durable.commit(...args);
        committed.push(snapshot);
      },
    };
    const server = new ModelServer(
      [
        [
          call('record', { id: 0 }, { callId: 'receipt-0' }),
          call('record', { id: 1 }, { callId: 'receipt-1' }),
          message('held-before-terminal'),
        ],
      ],
      USAGE,
      async (item) => {
        if (item.type === 'message') {
          terminal.entered.resolve();
          await terminal.release.promise;
        }
      },
    );
    const provider = await providerFor(server);
    const session = await new Agent({
      instructions: 'Record once.',
      model: 'gpt-5',
      provider,
      modelSettings: { invocationTimeoutMs: CALLBACK_MS },
      tools: [
        tool({
          name: 'record',
          parameters: z.object({ id: z.number() }).transform((args) => {
            validated.push(args.id);
            return args;
          }),
          execute({ id }) {
            effects.push(id);
            return 'real-receipt-once';
          },
        }),
      ],
    }).session({ storage, maxFunctionConcurrency: 1 });
    try {
      const result = track((await session.submit('two calls')).wait());
      try {
        await writer.entered.promise;
        await delay(CALLBACK_MS * 2);
        expect(result.done()).toBe(false);
        expect(effects).toHaveLength(1);
        expect([0, 1]).toContain(effects[0]);
        expect(validated).toEqual(effects);
      } finally {
        writer.release.resolve();
        terminal.release.resolve();
      }
      if (failWriter) {
        const { error } = await result.outcome;
        errors.push(error);
        expect(error).toBeDefined();
      } else await expectDeadline(result);
    } finally {
      writer.release.resolve();
      terminal.release.resolve();
      try {
        await session.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await provider.close();
      } catch (error) {
        errors.push(error);
      }
    }
    expect(server.requests).toHaveLength(1);
    expect(effects).toHaveLength(1);
    expect([0, 1]).toContain(effects[0]);
    expect(validated).toEqual(effects);
    if (failWriter)
      expect(errors.map(String).join('\n').toLowerCase()).toContain(
        'canonical',
      );
    else {
      expect(errors).toEqual([]);
      expect(
        committed
          .at(-1)
          ?.items.some(
            (item) =>
              item.type === 'response_item' &&
              item.payload?.type === 'function_call_output' &&
              JSON.stringify(item).includes('real-receipt-once'),
          ),
      ).toBe(true);
    }
  },
  20_000,
);

it('expires an actual WS response read without HTTP fallback', async () => {
  // WS-SEND(read)/RETRY-OUTER. A server close is a phase receipt, not task-join proof.
  const held = gate();
  const requests: Record<string, any>[] = [];
  const httpRequests: string[] = [];
  const peerErrors: unknown[] = [];
  const server = createServer((request, response) => {
    httpRequests.push(request.url ?? '');
    response.writeHead(500).end('Unexpected HTTP fallback');
  });
  const ws = new WebSocketServer({ server });
  let sequence = 0;
  ws.on('connection', (socket) => {
    socket.on('message', async (bytes) => {
      try {
        const request = JSON.parse(bytes.toString()) as Record<string, any>;
        expect(request.type).toBe('response.create');
        const id = `deadline-ws-${++sequence}`;
        socket.send(
          JSON.stringify({ type: 'response.created', response: { id } }),
        );
        if (request.generate !== false) {
          requests.push(request);
          held.entered.resolve();
          await held.release.promise;
        }
        if (socket.readyState === socket.OPEN)
          socket.send(
            JSON.stringify({
              type: 'response.completed',
              response: { id, usage: USAGE },
            }),
          );
      } catch (error) {
        peerErrors.push(error);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing owned WS peer port');
  try {
    await using provider = new NativeProvider({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'synthetic-deadline-ws',
      supportsWebsockets: true,
    });
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5.1-codex',
      provider,
      modelSettings: { invocationTimeoutMs: MODEL_MS },
    }).session();
    const result = track((await session.submit('one')).wait());
    try {
      await held.entered.promise;
      await expectDeadline(result);
      expect(requests).toHaveLength(1);
      expect(httpRequests).toEqual([]);
    } finally {
      held.release.resolve();
    }
  } finally {
    held.release.resolve();
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  expect(peerErrors).toEqual([]);
});

it('preserves a prior non-retryable provider failure', async () => {
  const server = new ModelServer([
    {
      status: 400,
      body: JSON.stringify({
        error: {
          message: 'synthetic credentials rejected',
          code: 'invalid_api_key',
          type: 'invalid_request_error',
        },
      }),
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'deadline-prior-provider',
      },
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
    modelSettings: { invocationTimeoutMs: 60_000 },
  }).session();
  const { error } = await track((await session.submit('one')).wait()).outcome;
  expect(error).toBeInstanceOf(NativeError);
  expect((error as NativeError).code).not.toBe(
    'model_invocation_deadline_exceeded',
  );
  expect(server.requests).toHaveLength(1);
});

it('captures updates and preserves clear/historical omission while rejecting persisted zero', async () => {
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Answer.',
    provider,
    modelSettings: { invocationTimeoutMs: 60_000 },
  });
  let saved: SessionState, cleared: SessionState;
  {
    await using session = await agent.session();
    const update = { invocationTimeoutMs: 17_000 };
    await session.update({ modelSettings: update });
    update.invocationTimeoutMs = 1;
    await session.update({ modelSettings: { serviceTier: null } });
    saved = await session.saveState();
    expect(latestSettings(saved).invocation_timeout_ms).toBe(17_000);
    await session.update({ modelSettings: { invocationTimeoutMs: null } });
    cleared = await session.saveState();
  }
  {
    await using session = await agent.session({ state: cleared });
    expect(
      latestSettings(await session.saveState()).invocation_timeout_ms ?? null,
    ).toBeNull();
  }
  function change(value: any, replacement: number | null) {
    if (Array.isArray(value))
      for (const item of value) change(item, replacement);
    else if (value && typeof value === 'object')
      for (const key of Object.keys(value)) {
        if (['invocation_timeout_ms', 'invocationTimeoutMs'].includes(key)) {
          if (replacement === null) delete value[key];
          else value[key] = replacement;
        } else change(value[key], replacement);
      }
  }
  const historical = JSON.parse(JSON.stringify(saved));
  change(historical, null);
  {
    await using session = await agent.session({ state: historical });
    expect(
      latestSettings(await session.saveState()).invocation_timeout_ms ?? null,
    ).toBeNull();
  }
  const corrupt = JSON.parse(JSON.stringify(saved));
  change(corrupt, 0);
  await expect(agent.session({ state: corrupt })).rejects.toThrow(
    /invocation_timeout_ms|positive/,
  );
  expect(server.requests).toHaveLength(0);
});

it('starts the clock after initial user-history durability, before model transport', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'deadline-before-invocation-'),
  );
  directories.push(directory);
  const durable = fileSessionStore(directory),
    history = gate(),
    transport = gate();
  let fired = false;
  const storage: SessionStore = {
    ...durable,
    async commit(...args) {
      const snapshot = { items: committedItems(args[4]) };
      if (
        !fired &&
        snapshot.items.some(
          (item) =>
            item.type === 'response_item' &&
            item.payload?.type === 'message' &&
            item.payload?.role === 'user',
        )
      ) {
        fired = true;
        history.entered.resolve();
        await history.release.promise;
      }
      await durable.commit(...args);
    },
  };
  const server = new ModelServer([
    async () => {
      transport.entered.resolve();
      await transport.release.promise;
      return [message('late')];
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
    modelSettings: { invocationTimeoutMs: MODEL_MS },
  }).session({ storage });
  const result = track((async () => (await session.submit('one')).wait())());
  try {
    await history.entered.promise;
    await delay(MODEL_MS * 2);
    expect(result.done()).toBe(false);
    expect(server.requests).toHaveLength(0);
    history.release.resolve();
    await transport.entered.promise;
    await expectDeadline(result);
    expect(server.requests).toHaveLength(1);
  } finally {
    history.release.resolve();
    transport.release.resolve();
  }
});

it('keeps the first invocation clock through second-attempt preparation', async () => {
  const preparation = gate();
  let attempts = 0;
  const server = new ModelServer([
    {
      status: 429,
      headers: { 'retry-after': '0' },
      body: JSON.stringify({ error: { message: 'retry', code: 'rate_limit' } }),
    },
    [message('must-not-dispatch-after-preparation')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    model: 'gpt-5.1-codex',
    instructions: 'Answer.',
    provider,
    tools: [
      tool({
        name: 'unused',
        parameters: z.object({}),
        execute: () => {
          throw new Error('No tool was requested');
        },
      }),
    ],
    modelSettings: { invocationTimeoutMs: MODEL_MS },
  }).session();
  const turn = await session.submit('one', {
    prepareRequest: async () => {
      attempts += 1;
      if (attempts === 2) {
        preparation.entered.resolve();
        await preparation.release.promise;
      }
      return undefined;
    },
  });
  const result = track(turn.wait());
  try {
    await Promise.race([
      preparation.entered.promise,
      result.outcome.then(({ error }) => {
        throw error ?? new Error('Invocation ended before second preparation');
      }),
    ]);
    await delay(MODEL_MS + 300);
  } finally {
    preparation.release.resolve();
  }
  await expectDeadline(result);
  expect(attempts).toBe(2);
  expect(server.requests).toHaveLength(1);
});
