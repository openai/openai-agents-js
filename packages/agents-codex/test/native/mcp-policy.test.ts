import { afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import {
  HttpMCP,
  StdioMCP,
  ChatGPTAppsMCP,
  type ToolRef,
  type MCPBeforeDecision,
  type MCPCallContext,
  type MCPResultContext,
} from '../../src';
import {
  applyMcpPrePolicy,
  hasMcpPrePolicy,
  mcpPrePolicyRules,
  mcpConfig,
  resourceMcpBinding,
  transformMcpResult,
  splitToolDeclarations as splitResourceDeclarations,
} from '../../src/runtime/mcp';
import type {
  JsonObject,
  Engine,
  NativeThread,
} from '../../src/runtime/binding';
import { captureTools } from '../../src/runtime/tools';
import { Session as CoreSession, issueTurn } from '../../src/runtime/session';
import { nativeMcpResultInfoSchema } from '../../src/runtime/native-mcp';

// Pure adapter tests do not confer a native grant. Native tests own peer effects.
const submission = issueTurn(
  'root',
  'turn',
  'submission',
  async () => {
    throw new Error('Pure adapter fixture has no native completion');
  },
  async function* () {},
  async () => {
    throw new Error('Pure adapter fixture has no native steering');
  },
  async () => {
    throw new Error('Pure adapter fixture has no native cancellation');
  },
);
const original = (): JsonObject => ({
  _mcp_generation: '9007199254740993',
  thread_id: 'root',
  incarnation: 'incarnation',
  turn_id: 'turn',
  route: 'direct',
  phase: 'before',
  call_id: 'provider-call',
  tool_name: { namespace: 'mcp__records', name: 'find_record' },
  input: JSON.stringify({
    key: 'original',
    nested: { keep: true },
    action: 'data',
  }),
});
afterEach(() => vi.useRealTimers());

it('captures private literal environments through resource selection without sharing mutable maps', () => {
  const entries = [
    ['PRIVATE_ENV', 'private-literal'],
    ['EMPTY', ''],
    ['UNICODE', 'café 🚀'],
    ['service.é', 'literal-name'],
    ['__proto__', 'literal-prototype'],
  ];
  const env = Object.fromEntries(entries);
  const declaration = new StdioMCP({
    name: 'records',
    tools: ['read'],
    command: 'peer',
    env,
  });
  env.PRIVATE_ENV = 'later-literal';
  const expected = Object.fromEntries(entries);
  expect(declaration.env).toEqual(expected);
  expect(Object.isFrozen(declaration.env)).toBe(true);
  expect(() => {
    (declaration.env as Record<string, string>).PRIVATE_ENV = 'mutated';
  }).toThrow(TypeError);
  expect(Object.keys(declaration)).not.toContain('env');
  expect(JSON.stringify(declaration)).not.toContain('private-literal');
  const first = mcpConfig([declaration]).records as JsonObject;
  (first.env as JsonObject).PRIVATE_ENV = 'changed-config';
  const selected = resourceMcpBinding(declaration);
  expect((mcpConfig([selected]).records as JsonObject).env).toEqual(expected);
  expect(selected.tools).toEqual([]);
});

it.each([
  null,
  [],
  'PRIVATE_ENV',
  { '': 'private-literal' },
  { 'BAD=NAME': 'private-literal' },
  { 'bad\0name': 'private-literal' },
  { 'bad\ud800name': 'private-literal' },
  { PRIVATE_ENV: 3 },
  { PRIVATE_ENV: 'private\0literal' },
  { PRIVATE_ENV: 'private\ud800literal' },
])(
  'rejects an invalid literal environment without revealing its value (%j)',
  (env) => {
    let error: unknown;
    try {
      new StdioMCP({
        name: 'records',
        tools: ['read'],
        command: 'peer',
        env: env as never,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain('private');
  },
);

it('names native MCP preapproval without changing native policy or application gates', () => {
  const approval = vi.fn(() => false);
  const options = {
    name: 'records',
    tools: ['find-record'],
    url: 'https://example.invalid/mcp',
    approval,
  };
  const native = new HttpMCP(options);
  expect(native.approvalMode).toBe('native');
  expect(mcpConfig([native]).records).not.toHaveProperty('tools');
  const preapproved = new HttpMCP({ ...options, approvalMode: 'preapproved' });
  expect(preapproved.approval).toBe(approval);
  expect(mcpConfig([preapproved]).records).toMatchObject({
    enabled_tools: ['find-record'],
    tools: { 'find-record': { approval_mode: 'approve' } },
  });
  expectTypeOf<HttpMCP['approvalMode']>().toEqualTypeOf<
    'native' | 'preapproved'
  >();
  for (const approvalMode of ['auto', 'approve']) {
    expect(
      () => new HttpMCP({ ...options, approvalMode: approvalMode as never }),
    ).toThrow('Invalid MCP approvalMode');
  }
});

it('selects declared raw MCP leaves through their native projected identities', () => {
  const options = {
    name: 'records/api',
    tools: ['find-record', 'list records'],
  };
  const http = new HttpMCP({ ...options, url: 'https://example.invalid/mcp' });
  const stdio = new StdioMCP({ ...options, command: 'peer' });
  for (const server of [http, stdio]) {
    expect(server.tool('find-record')).toEqual({
      kind: 'tool_ref',
      name: 'find_record',
      namespace: 'mcp__records_api',
    });
    expect(server.tool('list records')).toEqual({
      kind: 'tool_ref',
      name: 'list_records',
      namespace: 'mcp__records_api',
    });
    expectTypeOf(server.tool('find-record')).toEqualTypeOf<ToolRef>();
    expect(() => server.tool('find_record')).toThrow('not declared');
    expect(() => server.tool('unselected')).toThrow('not declared');
  }
});

it('captures optional callbacks without serializing them or changing policy-free classification', () => {
  const plain = new HttpMCP({
    name: 'records',
    tools: ['find-record'],
    url: 'http://127.0.0.1:1',
    transformResult: (_ctx, result) => result,
  });
  expect(hasMcpPrePolicy([plain])).toBe(false);
  expect(mcpPrePolicyRules([plain], 1n)).toEqual([]);
  const before = vi.fn(() => ({ action: 'allow' as const }));
  const options = {
    name: 'records',
    tools: ['find-record'],
    url: 'http://127.0.0.1:1',
    before,
  };
  const captured = new HttpMCP(options);
  options.before = vi.fn(() => ({ action: 'allow' as const }));
  expect(captured.before).toBe(before);
  expect(Object.isFrozen(captured)).toBe(true);
  expect(Object.keys(captured)).not.toContain('before');
  expect(Object.keys(captured)).not.toContain('approval');
  expectTypeOf<MCPBeforeDecision>().toExtend<
    | { action: 'allow' }
    | { action: 'replaceArguments'; arguments: JsonObject }
    | { action: 'stop'; reason?: string }
  >();
  expectTypeOf<MCPCallContext['call']['callId']>().toEqualTypeOf<
    string | null
  >();
});

it('copies authoritative replacement before approval and preserves raw names and observed IDs', async () => {
  const replacement = { key: 'effective', nested: { keep: true } };
  let beforeView: MCPCallContext | undefined;
  let approvalView: MCPCallContext | undefined;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const descriptor = new HttpMCP({
    name: 'records',
    tools: ['find-record'],
    url: 'http://127.0.0.1:1',
    before(ctx) {
      beforeView = ctx;
      return { action: 'replaceArguments', arguments: replacement };
    },
    async approval(ctx) {
      approvalView = ctx;
      await held;
      return true;
    },
  });
  const pending = applyMcpPrePolicy(
    [descriptor],
    9007199254740993n,
    undefined,
    submission,
    original(),
    new AbortController().signal,
    () => {},
    vi.fn(),
  );
  await vi.waitFor(() => expect(approvalView).toBeDefined());
  replacement.key = 'late';
  (beforeView!.originalArguments.nested as JsonObject).keep = false;
  (approvalView!.effectiveArguments.nested as JsonObject).keep = false;
  release();
  expect(await pending).toEqual({
    action: 'replace',
    value: { key: 'effective', nested: { keep: true } },
  });
  expect(approvalView?.originalArguments).toEqual({
    key: 'original',
    nested: { keep: true },
    action: 'data',
  });
  expect(approvalView).toMatchObject({
    serverName: 'records',
    toolName: 'find-record',
    submission,
    call: {
      callId: 'provider-call',
      childId: null,
      route: 'direct',
      model: null,
    },
  });
  expect(Object.isFrozen(approvalView?.call)).toBe(true);
});

it('ignores in-place mutations on allow and accepts only a strict true approval', async () => {
  for (const approved of [true, false, 'truthy']) {
    const descriptor = new HttpMCP({
      name: 'records',
      tools: ['find-record'],
      url: 'http://127.0.0.1:1',
      before(ctx) {
        (ctx.originalArguments.nested as JsonObject).keep = false;
        return { action: 'allow' };
      },
      approval: () => approved as boolean,
    });
    const result = await applyMcpPrePolicy(
      [descriptor],
      9007199254740993n,
      undefined,
      submission,
      original(),
      new AbortController().signal,
      () => {},
      vi.fn(),
    );
    expect(result).toEqual({ action: approved === true ? 'continue' : 'deny' });
  }
});

it('denies stale generations before entering the callback and retains null generated provider identity', async () => {
  const before = vi.fn((ctx: MCPCallContext) => {
    expect(ctx.serverName).toBe('records');
    return { action: 'allow' as const };
  });
  const descriptor = new HttpMCP({
    name: 'records',
    tools: ['find-record'],
    url: 'http://127.0.0.1:1',
    before,
  });
  expect(
    await applyMcpPrePolicy(
      [descriptor],
      2n,
      undefined,
      submission,
      original(),
      new AbortController().signal,
      () => {},
      vi.fn(),
    ),
  ).toEqual({ action: 'deny' });
  expect(before).not.toHaveBeenCalled();
  const request = {
    ...original(),
    route: 'code_mode',
    call_id: null,
    input: { key: 'generated' },
    outer_call_id: 'outer',
    cell_id: 'cell',
    runtime_tool_call_id: 'nested',
  };
  await applyMcpPrePolicy(
    [descriptor],
    9007199254740993n,
    undefined,
    submission,
    request,
    new AbortController().signal,
    () => {},
    vi.fn(),
  );
  expect(before.mock.calls[0]?.[0].call).toMatchObject({
    callId: null,
    route: 'code',
    outerCallId: 'outer',
    cellId: 'cell',
    nestedCallId: 'nested',
  });
});

it('before deadline denies promptly but keeps the entered physical promise joined', async () => {
  vi.useFakeTimers();
  let release!: (value: MCPBeforeDecision) => void;
  let entered: AbortSignal | undefined;
  const deny = vi.fn();
  const descriptor = new HttpMCP({
    name: 'records',
    tools: ['find-record'],
    url: 'http://127.0.0.1:1',
    before(ctx) {
      entered = ctx.signal;
      return new Promise<MCPBeforeDecision>((resolve) => {
        release = resolve;
      });
    },
    approval: vi.fn(() => true),
  });
  let settled = false;
  const pending = applyMcpPrePolicy(
    [descriptor],
    9007199254740993n,
    undefined,
    submission,
    original(),
    new AbortController().signal,
    () => {},
    deny,
  );
  const observed = pending.finally(() => {
    settled = true;
  });
  const rejection = expect(observed).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(deny).toHaveBeenCalledTimes(1);
  expect(entered?.aborted).toBe(true);
  expect(settled).toBe(false);
  release({ action: 'allow' });
  await rejection;
  expect(descriptor.approval).not.toHaveBeenCalled();
});

it('preserves MCP before cleanup failure after its callback deadline', async () => {
  vi.useFakeTimers();
  const cleanup = new Error('MCP callback cleanup failed');
  const descriptor = new HttpMCP({
    name: 'records',
    tools: ['find-record'],
    url: 'http://127.0.0.1:1',
    async before(context) {
      await new Promise<void>((resolve) =>
        context.signal.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      );
      throw cleanup;
    },
  });
  const deny = vi.fn();
  const pending = applyMcpPrePolicy(
    [descriptor],
    9007199254740993n,
    undefined,
    submission,
    original(),
    new AbortController().signal,
    () => {},
    deny,
  );
  const outcome = pending.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await outcome).toBe(cleanup);
  expect(deny).toHaveBeenCalledOnce();
});

it('approval has no before deadline and cancellation prevents its late result from publishing', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let release!: () => void;
  const descriptor = new HttpMCP({
    name: 'records',
    tools: ['find-record'],
    url: 'http://127.0.0.1:1',
    before: () => ({ action: 'allow' }),
    approval: () =>
      new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      }),
  });
  const deny = vi.fn();
  const pending = applyMcpPrePolicy(
    [descriptor],
    9007199254740993n,
    undefined,
    submission,
    original(),
    controller.signal,
    () => {},
    deny,
  );
  const rejection = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(31_000);
  expect(deny).not.toHaveBeenCalled();
  controller.abort(new Error('cancelled'));
  release();
  await rejection;
});

