import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  HttpMCP,
  NativeProvider,
  tool,
} from '@openai/agents';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { TurnAborted } from '../../src/runtime/session';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function bounded<T>(
  promise: Promise<T>,
  milliseconds = 20_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Required phase did not arrive')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-boundary-proof',
    supportsWebsockets: false,
  });
}

it.skipIf(
  process.platform !== 'linux' ||
    (process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1' &&
      process.env.GITHUB_ACTIONS !== 'true' &&
      process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'),
)(
  'joins entered executor effects after a sibling function failure without claiming rollback',
  async (context) => {
    const temporary = await mkdtemp(join(tmpdir(), 'agents-sibling-effects-'));
    const cwd = await realpath(temporary);
    const bothEntered = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const entered: Array<string | null> = [];
    const cleaned: Array<string | null> = [];
    const effects: string[] = [];
    const problem = new Error('selected sibling function failure');
    const server = new ModelServer([
      [
        call(
          'fail_after_executor_admission',
          {},
          { callId: 'failed-function' },
        ),
        call(
          'exec_command',
          { cmd: 'printf first > effect-first' },
          { callId: 'first-executor' },
        ),
        call(
          'exec_command',
          { cmd: 'printf second > effect-second' },
          { callId: 'second-executor' },
        ),
      ],
      [message('unexpected continuation')],
    ]);
    await using provider = await providerFor(server);
    const fail = tool({
      name: 'fail_after_executor_admission',
      parameters: z.object({}),
      async execute() {
        await bothEntered.promise;
        effects.push('function failed once');
        failed.resolve();
        throw problem;
      },
    });
    const agent = new Agent({
      instructions: 'Run the admitted tools.',
      model: 'gpt-5.5',
      provider,
      tools: [fail],
    });
    const environment = Environment.local({
      cwd,
      tools: ['exec_command'],
      policyTimeout: 10,
      async transformResult(info, value) {
        entered.push(info.callId);
        if (entered.length === 2) bothEntered.resolve();
        try {
          await release.promise;
          return value;
        } finally {
          cleaned.push(info.callId);
        }
      },
    });
    try {
      const opened = await agent
        .session({ environment })
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            /could not establish the platform sandbox/.test(error.message) &&
            process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
          ) {
            expect(server.requests).toHaveLength(0);
            context.skip('This host cannot launch the required native sandbox');
          }
          throw error;
        });
      await using session = opened;
      const turn = await session.submit('Run the admitted work.');
      const result = turn.wait();
      let settled = false;
      void result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await bounded(Promise.all([bothEntered.promise, failed.promise]));
        expect(new Set(entered).size).toBe(2);
        expect(await readFile(join(cwd, 'effect-first'), 'utf8')).toBe('first');
        expect(await readFile(join(cwd, 'effect-second'), 'utf8')).toBe(
          'second',
        );
        await delay(100);
        expect(settled).toBe(false);
        expect(cleaned).toEqual([]);
        expect(effects).toEqual(['function failed once']);
        expect(server.requests).toHaveLength(1);
      } finally {
        release.resolve();
        await Promise.allSettled([result]);
      }
      await expect(result).rejects.toBe(problem);
      expect(await readFile(join(cwd, 'effect-first'), 'utf8')).toBe('first');
      expect(await readFile(join(cwd, 'effect-second'), 'utf8')).toBe('second');
      expect(cleaned.sort()).toEqual(entered.sort());
      expect(effects).toEqual(['function failed once']);
      expect(server.requests).toHaveLength(1);
      expect(
        JSON.stringify(await Array.fromAsync(session.items())),
      ).not.toContain('selected sibling function failure');
    } finally {
      release.resolve();
      await rm(temporary, { recursive: true, force: true });
    }
  },
  60_000,
);

it('cancels an entered MCP call without inventing native end events or rolling back its peer effect', async () => {
  const entered = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const effects: unknown[] = [];
  const failures: unknown[] = [];
  const peer = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result;
      if (rpc.method === 'initialize')
        result = {
          protocolVersion: rpc.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'held-peer', version: '1' },
        };
      else if (rpc.method === 'tools/list')
        result = {
          tools: [
            { name: 'lookup', inputSchema: { type: 'object', properties: {} } },
          ],
        };
      else if (rpc.method === 'tools/call') {
        effects.push(rpc.params);
        entered.resolve();
        await release.promise;
        result = { content: [{ type: 'text', text: 'held peer result' }] };
      } else result = {};
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) {
      failures.push(error);
      response.destroy();
    }
  });
  peer.listen(0, '127.0.0.1');
  await once(peer, 'listening');
  const address = peer.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP peer');
  const native = await binding();
  const next = native.NativeThread.prototype._next_session_events;
  const delivered: Array<{ msg?: { type?: string; call_id?: string } }> = [];
  const recording = vi
    .spyOn(native.NativeThread.prototype, '_next_session_events')
    .mockImplementation(async function (this: NativeThread) {
      const events = await next.call(this);
      delivered.push(...events.map((raw) => JSON.parse(raw)));
      return events;
    });
  const server = new ModelServer([
    [call('lookup', {}, { namespace: 'mcp__held', callId: 'cancel-call' })],
  ]);
  const provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Use lookup.',
    model: 'gpt-5.5',
    provider,
    tools: [
      new HttpMCP({
        name: 'held',
        url: `http://127.0.0.1:${address.port}/mcp`,
        tools: ['lookup'],
        approvalMode: 'preapproved',
      }),
    ],
  });
  let session: Awaited<ReturnType<typeof agent.session>> | undefined;
  try {
    session = await agent.session();
    const turn = await session.submit('Look up once.');
    const observations = (async () => {
      const events = [];
      for await (const event of turn.events()) {
        events.push(event);
        if (
          event.type === 'tool_started' &&
          event.family === 'mcp' &&
          event.callId === 'cancel-call'
        )
          started.resolve();
        if (event.type === 'turn_finished') break;
      }
      return events;
    })();
    const result = turn.wait();
    void result.catch(() => {});
    await bounded(Promise.all([entered.promise, started.promise]));
    await bounded(turn.cancel({ mode: 'force' }));
    await expect(result).rejects.toBeInstanceOf(TurnAborted);
    const events = await bounded(observations);
    const ends = events.flatMap((event) =>
      event.type === 'tool_finished' && event.family === 'mcp'
        ? [{ callId: event.callId, status: event.status }]
        : [],
    );
    const nativeEnds = delivered.filter(
      (event) => event.msg?.type === 'mcp_tool_call_end',
    );
    expect(ends.map((event) => event.callId)).toEqual(
      nativeEnds.map((event) => event.msg?.call_id),
    );
    expect(ends.every((event) => event.status === 'failed')).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: 'turn_finished',
      status: 'cancelled',
    });
    expect(effects).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
    expect(failures).toEqual([]);
    server.assertExhausted();
  } finally {
    release.resolve();
    try {
      await session?.close();
    } finally {
      try {
        await provider.close();
      } finally {
        recording.mockRestore();
        const closed = once(peer, 'close');
        peer.close();
        peer.closeAllConnections();
        await closed;
      }
    }
  }
}, 30_000);
