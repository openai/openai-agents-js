import {
  copyFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  Agent,
  Environment,
  NativeProvider,
  StdioMCP,
  type Session,
  type MCPCallContext,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

let directory: string;
const providers: NativeProvider[] = [];
const sessions: Session[] = [];

beforeEach(async () => {
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-parent-api-key');
  vi.stubEnv('NODE_REPL_AUTH_TOKEN', 'synthetic-protected-parent');
  directory = await mkdtemp(join(tmpdir(), 'agents-owned-mcp-stdio-'));
});
afterEach(async () => {
  try {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
    await Promise.all(providers.splice(0).map((provider) => provider.close()));
    await rm(directory, { recursive: true, force: true });
  } finally {
    vi.unstubAllEnvs();
  }
});

// A peer can still be appending the last line; observe only full records.
async function records(path: string): Promise<JsonObject[]> {
  const text = await readFile(path, 'utf8');
  return text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonObject);
}

function alive(pid: number): boolean {
  try {
    // Node's existing pnpm-parallel-cleanup Windows test uses signal 0.
    // Do not use Python's Windows os.kill(pid, 0) or Node's default signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function pids(starts: string): Promise<number[]> {
  const launches = await records(starts);
  expect(
    launches.length,
    'native client did not start the peer',
  ).toBeGreaterThan(0);
  return launches.map(({ pid }) => {
    expect(Number.isInteger(pid)).toBe(true);
    expect(pid).toBeGreaterThan(0);
    return pid as number;
  });
}

async function stopped(starts: string): Promise<void> {
  const launched = await pids(starts);
  await vi.waitFor(
    () => {
      for (const pid of launched)
        expect(alive(pid), 'still running: ' + pid).toBe(false);
    },
    { timeout: 8000, interval: 20 },
  );
}

async function peer(
  label: string,
  field: string,
  holdCall = false,
  overrides: Partial<ConstructorParameters<typeof StdioMCP>[0]> = {},
  observeEnv: readonly string[] = ENV_NAMES,
) {
  const roster = join(directory, label + '-roster.json');
  const calls = join(directory, label + '-calls.jsonl');
  const starts = join(directory, label + '-starts.jsonl');
  await Promise.all([
    writeFile(calls, ''),
    writeFile(starts, ''),
    writeFile(
      roster,
      JSON.stringify({
        tools: [
          {
            name: 'lookup',
            description: 'Read a record',
            annotations: { readOnlyHint: true },
            inputSchema: {
              type: 'object',
              properties: { [field]: { type: 'string' } },
              required: [field],
            },
          },
        ],
        result: { content: [{ type: 'text', text: label + '-record' }] },
        holdCall,
        observeEnv,
      }),
    ),
  ]);
  const declaration = new StdioMCP({
    name: 'fixture',
    tools: ['lookup'],
    approvalMode: 'preapproved',
    command: process.execPath,
    args: [resolve(import.meta.dirname, 'mcp-peer.mjs'), roster, calls, starts],
    cwd: directory,
    ...overrides,
  });
  return { calls, starts, roster, declaration };
}

async function agent(model: ModelServer, declaration: StdioMCP) {
  const config = await model.config();
  const route = config['model_providers.fixture'] as { base_url: string };
  const provider = new NativeProvider({
    baseUrl: route.base_url,
    apiKey: 'synthetic',
  });
  providers.push(provider);
  return new Agent({
    name: 'Owned native stdio',
    instructions: 'Read the selected record.',
    model: 'gpt-5',
    provider,
    tools: [declaration],
  });
}

const lookup = (field: string, id: string) =>
  call('lookup', { [field]: id }, { callId: id, namespace: 'mcp__fixture' });

it('observes a live native-owned peer without terminating it and sees its exit after close', async () => {
  const selected = await peer('normal', 'key');
  const model = new ModelServer([
    [lookup('key', 'first')],
    [message('first')],
    [lookup('key', 'after-observation')],
    [message('second')],
  ]);
  const session = await (await agent(model, selected.declaration)).session();
  sessions.push(session);
  expect((await (await session.submit('first')).wait()).finalOutput).toBe(
    'first',
  );
  const launched = await pids(selected.starts);
  expect(launched.every(alive)).toBe(true);
  // The second real response proves signal 0 did not stop the Windows peer.
  expect((await (await session.submit('still live')).wait()).finalOutput).toBe(
    'second',
  );
  expect(await records(selected.calls)).toHaveLength(2);
  expect(JSON.stringify(model.requests[3].input)).toContain('normal-record');
  model.assertExhausted();
  await session.close();
  await stopped(selected.starts);
}, 30_000);

it('sees original and current peers exit after close and uses only current launch authority on restore', async () => {
  const original = await peer('original', 'key', false, {
    env: { B04_LITERAL: 'old-captured' },
  });
  const supplied = { B04_LITERAL: 'current-captured' };
  const current = await peer('current', 'revision', false, { env: supplied });
  supplied.B04_LITERAL = 'mutated-after-capture';
  const model = new ModelServer([
    [lookup('key', 'old')],
    [message('old')],
    [lookup('revision', 'replaced')],
    [message('new')],
  ]);
  const session = await (await agent(model, original.declaration)).session();
  sessions.push(session);
  expect((await (await session.submit('old')).wait()).finalOutput).toBe('old');
  await session.update({ tools: [current.declaration] });
  expect((await (await session.submit('new')).wait()).finalOutput).toBe('new');
  expect(JSON.stringify(model.requests[3].input)).toContain('current-record');
  const saved = await session.saveState();
  expect(saved.agent_options).toEqual({});
  expect(JSON.stringify(saved)).not.toContain('old-captured');
  expect(JSON.stringify(saved)).not.toContain('current-captured');
  model.assertExhausted();
  await session.close();
  // Source 102f asserts these after Session close, not at replacement time.
  await stopped(original.starts);
  await stopped(current.starts);
  const oldLaunches = await records(original.starts);
  const currentLaunches = await records(current.starts);
  const resumedModel = new ModelServer([
    [lookup('revision', 'restored')],
    [message('restored')],
  ]);
  const restored = await (
    await agent(resumedModel, current.declaration)
  ).session({
    state: {
      ...saved,
      agent_options: {
        config: {
          mcp_servers: {
            stale: {
              command: original.declaration.command,
              args: [...original.declaration.args],
              cwd: directory,
              env: { B04_LITERAL: 'poisoned-saved-config' },
            },
          },
        },
      },
    },
  });
  sessions.push(restored);
  expect((await (await restored.submit('resume')).wait()).finalOutput).toBe(
    'restored',
  );
  expect(JSON.stringify(resumedModel.requests[1].input)).toContain(
    'current-record',
  );
  expect((await restored.saveState()).agent_options).toEqual({});
  expect(JSON.stringify(await restored.saveState())).not.toContain(
    'current-captured',
  );
  for (const secret of [
    'old-captured',
    'current-captured',
    'poisoned-saved-config',
  ])
    expect(
      JSON.stringify([...model.requests, ...resumedModel.requests]),
    ).not.toContain(secret);
  resumedModel.assertExhausted();
  await restored.close();
  await stopped(current.starts);
  expect(await records(original.starts)).toEqual(oldLaunches);
  expect((await records(current.starts)).length).toBeGreaterThan(
    currentLaunches.length,
  );
  expect((await records(current.calls)).map((row) => row.arguments)).toEqual([
    { revision: 'replaced' },
    { revision: 'restored' },
  ]);
  expect(
    new Set(
      (await records(original.starts)).map(
        (row) => (row.observedEnv as JsonObject).B04_LITERAL,
      ),
    ),
  ).toEqual(new Set(['old-captured']));
  expect(
    new Set(
      (await records(current.starts)).map(
        (row) => (row.observedEnv as JsonObject).B04_LITERAL,
      ),
    ),
  ).toEqual(new Set(['current-captured']));
  expect(JSON.stringify(await records(current.starts))).not.toContain(
    'poisoned-saved-config',
  );
}, 40_000);

it.each(['cancel', 'close'] as const)(
  'settles a pending native stdio call on %s and observes exit after Session close',
  async (ending) => {
    const selected = await peer('pending', 'key', true);
    const model = new ModelServer([[lookup('key', 'pending')]]);
    const session = await (await agent(model, selected.declaration)).session();
    sessions.push(session);
    const turn = await session.submit('hold');
    // Attach rejection handling while the actual native call is pending.
    const result = turn.wait().catch((error: unknown) => error);
    await vi.waitFor(
      async () => {
        expect(await records(selected.calls)).toHaveLength(1);
      },
      { timeout: 8000, interval: 20 },
    );
    expect((await pids(selected.starts)).every(alive)).toBe(true);
    if (ending === 'cancel') await session.interrupt();
    else await session.close();
    expect(await result).toBeInstanceOf(Error);
    expect(model.requests).toHaveLength(1);
    await session.close();
    await stopped(selected.starts);
  },
  30_000,
);

afterEach(() => ModelServer.closeAll());

it('runs captured stdio before and application approval before the selected peer effect', async () => {
  const fixture = await peer('pre-policy', 'key');
  const seen: unknown[] = [];
  const before = vi.fn((context: MCPCallContext) => {
    seen.push(context.call);
    return {
      action: 'replaceArguments' as const,
      arguments: { key: 'effective' },
    };
  });
  const approval = vi.fn((context: MCPCallContext) => {
    expect(context.originalArguments).toEqual({ key: 'original' });
    expect(context.effectiveArguments).toEqual({ key: 'effective' });
    return true;
  });
  const selected = new StdioMCP({
    name: fixture.declaration.name,
    tools: fixture.declaration.tools,
    command: fixture.declaration.command,
    args: fixture.declaration.args,
    cwd: fixture.declaration.cwd,
    approvalMode: 'preapproved',
    before,
    approval,
  });
  const model = new ModelServer([
    [lookup('key', 'original')],
    [message('done')],
  ]);
  const configured = await agent(model, selected);
  const session = await configured.session();
  sessions.push(session);
  const turn = await session.submit('read');
  expect((await turn.wait()).finalOutput).toBe('done');
  expect(before).toHaveBeenCalledTimes(1);
  expect(approval).toHaveBeenCalledTimes(1);
  expect(seen).toMatchObject([
    {
      sessionId: session.id,
      turnId: turn.turnId,
      route: 'direct',
      callId: 'original',
    },
  ]);
  const calls = await records(fixture.calls);
  expect(
    calls.map(({ name, arguments: args }) => ({ name, arguments: args })),
  ).toEqual([{ name: 'lookup', arguments: { key: 'effective' } }]);
  expect(calls[0]?._meta).toMatchObject({ callId: 'original' });
  await session.close();
  await stopped(fixture.starts);
  model.assertExhausted();
}, 15_000);
it('rejects MCP updates that were not declared at Session opening before peer effects', async () => {
  const selected = await peer('ungranted', 'key');
  const model = new ModelServer([]);
  const session = await (
    await agent(model, selected.declaration)
  ).session({
    tools: [],
  });
  sessions.push(session);
  await expect(
    session.update({ tools: [selected.declaration] }),
  ).rejects.toThrow('MCP schema discovery mode must match the Session opening');
  expect(await records(selected.starts)).toHaveLength(0);
  expect(await records(selected.calls)).toHaveLength(0);
  expect(model.requests).toHaveLength(0);
  await session.close();
  expect(await records(selected.starts)).toHaveLength(0);
  model.assertExhausted();
}, 15_000);

it('captures the first local MCP at opening and closes same-provider managers independently', async () => {
  const first = await peer('opening-a', 'key');
  const second = await peer('opening-b', 'key');
  const model = new ModelServer([
    [lookup('key', 'a-call')],
    [message('a result')],
    [lookup('key', 'b-call')],
    [message('b result')],
    [lookup('key', 'b-after-close')],
    [message('b still live')],
  ]);
  const sharedAgent = await agent(model, first.declaration);
  const a = await sharedAgent.session();
  sessions.push(a);
  const b = await sharedAgent.session({ tools: [second.declaration] });
  sessions.push(b);
  const aPids = await pids(first.starts);
  const bPids = await pids(second.starts);
  expect(aPids.every(alive)).toBe(true);
  expect(bPids.every(alive)).toBe(true);
  expect(aPids.some((pid) => bPids.includes(pid))).toBe(false);
  expect(await records(first.calls)).toHaveLength(0);
  expect(await records(second.calls)).toHaveLength(0);
  expect(model.requests).toHaveLength(0);
  expect((await (await a.submit('use first')).wait()).finalOutput).toBe(
    'a result',
  );
  expect((await (await b.submit('use second')).wait()).finalOutput).toBe(
    'b result',
  );
  expect(JSON.stringify(model.requests[1].input)).toContain('opening-a-record');
  expect(JSON.stringify(model.requests[3].input)).toContain('opening-b-record');
  await a.close();
  await stopped(first.starts);
  expect(bPids.every(alive)).toBe(true);
  expect(
    (await (await b.submit('survive first close')).wait()).finalOutput,
  ).toBe('b still live');
  expect(JSON.stringify(model.requests[5].input)).toContain('opening-b-record');
  expect(await records(first.calls)).toHaveLength(1);
  expect(await records(second.calls)).toHaveLength(2);
  for (const request of model.requests)
    expect(JSON.stringify(request.tools ?? [])).not.toContain('exec_command');
  model.assertExhausted();
  await b.close();
  await stopped(second.starts);
}, 30_000);

const ENV_NAMES = [
  'B04_LITERAL',
  'B04_EMPTY',
  'B04_UNICODE',
  'service.é',
  'OPENAI_API_KEY',
  'NODE_REPL_AUTH_TOKEN',
  'B04_UNREQUESTED_SECRET',
  'B04_INHERITED',
];
const envValues = (label: string): Record<string, string> => ({
  B04_LITERAL: label,
  B04_EMPTY: '',
  B04_UNICODE: '東京 café',
  'service.é': 'non-identifier',
  OPENAI_API_KEY: 'synthetic-child-grant',
  NODE_REPL_AUTH_TOKEN: 'synthetic-protected-literal',
});
const parentEnv = () =>
  Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
async function expectEnv(
  starts: string,
  label: string,
  inherited: string | null = null,
) {
  const launches = await records(starts);
  expect(launches.length).toBeGreaterThan(0);
  for (const row of launches)
    expect(row.observedEnv).toEqual({
      B04_LITERAL: label,
      B04_EMPTY: '',
      B04_UNICODE: '東京 café',
      'service.é': 'non-identifier',
      OPENAI_API_KEY: 'synthetic-child-grant',
      NODE_REPL_AUTH_TOKEN: null,
      B04_UNREQUESTED_SECRET: null,
      B04_INHERITED: inherited,
    });
}
afterEach(() => vi.unstubAllEnvs());

it('captures independent literal maps for concurrent real stdio children without changing parent env', async () => {
  vi.stubEnv('B04_LITERAL', 'parent-conflict');
  vi.stubEnv('B04_INHERITED', 'host-inherited');
  vi.stubEnv('B04_UNREQUESTED_SECRET', 'synthetic-unrequested-host-secret');
  vi.stubEnv('NODE_REPL_AUTH_TOKEN', 'synthetic-protected-parent');
  const parent = parentEnv();
  await Promise.all(
    ['first-child', 'second-child'].map(async (label) => {
      const marker = `captured-${label}-private`;
      const supplied = envValues(marker);
      const selected = await peer(label, 'key', false, {
        env: supplied,
        envVars: ['B04_LITERAL', 'B04_INHERITED', 'NODE_REPL_AUTH_TOKEN'],
      });
      supplied.B04_LITERAL = 'mutated-after-capture';
      const model = new ModelServer([
        [lookup('key', label)],
        [message('done')],
      ]);
      const session = await (
        await agent(model, selected.declaration)
      ).session();
      sessions.push(session);
      expect((await (await session.submit('read')).wait()).finalOutput).toBe(
        'done',
      );
      expect(JSON.stringify(await session.saveState())).not.toContain(
        'synthetic-child-grant',
      );
      expect(JSON.stringify(await session.saveState())).not.toContain(marker);
      expect(JSON.stringify(model.requests)).not.toContain(
        'synthetic-child-grant',
      );
      await session.close();
      await stopped(selected.starts);
      await expectEnv(selected.starts, marker, 'host-inherited');
      for (const secret of [
        'captured-first-child-private',
        'captured-second-child-private',
        'synthetic-child-grant',
        'synthetic-unrequested-host-secret',
      ])
        expect(JSON.stringify(model.requests)).not.toContain(secret);
      model.assertExhausted();
    }),
  );
  expect(parentEnv()).toEqual(parent);
}, 40_000);

it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
  'delivers explicit literal grants to a real local Environment MCP child',
  async (context) => {
    vi.stubEnv('B04_LITERAL', 'parent-conflict');
    vi.stubEnv('B04_INHERITED', 'local-inherited');
    vi.stubEnv('B04_UNREQUESTED_SECRET', 'synthetic-unrequested-host-secret');
    const parent = parentEnv();
    const selected = await peer('local-env', 'key');
    const script = join(directory, 'peer.mjs');
    await copyFile(resolve(import.meta.dirname, 'mcp-peer.mjs'), script);
    const declaration = new StdioMCP({
      name: 'fixture',
      tools: ['lookup'],
      approvalMode: 'preapproved',
      command: process.execPath,
      args: [script, selected.roster, selected.calls, selected.starts],
      cwd: directory,
      location: 'environment',
      env: envValues('local-literal'),
      envVars: ['B04_LITERAL', 'B04_INHERITED', 'NODE_REPL_AUTH_TOKEN'],
    });
    const model = new ModelServer([
      [lookup('key', 'local')],
      [message('done')],
    ]);
    const session = await (
      await agent(model, declaration)
    )
      .session({
        environment: Environment.local({ cwd: directory, tools: [] }),
      })
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          /could not establish the platform sandbox/.test(error.message) &&
          process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
        ) {
          expect(model.requests).toHaveLength(0);
          context.skip('This host cannot launch a nested platform sandbox');
        }
        throw error;
      });
    sessions.push(session);
    expect((await (await session.submit('read')).wait()).finalOutput).toBe(
      'done',
    );
    for (const secret of ['local-literal', 'synthetic-child-grant'])
      expect(JSON.stringify(await session.saveState())).not.toContain(secret);
    await session.close();
    await stopped(selected.starts);
    await expectEnv(selected.starts, 'local-literal', 'local-inherited');

    for (const secret of [
      'local-literal',
      'synthetic-child-grant',
      'synthetic-unrequested-host-secret',
    ])
      expect(JSON.stringify(model.requests)).not.toContain(secret);
    expect(parentEnv()).toEqual(parent);
    expect(JSON.stringify(model.requests)).not.toContain(
      'synthetic-child-grant',
    );
  },
  40_000,
);