it.each(['before', 'result'] as const)(
  'does not adopt an older %s notice while a newer root submit receipt is withheld',
  async (phase) => {
    // This controls the SDK reader boundary, not a positive Core grant or a
    // claim that the injected native scheduling is publicly reproducible.
    const { Session } = await import('../../src/runtime/session');
    const { captureTools } = await import('../../src/runtime/tools');
    type NativeThread = import('../../src/runtime/binding').NativeThread;
    type Engine = import('../../src/runtime/binding').Engine;
    const accepted = Promise.withResolvers<string>();
    const handed = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<string>();
    const before = vi.fn(() => ({ action: 'allow' as const }));
    const transformResult = vi.fn(
      (
        _context: Parameters<
          NonNullable<
            ConstructorParameters<typeof HttpMCP>[0]['transformResult']
          >
        >[0],
        result: JsonObject,
      ) => result,
    );
    const descriptor = new HttpMCP({
      name: 'records',
      tools: ['find-record'],
      url: 'http://127.0.0.1:1',
      before,
      transformResult,
    });
    const resolve = vi.fn(() => true);
    const fail = vi.fn(() => true);
    const request = {
      ...original(),
      _mcp_generation: undefined,
      turn_id: 'old-turn',
    };
    let delivered = false;
    const next = async () => {
      if (delivered) return finish.promise;
      delivered = true;
      return JSON.stringify(
        phase === 'before'
          ? { nonce: '1', generation: '0', request }
          : {
              nonce: '1',
              generation: '0',
              thread_id: 'root',
              turn_id: 'old-turn',
              call_id: 'provider-call',
              source: 'config',
              server_name: 'records',
              tool_name: 'find-record',
              callable_namespace: 'mcp__records',
              callable_name: 'find_record',
              arguments: {},
              result: {},
            },
      );
    };
    const native = {
      id: 'root',
      _submit: () => accepted.promise,
      _next_native_interception: next,
      _next_native_mcp_result: next,
      _handoff_native_interception: () => {
        handed.resolve();
        return true;
      },
      _handoff_native_mcp_result: () => {
        handed.resolve();
        return true;
      },
      _check_native_interception: () => true,
      _check_native_mcp_result: () => true,
      _resolve_native_interception: resolve,
      _resolve_native_mcp_result: resolve,
      _fail_native_mcp_result: fail,
      _release_native_interception: () => released.resolve(),
      _release_native_mcp_result: () => released.resolve(),
      _finish_native_interception_reader: () => {},
    } as unknown as NativeThread;
    const session = new Session(
      {} as Engine,
      native,
      captureTools([]),
      { mcpTools: [descriptor] },
      {},
    );
    const submission = session.submit('new turn');
    const readers = session as unknown as {
      readInterceptions(): Promise<void>;
      readMcpResults(): Promise<void>;
    };
    const reader =
      phase === 'before'
        ? readers.readInterceptions()
        : readers.readMcpResults();
    try {
      await handed.promise;
      expect(before).not.toHaveBeenCalled();
      accepted.resolve(
        JSON.stringify({ status: 'started', turn_id: 'new-turn' }),
      );
      expect((await submission).turnId).toBe('new-turn');
      await released.promise;
      expect(before).not.toHaveBeenCalled();
      expect(transformResult).not.toHaveBeenCalled();
      if (phase === 'before')
        expect(resolve).toHaveBeenCalledWith('1', '{"action":"deny"}');
      else {
        expect(resolve).not.toHaveBeenCalled();
        expect(fail).toHaveBeenCalledWith('1', 'old-turn', 'provider-call');
      }
    } finally {
      accepted.resolve(
        JSON.stringify({ status: 'started', turn_id: 'new-turn' }),
      );
      finish.resolve('null');
      await submission;
      await reader;
    }
  },
);

