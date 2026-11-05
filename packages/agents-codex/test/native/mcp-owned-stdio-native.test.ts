import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  Agent,
  NativeProvider,
  StdioMCP,
  type Session,
  type MCPCallContext,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

let directory: string;
const providers: NativeProvider[] = [];
const sessions: Session[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agents-owned-mcp-stdio-'));
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  await rm(directory, { recursive: true, force: true });
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

async function peer(label: string, field: string, holdCall = false) {
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
      }),
    ),
  ]);
  const declaration = new StdioMCP({
    name: 'fixture',
    tools: ['lookup'],
    approvalMode: 'approve',
    command: process.execPath,
    args: [resolve(import.meta.dirname, 'mcp-peer.mjs'), roster, calls, starts],
    cwd: directory,
  });
  return { calls, starts, declaration };
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
  const original = await peer('original', 'key');
  const current = await peer('current', 'revision');
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
    approvalMode: 'approve',
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