it('uses executor-side inherited names and captured literals through the existing real WSS executor', async () => {
  vi.stubEnv('B04_INHERITED', 'executor-inherited');
  vi.stubEnv('B04_LITERAL', 'executor-conflict');
  vi.stubEnv('NODE_REPL_AUTH_TOKEN', 'synthetic-protected-executor');
  let session: Session | undefined;
  const executor = await startPublicExecutor();
  try {
    const selected = await peer('remote-env', 'key', false, {
      location: 'environment',
      cwd: undefined,
      env: envValues('remote-literal'),
      envVars: ['B04_LITERAL', 'B04_INHERITED', 'NODE_REPL_AUTH_TOKEN'],
    });
    vi.stubEnv('B04_INHERITED', 'synthetic-host-inherited-secret');
    vi.stubEnv('B04_LITERAL', 'host-conflict');
    vi.stubEnv('B04_UNREQUESTED_SECRET', 'synthetic-unrequested-host-secret');
    const parent = parentEnv();
    const model = new ModelServer([
      [lookup('key', 'remote')],
      [message('done')],
    ]);
    session = await (
      await agent(model, selected.declaration)
    ).session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: [],
        ...(process.platform === 'win32'
          ? { writePolicy: 'legacy' as const }
          : {}),
      }),
    });
    sessions.push(session);
    expect((await (await session.submit('read')).wait()).finalOutput).toBe(
      'done',
    );
    for (const secret of ['remote-literal', 'synthetic-child-grant'])
      expect(JSON.stringify(await session.saveState())).not.toContain(secret);
    await session.close();
    await stopped(selected.starts);
    await expectEnv(selected.starts, 'remote-literal', 'executor-inherited');
    for (const secret of [
      'remote-literal',
      'synthetic-child-grant',
      'synthetic-unrequested-host-secret',
    ])
      expect(JSON.stringify(model.requests)).not.toContain(secret);
    for (const row of await records(selected.starts))
      expect(row.cwd).toBe(await realpath(executor.cwd));
    expect(parentEnv()).toEqual(parent);
    expect(JSON.stringify(model.requests)).not.toContain(
      'synthetic-child-grant',
    );
    expect(JSON.stringify(executor.requests)).not.toContain(
      'synthetic-host-inherited-secret',
    );
    expect(JSON.stringify(executor.requests)).not.toContain(
      'synthetic-unrequested-host-secret',
    );
  } finally {
    try {
      await session?.close();
    } finally {
      await executor.close();
    }
  }
}, 60_000);