it('preserves arbitrary structured MCP JSON keys through result transforms', async () => {
  const result = JSON.parse(
    '{"content":[],"structuredContent":{"__proto__":{"ownKeyRetained":true},"constructor":{"prototype":"data"}}}',
  );
  const parsed = nativeMcpResultInfoSchema.parse({
    nonce: '1',
    thread_id: 'root',
    turn_id: 'turn',
    call_id: 'call',
    source: 'config',
    server_name: 'records',
    tool_name: 'lookup',
    callable_namespace: 'mcp__records',
    callable_name: 'lookup',
    arguments: {},
    result,
  });
  expect(parsed.result).toBeDefined();
  const transformResult = vi.fn(
    (_context: MCPResultContext, value: JsonObject) => value,
  );
  const server = new HttpMCP({
    name: 'records',
    tools: ['lookup'],
    url: 'http://127.0.0.1:1/mcp',
    transformResult,
  });
  const transformed = await transformMcpResult(
    [server],
    1n,
    undefined,
    submission,
    { ...parsed, generation: '1' },
  );
  expect(transformResult).toHaveBeenCalledOnce();
  expect(transformed).toEqual(result);
  const structured = transformed.structuredContent as JsonObject;
  expect(Object.hasOwn(structured, '__proto__')).toBe(true);
  expect(structured).toEqual(result.structuredContent);
  expect(Object.getPrototypeOf(structured)).toBe(Object.prototype);
  expect(Object.prototype).not.toHaveProperty('ownKeyRetained');
});

