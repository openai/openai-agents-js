import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  Environment,
  NativeError,
  NativeProvider,
  StdioMCP,
  type Turn,
} from '@openai/agents';
import { ModelServer, call } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

it('rejects a policy waiting on its own turn and joins the held policy before releasing the provider', async () => {
  const executor = await startPublicExecutor();
  const model = new ModelServer([
    [call('exec_command', { cmd: 'true' }, { callId: 'held-approval' })],
  ]);
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
  });
  const entered = Promise.withResolvers<unknown>();
  const release = Promise.withResolvers<void>();
  const lifecycle: string[] = [];
  let suppliedTurn: Turn<unknown> | undefined;
  const agent = new Agent({
    instructions: 'Use the selected command.',
    model: 'gpt-5',
    provider,
  });
  let session: Awaited<ReturnType<typeof agent.session>> | undefined;
  let completion: Promise<unknown> | undefined;
  try {
    session = await agent.session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command'],
        async approval(info) {
          suppliedTurn = info.submission as Turn<unknown>;
          const selfWait = Promise.resolve()
            .then(() => suppliedTurn!.wait())
            .then(
              () => undefined,
              (error: unknown) => error,
            );
          // A missing ownership guard must fail the assertion, not deadlock the test.
          entered.resolve(
            await Promise.race([selfWait, delay(300, 'pending')]),
          );
          await release.promise;
          lifecycle.push('callback finished');
          return false;
        },
      }),
    });
    const turn = await session.submit('begin');
    completion = turn.wait().catch((error: unknown) => error);
    expect(await entered.promise).toBeInstanceOf(NativeError);
    expect(suppliedTurn).toBe(turn);

    const closing = session.close().then(() => {
      lifecycle.push('session closed');
      return 'closed';
    });
    expect(await Promise.race([closing, delay(100, 'held')])).toBe('held');
    expect(lifecycle).toEqual([]);
    await expect(provider.close()).rejects.toBeInstanceOf(Error);

    release.resolve();
    await closing;
    await completion;
    await provider.close();
    lifecycle.push('provider closed');
    expect(lifecycle).toEqual([
      'callback finished',
      'session closed',
      'provider closed',
    ]);
    expect(
      executor.requests.filter((request) => request.method === 'process/start'),
    ).toEqual([]);
    model.assertExhausted();
  } finally {
    release.resolve();
    try {
      try {
        await session?.close();
        await completion;
      } finally {
        await provider.close();
      }
    } finally {
      await executor.close();
    }
  }
}, 10_000);

it('reports executor approval failures without exposing callback error details', async () => {
  const executor = await startPublicExecutor();
  const model = new ModelServer([
    [call('exec_command', { cmd: 'true' }, { callId: 'failed-approval' })],
  ]);
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
  });
  const privateDetail = 'synthetic-private-approval-detail';
  const original = new Error(privateDetail);
  let seen: unknown;
  const agent = new Agent({
    instructions: 'Use the command.',
    model: 'gpt-5',
    provider,
  });
  let session: Awaited<ReturnType<typeof agent.session>> | undefined;
  try {
    session = await agent.session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command'],
        approval(_context, args) {
          seen = args;
          throw original;
        },
      }),
    });
    const turn = await session.submit('begin');
    const error: unknown = await turn
      .wait()
      .catch((failure: unknown) => failure);
    expect(seen).toMatchObject({ cmd: 'true' });
    expect(error).toBeInstanceOf(NativeError);
    expect(error).not.toBe(original);
    expect(inspect(error, { depth: 10 })).not.toContain(privateDetail);
    expect(
      executor.requests.filter((request) => request.method === 'process/start'),
    ).toEqual([]);
    expect(JSON.stringify(model.requests)).not.toContain(privateDetail);
    model.assertExhausted();
  } finally {
    try {
      await session?.close();
    } finally {
      try {
        await provider.close();
      } finally {
        await executor.close();
      }
    }
  }
}, 10_000);

it('withholds a rejected MCP result and sanitizes its transform error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-mcp-policy-error-'));
  const roster = join(directory, 'roster.json');
  const calls = join(directory, 'calls.jsonl');
  const privateDetail = 'synthetic-private-mcp-result';
  await writeFile(
    roster,
    JSON.stringify({
      tools: [
        {
          name: 'lookup',
          description: 'Read a record',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      result: { content: [{ type: 'text', text: privateDetail }] },
    }),
  );
  const model = new ModelServer([
    [
      call(
        'lookup',
        {},
        { namespace: 'mcp__fixture', callId: 'failed-transform' },
      ),
    ],
  ]);
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
  });
  let seen: unknown;
  const agent = new Agent({
    instructions: 'Use lookup.',
    model: 'gpt-5',
    provider,
    tools: [
      new StdioMCP({
        name: 'fixture',
        command: process.execPath,
        args: [resolve(import.meta.dirname, 'mcp-peer.mjs'), roster, calls],
        tools: ['lookup'],
        approvalMode: 'approve',
        transformResult(_context, value) {
          seen = value;
          throw new Error(JSON.stringify(value));
        },
      }),
    ],
  });
  let session: Awaited<ReturnType<typeof agent.session>> | undefined;
  try {
    session = await agent.session();
    const turn = await session.submit('begin');
    const error: unknown = await turn
      .wait()
      .catch((failure: unknown) => failure);
    expect(seen, inspect(error)).toMatchObject({
      content: [{ type: 'text', text: privateDetail }],
    });
    expect(JSON.parse((await readFile(calls, 'utf8')).trim())).toMatchObject({
      name: 'lookup',
    });
    expect(error).toBeInstanceOf(NativeError);
    expect(inspect(error, { depth: 10 })).not.toContain(privateDetail);
    const history = [];
    for await (const item of session.items()) history.push(item);
    expect(JSON.stringify(history)).not.toContain(privateDetail);
    expect(JSON.stringify(model.requests)).not.toContain(privateDetail);
    model.assertExhausted();
  } finally {
    try {
      await session?.close();
    } finally {
      try {
        await provider.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}, 10_000);