it('preserves literal env through the resource-only stdio projection', async () => {
  const selected = await peer('resources-env', 'key', false, {
    tools: [],
    env: envValues('resource-literal'),
  });
  const roster = JSON.parse(
    await readFile(selected.roster, 'utf8'),
  ) as JsonObject;
  await writeFile(
    selected.roster,
    JSON.stringify({
      ...roster,
      capabilities: { resources: {} },
      resourcePages: {
        first: {
          resources: [{ uri: 'fixture://environment', name: 'environment' }],
        },
      },
      readResult: {
        contents: [{ uri: 'fixture://environment', text: 'resource-only' }],
      },
    }),
  );
  const model = new ModelServer([]);
  const session = await (await agent(model, selected.declaration)).session();
  sessions.push(session);
  expect((await session.listMcpResources('fixture')).resources).toEqual([
    { uri: 'fixture://environment', name: 'environment' },
  ]);
  expect(
    (await session.readMcpResource('fixture', 'fixture://environment'))
      .contents,
  ).toEqual([{ uri: 'fixture://environment', text: 'resource-only' }]);
  expect((await session.saveState()).agent_options).toEqual({});
  for (const secret of ['resource-literal', 'synthetic-child-grant'])
    expect(JSON.stringify(await session.saveState())).not.toContain(secret);
  await session.close();
  await stopped(selected.starts);
  await expectEnv(selected.starts, 'resource-literal');
  expect(model.requests).toEqual([]);
}, 30_000);