it('rejects a nonboolean MCP discovery option before native connection', () => {
  expect(
    () =>
      new HttpMCP({
        name: 'records',
        tools: ['lookup'],
        url: 'http://127.0.0.1:1/mcp',
        // @ts-expect-error Discovery grants require an actual boolean.
        deferLoading: 'false',
      }),
  ).toThrow('MCP deferLoading must be a boolean');
});

for (const phase of ['before', 'approval'] as const) {
  it(`consumes ${phase} stop privately without granting local dispatch`, async () => {
    const approval = vi.fn(() => true);
    const decision = {
      action: 'stop' as const,
      get reason(): string {
        throw new Error('Private reason must not be inspected');
      },
    };
    const descriptor = new HttpMCP({
      name: 'records',
      tools: ['find-record'],
      url: 'http://127.0.0.1:1',
      before: phase === 'before' ? () => decision : () => ({ action: 'allow' }),
      approval: phase === 'approval' ? () => decision : approval,
    });
    const stop = vi.fn();
    const result = await applyMcpPrePolicy(
      [descriptor],
      9007199254740993n,
      undefined,
      submission,
      original(),
      new AbortController().signal,
      () => {},
      vi.fn(),
      stop,
    );
    expect(stop).toHaveBeenCalledExactlyOnceWith();
    expect(result).toEqual({ action: 'deny' });
    expect(approval).not.toHaveBeenCalled();
  });
  it(`does not accept a revoked ${phase} stop`, async () => {
    const controller = new AbortController();
    const cancelled = new Error('original cancellation');
    const decision = () => {
      controller.abort(cancelled);
      return { action: 'stop' as const };
    };
    const descriptor = new HttpMCP({
      name: 'records',
      tools: ['find-record'],
      url: 'http://127.0.0.1:1',
      before: phase === 'before' ? decision : () => ({ action: 'allow' }),
      approval: phase === 'approval' ? decision : () => true,
    });
    const stop = vi.fn();
    await expect(
      applyMcpPrePolicy(
        [descriptor],
        9007199254740993n,
        undefined,
        submission,
        original(),
        controller.signal,
        () => {},
        vi.fn(),
        stop,
      ),
    ).rejects.toBe(cancelled);
    expect(stop).not.toHaveBeenCalled();
  });
}

