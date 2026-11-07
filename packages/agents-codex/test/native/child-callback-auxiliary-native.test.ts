// SOURCE-ONLY V2 DRAFT. Original v1 is preserved unchanged. Stage beside
// packages/agents-codex/test/native fixtures before running this new version.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  Environment,
  HttpMCP,
  NativeAgents,
  NativeProvider,
  type ExecutorContext,
  type MCPResultContext,
  type Session,
} from '../../src';
import {
  binding,
  type JsonObject,
  type JsonValue,
  type NativeThread,
} from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

type Route = 'mcp-result' | 'executor-before' | 'executor-after';
type Mode = 'release' | 'cancel' | 'close' | 'reader-end';
type Notice = {
  threadId: string;
  incarnation: string;
  turnId: string;
  callId: string;
  nonce: string;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

// These are failure fuses, not ordering assertions or performance measurements.
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not settle`)),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Arm only after opening, before submit/no child exists. Withhold the first
 * subsequent main wire event and issue no further main native read until release.
 * This differs from holding an already-dequeued child start: the independent
 * auxiliary channel can now race a genuinely unobserved native child start.
 */
async function holdMainBeforeChild(route: Route) {
  const addon = await binding();
  const prototype = addon.NativeThread.prototype;
  const nextMain = prototype._next_session_events;
  const nextAux =
    route === 'mcp-result'
      ? prototype._next_native_mcp_result
      : prototype._next_native_interception;
  const childTurn = prototype._child_turn;
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const end = Promise.withResolvers<void>();
  const auxiliary = Promise.withResolvers<Notice>();
  const actualNull = Promise.withResolvers<Notice>();
  const receipts: Array<{
    childId: string;
    receipt: Awaited<ReturnType<typeof childTurn>>;
  }> = [];
  let physicallyObservedChildStart = false;
  let armed = false,
    released = false,
    ended = false,
    notice: Notice | undefined;
  const readerFailure = new Error(
    'Controlled auxiliary publication reader EOF',
  );
  vi.spyOn(prototype, '_next_session_events').mockImplementation(
    async function (this: NativeThread) {
      const raw = await nextMain.call(this);
      // Track every physically returned entry, including earlier unarmed reads.
      // Inspecting only the first string could hide a start later in a batch.
      for (const wire of raw) {
        const event = JSON.parse(wire);
        if (
          event.subagent_id &&
          ['task_started', 'turn_started'].includes(event.msg?.type)
        )
          physicallyObservedChildStart = true;
      }
      if (armed && !released) {
        // Neither this batch nor an earlier batch may have observed a child start.
        // Otherwise the native-null setup has become a JS-only ordering test.
        expect(physicallyObservedChildStart).toBe(false);
        held.resolve();
        await Promise.race([release.promise, end.promise]);
        if (ended) throw readerFailure;
      }
      return raw;
    },
  );
  const method =
    route === 'mcp-result'
      ? '_next_native_mcp_result'
      : '_next_native_interception';
  vi.spyOn(prototype, method).mockImplementation(async function (
    this: NativeThread,
  ) {
    const raw = await nextAux.call(this);
    if (raw !== 'null') {
      const value = JSON.parse(raw);
      const request = route === 'mcp-result' ? value : value.request;
      const toolName = request?.tool_name;
      const wanted =
        route === 'mcp-result'
          ? request?.call_id === 'child-aux'
          : toolName?.name === 'exec_command' &&
            request?.call_id === 'child-aux' &&
            request?.phase === 'before';
      // Even a result-only executor rule first traverses the SDK's real noop
      // pre-dispatch interception. Observe that dependency, without resolving
      // any nonce ourselves: the command/result callback cannot precede it.
      if (wanted) {
        notice = {
          threadId: request.thread_id,
          incarnation: request.incarnation,
          turnId: request.turn_id,
          callId: request.call_id,
          nonce: value.nonce,
        };
        auxiliary.resolve(notice);
      }
    }
    return raw;
  });
  vi.spyOn(prototype, '_child_turn').mockImplementation(async function (
    this: NativeThread,
    childId,
  ) {
    const receipt = await childTurn.call(this, childId);
    receipts.push({ childId, receipt });
    if (notice && notice.threadId === childId && receipt === null)
      actualNull.resolve(notice);
    return receipt; // Never fabricate or alter the native lookup result.
  });
  return {
    held: held.promise,
    auxiliary: auxiliary.promise,
    actualNull: actualNull.promise,
    receipts,
    arm() {
      armed = true;
    },
    release() {
      released = true;
      release.resolve();
    },
    endReader() {
      ended = true;
      end.resolve();
    },
  };
}

async function mcpPeer() {
  const effects: JsonObject[] = [],
    failures: unknown[] = [];
  const server = createServer(async (request, response) => {
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
      let result: JsonObject = {};
      if (rpc.method === 'initialize')
        result = {
          protocolVersion: rpc.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'aux-publication-peer', version: '1' },
        };
      if (rpc.method === 'tools/list')
        result = {
          tools: [
            {
              name: 'lookup',
              description: 'Read record',
              inputSchema: {
                type: 'object',
                properties: { key: { type: 'string' } },
                required: ['key'],
                additionalProperties: false,
              },
            },
          ],
        };
      if (rpc.method === 'tools/call') {
        effects.push(rpc.params);
        result = { content: [{ type: 'text', text: 'record-result' }] };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing MCP fixture address');
  return {
    effects,
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      expect(failures).toEqual([]);
    },
  };
}

for (const route of [
  'mcp-result',
  'executor-before',
  'executor-after',
] as const) {
  it.each(['release', 'cancel', 'close', 'reader-end'] as const)(
    `waits for real native child publication before ${route} callback (%s)`,
    async (mode: Mode, testContext) => {
      // Only released executor work needs a real strict process sandbox.
      // Keep cancellation, retirement and MCP publication coverage on this host.
      if (
        route !== 'mcp-result' &&
        mode === 'release' &&
        process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1' &&
        process.env.GITHUB_ACTIONS !== 'true' &&
        process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
      )
        testContext.skip();
      const gate = await holdMainBeforeChild(route);
      const context = { account: 'exact-child' };
      let executor: Awaited<ReturnType<typeof startPublicExecutor>> | undefined;
      let peer: Awaited<ReturnType<typeof mcpPeer>> | undefined;
      let provider: NativeProvider | undefined;
      let session: Session<string, typeof context> | undefined;
      let rootOutcome: Promise<unknown> | undefined;
      let callbacks = 0;
      try {
        executor = await startPublicExecutor();
        peer = route === 'mcp-result' ? await mcpPeer() : undefined;
        const observed = Promise.withResolvers<
          MCPResultContext<typeof context> | ExecutorContext<typeof context>
        >();
        const accept = (
          received:
            MCPResultContext<typeof context> | ExecutorContext<typeof context>,
        ) => {
          callbacks++;
          observed.resolve(received);
        };
        let rootId: string | undefined;
        const counts = new Map<string, number>();
        const respond = (request: JsonObject) => {
          const metadata = request.client_metadata as Record<string, string>;
          const id = String(
            JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
          );
          rootId ??= id;
          const count = (counts.get(id) ?? 0) + 1;
          counts.set(id, count);
          if (id === rootId)
            return count === 1
              ? [
                  call(
                    'spawn_agent',
                    {
                      task_name: 'child',
                      message: 'Do the scripted auxiliary work.',
                    },
                    { namespace: 'collaboration', callId: 'spawn' },
                  ),
                ]
              : [message('root done')];
          if (count === 1)
            return [
              route === 'mcp-result'
                ? call(
                    'lookup',
                    { key: 'child' },
                    { namespace: 'mcp__fixture', callId: 'child-aux' },
                  )
                : call(
                    'exec_command',
                    { cmd: 'printf aux-result' },
                    { callId: 'child-aux' },
                  ),
            ];
          const outputs = (request.input as JsonObject[]).filter(
            (item) =>
              item.type === 'function_call_output' &&
              item.call_id === 'child-aux',
          );
          expect(outputs).toHaveLength(1);
          expect(JSON.stringify(outputs[0]!.output)).toContain(
            route === 'mcp-result' ? 'transformed-record' : 'aux-result',
          );
          return [message('child done')];
        };
        const model = new ModelServer(Array.from({ length: 4 }, () => respond));
        const config = await model.config();
        provider = new NativeProvider({
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'synthetic-child-aux-publication',
          supportsWebsockets: false,
        });
        const agent = new Agent<typeof context>({
          instructions: 'Delegate.',
          model: 'gpt-5.5',
          provider,
          programmaticToolCalling: false,
          tools: [
            new NativeAgents(),
            ...(peer
              ? [
                  new HttpMCP({
                    name: 'fixture',
                    url: peer.url,
                    tools: ['lookup'],
                    approvalMode: 'preapproved',
                    transformResult(
                      received: MCPResultContext<typeof context>,
                      result: JsonObject,
                    ) {
                      accept(received);
                      return {
                        ...result,
                        content: [{ type: 'text', text: 'transformed-record' }],
                      };
                    },
                  }),
                ]
              : []),
          ],
        });
        session = await agent.session({
          context,
          environment: new Environment<typeof context>({
            url: executor.url,
            cwd: executor.cwd,
            headers: executor.headers,
            tools: ['exec_command', 'write_stdin', 'apply_patch'],
            ...(route === 'executor-before'
              ? {
                  approval(received: ExecutorContext<typeof context>) {
                    accept(received);
                    return true;
                  },
                }
              : {}),
            ...(route === 'executor-after'
              ? {
                  transformResult(
                    received: ExecutorContext<typeof context>,
                    value: JsonValue,
                  ) {
                    accept(received);
                    return value;
                  },
                }
              : {}),
          }),
        });
        gate.arm();
        const root = await within(
          session.submit('begin'),
          'root admission with held main reader',
        );
        rootOutcome = root.wait().catch((error) => error);
        await within(gate.held, 'held pre-child main native read');
        const notice = await within(
          gate.auxiliary,
          'real independent auxiliary notice',
        );
        expect(
          await within(
            gate.actualNull,
            'actual missing native child-turn receipt',
          ),
        ).toEqual(notice);
        expect(callbacks).toBe(0);
        const starts = () =>
          executor!.requests.filter(
            (request) => request.method === 'process/start',
          );
        if (route === 'mcp-result') expect(peer!.effects).toHaveLength(1);
        else expect(starts()).toHaveLength(0);
        if (mode === 'release') {
          gate.release();
          const received = await within(
            observed.promise,
            'callback after exact child publication',
          );
          expect(received.context).toBe(context);
          expect(received.callId).toBe('child-aux');
          expect(received.submission).toMatchObject({
            sessionId: session.id,
            childId: notice.threadId,
            turnId: notice.turnId,
          });
          const exact = gate.receipts.find(
            (record) =>
              record.childId === notice.threadId && record.receipt !== null,
          )?.receipt;
          expect(exact).toMatchObject({
            incarnation: notice.incarnation,
            turn_id: notice.turnId,
          });
          const children = await Array.fromAsync(session.subagents());
          const child = children.find((row) => row.id === notice.threadId)!;
          expect(child.turn).toBeTruthy();
          expect(received.submission).toMatchObject({
            instanceId: child.turn!.instanceId,
          });
          if ('call' in received)
            expect(received.call).toMatchObject({
              childId: notice.threadId,
              childIncarnation: notice.incarnation,
              turnId: notice.turnId,
              callId: 'child-aux',
              route: 'direct',
            });
          expect(
            (await within(child.turn!.wait(), 'child completion')).finalOutput,
          ).toBe('child done');
          expect(await within(rootOutcome, 'root completion')).toMatchObject({
            finalOutput: 'root done',
          });
          expect(callbacks).toBe(1);
          if (route !== 'mcp-result') expect(starts()).toHaveLength(1);
          model.assertExhausted();
        } else {
          if (mode === 'reader-end') gate.endReader();
          else if (mode === 'cancel')
            await within(
              session.interrupt({ scope: 'all' }),
              'force-stop acceptance before child publication',
            );
          else {
            // close() fences effects synchronously; release the artificial main
            // transport hold afterward so teardown can join the main reader.
            const closing = session.close();
            void closing.catch(() => {});
            gate.release();
            await within(closing, 'close joins unpublished auxiliary callback');
          }
          if (mode !== 'reader-end') gate.release();
          // Root and child lifetimes are independent; a root may already have
          // completed. Require settlement, not an invented root failure shape.
          await within(rootOutcome, 'retired root outcome');
          expect(callbacks).toBe(0);
          if (route !== 'mcp-result') expect(starts()).toHaveLength(0);
        }
      } finally {
        gate.release();
        try {
          await within(
            session?.close() ?? Promise.resolve(),
            'final Session cleanup',
          ).catch((error) => {
            if (mode !== 'reader-end') throw error;
          });
          if (rootOutcome) await within(rootOutcome, 'final root settlement');
          if (mode !== 'release') expect(callbacks).toBe(0);
        } finally {
          try {
            await provider?.close();
          } finally {
            try {
              await peer?.close();
            } finally {
              await executor?.close();
            }
          }
        }
      }
    },
    30000,
  );
}