for (const location of ['host', 'environment'] as const) {
  it.each(['inherited', 'ascii-duplicates', 'unicode-duplicates', 'path'])(
    `applies native environment name rules for %s (${location})`,
    async (testCase) => {
      let names: [string, string];
      let envVars: string[] = [];
      let env: Record<string, string>;
      if (testCase === 'inherited') {
        names = ['B04_Case', 'B04_CASE'];
        vi.stubEnv(names[0], 'executor-inherited');
        envVars = [names[0]];
        env = { [names[1]]: 'explicit-value' };
      } else if (testCase === 'path') {
        names = ['PATH', 'Path'];
        env = { [names[1]]: 'synthetic-child-path' };
      } else {
        names =
          testCase === 'ascii-duplicates'
            ? ['B04_CASE', 'b04_case']
            : ['B04_É', 'B04_é'];
        env = { [names[0]]: 'first-value', [names[1]]: 'second-value' };
      }
      let executor: Awaited<ReturnType<typeof startPublicExecutor>> | undefined;
      let session: Session | undefined;
      try {
        let environment: Environment | undefined;
        if (location === 'environment') {
          executor = await startPublicExecutor();
          environment = new Environment({
            url: executor.url,
            cwd: executor.cwd,
            headers: executor.headers,
            tools: [],
            ...(process.platform === 'win32'
              ? { writePolicy: 'legacy' as const }
              : {}),
          });
          if (envVars.length)
            vi.stubEnv(names[0], 'host-value-must-not-be-forwarded');
        }
        const selected = await peer(
          `names-${location}-${testCase}`,
          'key',
          false,
          { location, env, envVars, cwd: undefined },
          names,
        );
        const rejectsDuplicates =
          process.platform === 'win32' && testCase.endsWith('duplicates');
        const model = new ModelServer(
          rejectsDuplicates ? [] : [[message('done')]],
        );
        const configured = await agent(model, selected.declaration);
        if (rejectsDuplicates) {
          await expect(configured.session({ environment })).rejects.toThrow(
            'Native MCP publication was not confirmed',
          );
          expect(await records(selected.starts)).toHaveLength(0);
          expect(model.requests).toHaveLength(0);
          return;
        }
        session = await configured.session({ environment });
        sessions.push(session);
        expect((await (await session.submit('read')).wait()).finalOutput).toBe(
          'done',
        );
        await session.close();
        await stopped(selected.starts);
        const launches = await records(selected.starts);
        expect(launches.length).toBeGreaterThan(0);
        for (const row of launches) {
          const observed = row.observedEnv as Record<string, string | null>;
          if (testCase.endsWith('duplicates')) {
            expect(observed).toEqual(env);
          } else if (testCase === 'inherited') {
            expect(observed).toEqual({
              [names[0]]:
                process.platform === 'win32'
                  ? 'explicit-value'
                  : 'executor-inherited',
              [names[1]]: 'explicit-value',
            });
          } else {
            expect(observed[names[1]]).toBe('synthetic-child-path');
            if (process.platform === 'win32') {
              expect(observed[names[0]]).toBe('synthetic-child-path');
            } else {
              expect(observed[names[0]]).toBeTruthy();
              expect(observed[names[0]]).not.toBe('synthetic-child-path');
            }
          }
        }
        if (executor && testCase === 'inherited') {
          const starts = executor.requests.filter(
            (request) => request.method === 'process/start',
          );
          expect(starts.length).toBeGreaterThan(0);
          for (const request of starts) {
            const params = request.params as JsonObject;
            const policy = params.envPolicy as JsonObject;
            expect(params.env).toEqual(env);
            expect(policy.set).toEqual({});
            expect(policy.includeOnly).toContain(names[0]);
            expect(JSON.stringify(params)).not.toContain(
              'host-value-must-not-be-forwarded',
            );
          }
        }
        model.assertExhausted();
      } finally {
        try {
          await session?.close();
        } finally {
          await executor?.close();
        }
      }
    },
    60_000,
  );
}