it('declares ordinary resource-only servers without admitting any tools', () => {
  for (const server of [
    new HttpMCP({
      name: 'resources',
      tools: [],
      url: 'https://example.invalid/mcp',
    }),
    new StdioMCP({ name: 'resources', tools: [], command: 'peer' }),
  ]) {
    expect(splitResourceDeclarations([server]).mcp).toEqual([server]);
    expect(mcpConfig([server]).resources).toMatchObject({ enabled_tools: [] });
    expect(() => server.tool('undeclared')).toThrow('not declared');
  }
});

it('refuses hosted and undeclared resource/prompt aliases before native dispatch', async () => {
  const call = vi.fn();
  const owned = new CoreSession(
    {} as Engine,
    { id: 'resource-root', call } as unknown as NativeThread,
    captureTools([]),
    { mcpTools: [new ChatGPTAppsMCP({ tools: [] })] },
    {},
  );
  for (const name of ['codex_apps', 'undeclared']) {
    await expect(owned.listMcpResources(name)).rejects.toThrow(
      'currently selected ordinary',
    );
    await expect(owned.listMcpResourceTemplates(name)).rejects.toThrow(
      'currently selected ordinary',
    );
    await expect(owned.readMcpResource(name, 'memo://first')).rejects.toThrow(
      'currently selected ordinary',
    );
    await expect(owned.listMcpPrompts(name)).rejects.toThrow(
      'currently selected ordinary',
    );
    await expect(owned.getMcpPrompt(name, 'review')).rejects.toThrow(
      'currently selected ordinary',
    );
  }
  expect(call).not.toHaveBeenCalled();
});
