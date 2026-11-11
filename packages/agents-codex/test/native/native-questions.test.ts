import { firstNativeBatchWire } from '../fixtures/native-event-batches';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  createServer,
  request as forwardHttp,
  type ServerResponse,
} from 'node:http';
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  it,
  onTestFailed,
  vi,
} from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  HttpMCP,
  InteractionRequired,
  NativeAgents,
  NativeProvider,
  StdioMCP,
  manualTool,
  type ChildBeforeStepContext,
} from '../../src';
import {
  binding,
  type Engine,
  type JsonObject,
  type NativeThread,
} from '../../src/runtime/binding';
import { TurnAborted } from '../../src/runtime/session';
import * as telemetry from '../../src/runtime/telemetry';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

beforeAll(async () => {
  await telemetry.configure({ traceProcessors: [{ onEvent() {} }] });
});

afterAll(async () => {
  await telemetry.shutdown();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

// A real MCP peer. This does not manufacture a Core question or owner identity.
async function fixture(
  options: {
    startupQuestion?: boolean;
    completeStartupList?: Promise<void>;
    missingSelectedTool?: boolean;
    formOrigin?: 'previous' | 'current';
    deferGetUntilPostHeaders?: boolean;
    retireExtraGetBeforeQuestion?: boolean;
    urlQuestion?: boolean;
    urlCompletion?: boolean;
    urlRequired?: boolean;
    idleQuestion?: boolean;
    childQuestion?: boolean;
    childAgents?: NativeAgents;
    spawnSibling?: boolean;
  } = {},
) {
  const calls: unknown[] = [];
  const methods: string[] = [];
  const failures: unknown[] = [];
  const formReplies: { result?: { action?: string; content?: unknown } }[] = [];
  const questionAnswered = Promise.withResolvers<void>();
  const startupFormReply =
    Promise.withResolvers<(typeof formReplies)[number]>();
  const idleReplies = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<(typeof formReplies)[number]>>
  >();
  const sessionStream = !!(
    options.formOrigin ||
    options.urlQuestion ||
    options.urlRequired ||
    options.idleQuestion ||
    options.childQuestion
  );
  // Failure-only, bounded protocol evidence for the unsolicited GET fixtures.
  // Keep headers, URLs, arguments, descriptions and result payloads out of logs.
  const diagnosticEnabled =
    !!options.idleQuestion ||
    !!options.urlRequired ||
    (!!(options.formOrigin || options.urlQuestion) && !options.urlCompletion);
  const diagnosticStart = Date.now();
  const diagnosticRows: Record<string, unknown>[] = [];
  let droppedDiagnosticRows = 0;
  let getCount = 0;
  let firstGet: number | undefined;
  let latestGet: number | undefined;
  const trace = (phase: string, fields: Record<string, unknown> = {}) => {
    if (!diagnosticEnabled) return;
    if (diagnosticRows.length === 64) {
      droppedDiagnosticRows++;
      return;
    }
    diagnosticRows.push({
      atMs: Date.now() - diagnosticStart,
      phase,
      ...fields,
    });
  };
  const version = (value: unknown) =>
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value
      : value == null
        ? null
        : '<other>';
  const rpcId = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value)
      ? value
      : typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,96}$/.test(value)
        ? value
        : value == null
          ? null
          : '<other>';
  const rpcMethod = (value: unknown) =>
    [
      'initialize',
      'server/discover',
      'notifications/initialized',
      'tools/list',
      'tools/call',
      'ping',
      'logging/setLevel',
      'notifications/cancelled',
    ].includes(String(value))
      ? String(value)
      : value == null
        ? 'reply'
        : '<other>';
  if (diagnosticEnabled)
    onTestFailed(({ task }) => {
      const details: string[] = [];
      const emit = (label: string, row: Record<string, unknown>) => {
        const text = JSON.stringify(row);
        for (let offset = 0; offset < text.length; offset += 120)
          details.push(
            `[native-question-fixture] ${label}[${offset / 120}] ${text.slice(offset, offset + 120)}`,
          );
      };
      // CI caps each output line at 200 characters. Keep the latest retained
      // phase first and split each record so the useful fields remain visible.
      diagnosticRows.toReversed().forEach((row, index) => {
        emit(`phase-${index}`, row);
      });
      emit('summary', {
        kind: options.idleQuestion
          ? 'idle-form'
          : (options.formOrigin ?? 'url'),
        calls: calls.length,
        formOrigins,
        replyCount: formReplies.length,
        getCount,
        firstGet,
        latestGet,
        droppedRows: droppedDiagnosticRows,
      });
      const error = task.result?.errors?.[0];
      if (error) error.message += `\n${details.join('\n')}`;
    });
  const disconnected = Promise.withResolvers<void>();
  const childFormSent = Promise.withResolvers<void>();
  const childToolEntered = Promise.withResolvers<void>();
  const releaseChildForm = Promise.withResolvers<void>();
  const childFormReply = Promise.withResolvers<(typeof formReplies)[number]>();
  const childToolDisconnected = Promise.withResolvers<void>();
  const releaseChildModel = Promise.withResolvers<void>();
  const releaseChildFinal = Promise.withResolvers<void>();
  let interruptedUrlChild: string | undefined;
  let finishForm: (() => void) | undefined;
  let activeGet: { get: number; response: ServerResponse } | undefined;
  const liveGets = new Map<string, ServerResponse>();
  const openGets = new Map<
    ServerResponse,
    { get: number; clientSession: string }
  >();
  let idleOwnerSession: string | undefined;
  let urlOwnerSession: string | undefined;
  let nextClientSession = 0;
  let nextGet = Promise.withResolvers<void>();
  const formOrigins: number[] = [];
  let lateFromA: (() => Promise<void>) | undefined;
  const form =
    options.urlQuestion || options.urlRequired
      ? {
          jsonrpc: '2.0',
          id: 873,
          method: 'elicitation/create',
          params: {
            mode: 'url',
            message: 'Private verification',
            url: 'https://verification.invalid/private',
            elicitationId: 'fixture-verification',
          },
        }
      : {
          jsonrpc: '2.0',
          id: 873,
          method: 'elicitation/create',
          params: {
            mode: 'form',
            message: 'Confirm a fixture value',
            requestedSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
            },
          },
        };
  const peer = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && sessionStream) {
        const clientSession = String(
          request.headers['mcp-session-id'] ?? 'questions-fixture',
        );
        liveGets.set(clientSession, response);
        const get = ++getCount;
        openGets.set(response, { get, clientSession });
        firstGet ??= get;
        latestGet = get;
        trace('get_connected', {
          get,
          protocolHeader: version(request.headers['mcp-protocol-version']),
        });
        response.once('close', () => {
          trace('get_closed', {
            get,
            destroyed: response.destroyed,
            writableEnded: response.writableEnded,
          });
          openGets.delete(response);
          const remaining = [...openGets.entries()]
            .reverse()
            .filter(
              ([stream]) =>
                !stream.destroyed && !stream.writableEnded && stream.writable,
            );
          if (activeGet?.response === response) {
            const newest = remaining[0];
            activeGet = newest
              ? { get: newest[1].get, response: newest[0] }
              : undefined;
          }
          if (liveGets.get(clientSession) === response) {
            const newest = remaining.find(
              ([, identity]) => identity.clientSession === clientSession,
            );
            if (newest) liveGets.set(clientSession, newest[0]);
            else liveGets.delete(clientSession);
          }
          const ready = nextGet;
          nextGet = Promise.withResolvers<void>();
          ready.resolve();
        });
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'mcp-session-id': clientSession,
        });
        response.flushHeaders();
        activeGet = { get, response };
        const ready = nextGet;
        nextGet = Promise.withResolvers<void>();
        ready.resolve();
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      const clientSession =
        typeof request.headers['mcp-session-id'] === 'string'
          ? request.headers['mcp-session-id']
          : (options.idleQuestion || options.urlCompletion) &&
              rpc.method === 'initialize'
            ? `questions-fixture-${++nextClientSession}`
            : 'questions-fixture';
      trace('rpc_post', {
        method: rpcMethod(rpc.method),
        id: rpcId(rpc.id),
        protocolHeader: version(request.headers['mcp-protocol-version']),
        requestedVersion: version(rpc.params?.protocolVersion),
        requestedVersions: Array.isArray(rpc.params?.supportedVersions)
          ? rpc.params.supportedVersions.slice(0, 4).map(version)
          : undefined,
      });
      if (typeof rpc.method === 'string') methods.push(rpc.method);
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (!rpc.method) {
        formReplies.push(rpc);
        questionAnswered.resolve();
        if (options.startupQuestion && rpc.id === form.id)
          startupFormReply.resolve(rpc);
        if (options.childQuestion) childFormReply.resolve(rpc);
        idleReplies.get(rpc.id)?.resolve(rpc);
        trace('question_reply_received', {
          id: rpcId(rpc.id),
          declined: rpc.result?.action === 'decline',
        });
        response.writeHead(202).end();
        finishForm?.();
        return;
      }
      let result: unknown;
      switch (rpc.method) {
        case 'initialize':
          trace('initialize_response', {
            requestedVersion: version(rpc.params.protocolVersion),
            negotiatedVersion: version(rpc.params.protocolVersion),
          });
          result = {
            protocolVersion: rpc.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'questions-fixture', version: '1' },
          };
          break;
        case 'tools/list':
          if (options.idleQuestion) idleOwnerSession ??= clientSession;
          result = {
            tools: options.missingSelectedTool
              ? []
              : [
                  {
                    name: 'lookup',
                    description: 'Change a fixture record',
                    annotations: { destructiveHint: true, readOnlyHint: false },
                    inputSchema: {
                      type: 'object',
                      properties: {},
                      additionalProperties: false,
                    },
                  },
                ],
          };
          if (options.startupQuestion) {
            response.once('close', () => disconnected.resolve());
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.write(`event: message\ndata: ${JSON.stringify(form)}\n\n`);
            // Discovery finishes only after the peer receives this request's
            // actual refusal; an optional gate still controls publication.
            void Promise.all([
              startupFormReply.promise,
              options.completeStartupList,
            ])
              .then(() => {
                if (!response.destroyed && !response.writableEnded)
                  response.end(
                    `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`,
                  );
              })
              .catch((error: unknown) => failures.push(error));
            return;
          }
          break;
        case 'tools/call':
          calls.push(rpc.params);
          if (options.idleQuestion) idleOwnerSession = clientSession;
          if (options.retireExtraGetBeforeQuestion && calls.length === 2) {
            expect(openGets.size).toBeGreaterThan(0);
            await new Promise<void>((resolve, reject) => {
              const probe = forwardHttp(
                `http://127.0.0.1:${endpointPort}`,
                {
                  headers: {
                    accept: 'text/event-stream',
                    'mcp-session-id': clientSession,
                    'mcp-protocol-version': '2024-11-05',
                  },
                },
                (response) => {
                  const stream = activeGet?.response;
                  if (!stream) {
                    response.destroy();
                    reject(new Error('Expected the redundant GET stream'));
                    return;
                  }
                  const closed = once(stream, 'close');
                  response.on('error', () => {});
                  response.destroy();
                  void closed.then(() => resolve(), reject);
                },
              );
              probe.once('error', reject);
              probe.end();
            });
          }
          if (options.urlQuestion || options.urlRequired)
            urlOwnerSession = clientSession;
          if (options.urlRequired) {
            while (!activeGet || activeGet.response.destroyed)
              await nextGet.promise;
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: rpc.id,
                error: {
                  code: -32042,
                  message: 'URL interaction required',
                  data: {
                    elicitations: [
                      {
                        mode: 'url',
                        elicitationId: 'fixture-verification',
                        url: 'https://verification.invalid/private',
                        message: 'Synthetic consent',
                      },
                    ],
                  },
                },
              }),
            );
            return;
          }
          if (options.childQuestion) {
            // Only the scripted real child calls lookup. Keep its actual
            // transport open until the client responds or owns its teardown.
            response.once('close', () => childToolDisconnected.resolve());
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.flushHeaders();
            finishForm = () => {
              response.end(
                `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'fixture result' }] } })}\n\n`,
              );
            };
            childToolEntered.resolve();
            await releaseChildForm.promise;
            response.write(`event: message\ndata: ${JSON.stringify(form)}\n\n`);
            childFormSent.resolve();
            return;
          }
          if (options.formOrigin || options.urlQuestion) {
            const origin = calls.length;
            const sendFromThisCall = async () => {
              trace('question_wait_get', { origin });
              let selected = options.urlCompletion
                ? (() => {
                    const response = liveGets.get(clientSession);
                    return response ? { get: getCount, response } : undefined;
                  })()
                : activeGet;
              while (
                !selected ||
                selected.response.destroyed ||
                selected.response.writableEnded ||
                !selected.response.writable
              ) {
                await nextGet.promise;
                selected = options.urlCompletion
                  ? (() => {
                      const response = liveGets.get(clientSession);
                      return response ? { get: getCount, response } : undefined;
                    })()
                  : activeGet;
              }
              const output = selected.response;
              trace('question_write_get', {
                origin,
                targetGet: selected.get,
                latestGet,
                destroyed: output.destroyed,
                writableEnded: output.writableEnded,
                writable: output.writable,
                headersSent: output.headersSent,
              });
              formOrigins.push(origin);
              output.write(`event: message\ndata: ${JSON.stringify(form)}\n\n`);
            };
            if (calls.length === 1) lateFromA = sendFromThisCall;
            if (calls.length === (options.urlQuestion ? 1 : 2)) {
              // A's retained callback or B's current callback sends the same
              // server request on the same unsolicited GET stream.
              response.writeHead(200, { 'content-type': 'text/event-stream' });
              response.flushHeaders();
              trace('tool_call_held', {
                id: rpcId(rpc.id),
                origin,
                headersSent: response.headersSent,
              });
              finishForm = () => {
                trace('tool_call_released', { id: rpcId(rpc.id), origin });
                response.end(
                  `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'fixture result' }] } })}\n\n`,
                );
              };
              const send =
                options.formOrigin === 'previous'
                  ? lateFromA
                  : sendFromThisCall;
              if (!send) throw new Error('Missing retained A callback');
              await send();
              return;
            }
          }
          result = { content: [{ type: 'text', text: 'fixture result' }] };
          break;
        default:
          result = {};
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        ...(sessionStream ? { 'mcp-session-id': clientSession } : {}),
      });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  peer.listen(0, '127.0.0.1');
  await once(peer, 'listening');
  const address = peer.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP peer');
  // Exercise legal request ordering: a GET can arrive after the held POST's
  // response headers. Forwarding waits for actual headers, not a timer.
  const postHeaders = Promise.withResolvers<void>();
  const proxy = options.deferGetUntilPostHeaders
    ? createServer((request, response) => {
        const forward = () => {
          if (response.destroyed) return;
          const upstream = forwardHttp(
            {
              hostname: '127.0.0.1',
              port: address.port,
              method: request.method,
              path: request.url,
              headers: request.headers,
            },
            (incoming) => {
              if (
                request.method === 'POST' &&
                incoming.headers['content-type']?.startsWith(
                  'text/event-stream',
                )
              )
                postHeaders.resolve();
              response.writeHead(incoming.statusCode ?? 502, incoming.headers);
              incoming.pipe(response);
            },
          );
          upstream.on('error', () => response.destroy());
          response.once('close', () => upstream.destroy());
          request.pipe(upstream);
        };
        if (request.method === 'GET') void postHeaders.promise.then(forward);
        else forward();
      })
    : undefined;
  if (proxy) {
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
  }
  const proxyAddress = proxy?.address();
  const endpointPort =
    proxyAddress && typeof proxyAddress !== 'string'
      ? proxyAddress.port
      : address.port;
  let rootModelId: string | undefined;
  const childModelCounts = new Map<string, number>();
  const childModelInputs: JsonObject[] = [];
  let urlChildId: string | undefined;
  const childResponse = async (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    const id = String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
    rootModelId ??= id;
    const count = (childModelCounts.get(id) ?? 0) + 1;
    childModelCounts.set(id, count);
    if (id !== rootModelId) {
      if (options.spawnSibling) {
        urlChildId ??= id;
        if (id !== urlChildId) return [message('sibling done')];
      }
      childModelInputs.push(request);
      if (options.urlQuestion && count > 1) await releaseChildFinal.promise;
      return count === 1
        ? [
            call(
              'lookup',
              {},
              { namespace: 'mcp__fixture', callId: 'child-form-call' },
            ),
          ]
        : [message('child done')];
    }
    if (count === 1)
      return [
        call(
          'spawn_agent',
          {
            task_name: 'form_child',
            message: 'Call lookup once.',
          },
          { namespace: 'collaboration', callId: 'spawn-form-child' },
        ),
        ...(options.spawnSibling
          ? [
              call(
                'spawn_agent',
                {
                  task_name: 'lookup_peer',
                  message: 'Call lookup once.',
                },
                { namespace: 'collaboration', callId: 'spawn-url-peer' },
              ),
            ]
          : []),
      ];
    // Keep the real root active while its child asks. The test releases it
    // after the child's actual refusal response and normal completion.
    await releaseChildModel.promise;
    if (interruptedUrlChild && count === 2)
      return [
        call(
          'interrupt_agent',
          { target: interruptedUrlChild },
          {
            namespace: 'collaboration',
            callId: 'interrupt-url-child',
          },
        ),
      ];
    return [message('root done')];
  };
  const model = new ModelServer(
    options.childQuestion
      ? Array.from({ length: options.urlQuestion ? 6 : 4 }, () => childResponse)
      : options.formOrigin
        ? [
            [
              call(
                'lookup',
                {},
                { namespace: 'mcp__fixture', callId: 'call-A' },
              ),
            ],
            [
              call(
                'lookup',
                {},
                { namespace: 'mcp__fixture', callId: 'call-B' },
              ),
            ],
            [message('done')],
          ]
        : [
            [
              call(
                'lookup',
                {},
                { namespace: 'mcp__fixture', callId: 'approval-call' },
              ),
            ],
            [message('done')],
          ],
  );
  const config = await model.config();
  const route = config['model_providers.fixture'] as { base_url: string };
  const provider = new NativeProvider({
    baseUrl: route.base_url,
    apiKey: 'fixture',
  });
  const agent = new Agent({
    instructions: 'Call lookup once.',
    model: options.childQuestion ? 'gpt-5.5' : 'gpt-5',
    provider,
    tools: [
      ...(options.childQuestion
        ? [
            options.childAgents ??
              (options.urlQuestion
                ? new NativeAgents({ interactions: true })
                : new NativeAgents()),
          ]
        : []),
      new HttpMCP({
        name: 'fixture',
        url: `http://127.0.0.1:${endpointPort}`,
        tools: ['lookup'],
        approvalMode: sessionStream ? 'preapproved' : 'native',
      }),
    ],
  });
  return {
    agent,
    calls,
    methods,
    formReplies,
    questionAnswered: questionAnswered.promise,
    formOrigins,
    model,
    disconnected: disconnected.promise,
    startupFormReply: startupFormReply.promise,
    childFormSent: childFormSent.promise,
    childToolEntered: childToolEntered.promise,
    releaseChildForm: () => releaseChildForm.resolve(),
    childFormReply: childFormReply.promise,
    childModelInputs,
    childToolDisconnected: childToolDisconnected.promise,
    releaseChildModel: () => releaseChildModel.resolve(),
    releaseChildFinal: () => releaseChildFinal.resolve(),
    interruptUrlChild: (id: string) => {
      interruptedUrlChild = id;
      releaseChildModel.resolve();
    },
    trace,
    openUrlStreams: () => openGets.size,
    async completeUrl(elicitationId = 'fixture-verification') {
      let selected = urlOwnerSession
        ? liveGets.get(urlOwnerSession)
        : activeGet?.response;
      while (!selected || selected.destroyed || selected.writableEnded) {
        await nextGet.promise;
        selected = urlOwnerSession
          ? liveGets.get(urlOwnerSession)
          : activeGet?.response;
      }
      selected.write(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/elicitation/complete',
          params: { elicitationId },
        })}\n\n`,
      );
    },
    async emitIdleForm(id: number) {
      trace('idle_form_wait_get', { id, ownerReady: !!idleOwnerSession });
      const selected = await vi.waitFor(
        () => {
          const stream = idleOwnerSession
            ? liveGets.get(idleOwnerSession)
            : undefined;
          if (!stream || stream.destroyed || stream.writableEnded)
            throw new Error('No live GET for the idle MCP session');
          return stream;
        },
        { timeout: 8_000, interval: 20 },
      );
      const reply = Promise.withResolvers<(typeof formReplies)[number]>();
      idleReplies.set(id, reply);
      const timeout = setTimeout(
        () => reply.reject(new Error(`No reply for idle MCP form ${id}`)),
        8_000,
      );
      try {
        trace('idle_form_write_get', {
          id,
          get: openGets.get(selected)?.get,
          getCount,
        });
        selected.write(
          `event: message\ndata: ${JSON.stringify({ ...form, id })}\n\n`,
        );
        return await reply.promise;
      } finally {
        clearTimeout(timeout);
        idleReplies.delete(id);
      }
    },
    async close() {
      trace('fixture_close_begin');
      const errors: unknown[] = [];
      try {
        await provider.close();
      } catch (error) {
        errors.push(error);
      }
      if (proxy) {
        proxy.closeAllConnections();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
      peer.closeAllConnections();
      try {
        await new Promise<void>((resolve, reject) =>
          peer.close((error) => (error ? reject(error) : resolve())),
        );
      } catch (error) {
        errors.push(error);
      }
      errors.push(...failures);
      if (errors.length)
        throw new AggregateError(errors, 'MCP fixture cleanup failed');
      trace('fixture_close_complete');
    },
  };
}

it('refuses real idle forms before and after a root without issuing an application grant', async () => {
  const f = await fixture({ idleQuestion: true });
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    f.trace('idle_session_open_wait');
    session = await f.agent.session();
    f.trace('idle_session_open_complete');
    const before = await f.emitIdleForm(874);
    expect(before).toMatchObject({ result: { action: 'cancel' } });
    expect(before.result?.content ?? null).toBeNull();
    // The peer's actual reply is the barrier. This is not a timing-only scan
    // performed before the real native question could reach the reader.
    expect(await session.pendingInteractions()).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(f.model.requests).toEqual([]);

    const turn = await session.submit('Read the fixture');
    expect((await turn.wait()).finalOutput).toBe('done');
    f.trace('idle_root_complete');
    expect(f.calls).toHaveLength(1);
    const after = await f.emitIdleForm(875);
    expect(after).toMatchObject({ result: { action: 'cancel' } });
    expect(after.result?.content ?? null).toBeNull();
    expect(await session.pendingInteractions()).toEqual([]);
    expect(f.formReplies).toHaveLength(2);
  } finally {
    try {
      f.trace('idle_session_close_wait');
      await session?.close();
      f.trace('idle_session_close_complete');
    } finally {
      await f.close();
    }
  }
}, 30_000);

// NativeAgents' fixed native policy declines these peer requests before
// application registration. This does not claim an issued Core child token.
for (const queuedInput of [false, true]) {
  it(`refuses a real child form by native policy with queued input=${queuedInput} and preserves child and root work`, async () => {
    const executor = await startPublicExecutor();
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    let session: Awaited<ReturnType<Agent['session']>> | undefined;
    let observing: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observed: unknown[] = [];
    let phase = 'fixture opening';
    const step = (next: string) => {
      phase = next;
    };
    try {
      f = await fixture({ childQuestion: true });
      step('session opening');
      session = await f.agent.session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      const interactions = session.interactions();
      observing = (async () => {
        for await (const request of interactions) {
          observed.push(request);
        }
      })();
      observing.catch(() => {});
      step('root submission');
      const root = await session.submit('Delegate lookup to the child');
      const completion = root.wait();
      completion.catch(() => {});
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`Child form test did not settle during ${phase}`)),
          10_000,
        );
      });
      deadline.catch(() => {});
      step('child tools/call entry');
      await Promise.race([
        f.childToolEntered,
        deadline,
        completion.then(() => {
          throw new Error('Root completed before the child form');
        }),
      ]);
      expect(f.calls).toHaveLength(1);
      step('child owner snapshot');
      const childSession = session;
      const children = await vi.waitFor(
        async () => {
          const children = await Array.fromAsync(childSession.subagents());
          expect(children[0]?.turn).toBeTruthy();
          return children;
        },
        { timeout: 5_000 },
      );
      expect(children).toHaveLength(1);
      const child = children[0];
      if (!child.turn) throw new Error('Expected the actual live child turn');
      const queuedText = 'Preserve this queued child input';
      if (queuedInput) {
        // The peer has entered tools/call but has not emitted its form. Public
        // submission acknowledges steering before the refusal can be processed.
        step('queued child submission');
        const steered = await Promise.race([
          child.submit(queuedText),
          deadline,
        ]);
        expect(steered.turnId).toBe(child.turn.turnId);
        step('queued child submission accepted');
      }
      step('form emission');
      f.releaseChildForm();
      await Promise.race([f.childFormSent, deadline]);
      step('actual peer form reply');
      const reply = await Promise.race([f.childFormReply, deadline]);
      step('actual peer form reply received');
      expect(reply).toMatchObject({ id: 873, result: { action: 'decline' } });
      expect(reply.result?.content ?? null).toBeNull();
      step('child normal completion');
      expect(
        (await Promise.race([child.turn.wait(), deadline])).finalOutput,
      ).toBe('child done');
      step('child normal completion received');
      step('child tools/call disconnect');
      await Promise.race([f.childToolDisconnected, deadline]);
      step('child tools/call disconnect received');
      expect(observed).toEqual([]);
      expect(
        f.formReplies.some((reply) => reply.result?.action === 'accept'),
      ).toBe(false);
      if (queuedInput)
        expect(
          f.childModelInputs.some((request) =>
            JSON.stringify(request.input).includes(queuedText),
          ),
        ).toBe(true);
      step('root model release');
      f.releaseChildModel();
      step('root normal completion');
      expect((await Promise.race([completion, deadline])).finalOutput).toBe(
        'root done',
      );
      step('root normal completion received');
      expect(await session.pendingInteractions()).toEqual([]);
    } finally {
      step('test cleanup');
      if (timer) clearTimeout(timer);
      f?.releaseChildForm();
      f?.releaseChildModel();
      try {
        await session?.close();
      } finally {
        try {
          await observing;
        } finally {
          try {
            await f?.close();
          } finally {
            await executor.close();
          }
        }
      }
    }
  }, 30_000);
}

it('waits for an owned MCP approval, preserves manual-only observation, and consumes one reply', async () => {
  const f = await fixture();
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  let foreign: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    session = await f.agent.session();
    const turn = await session.submit('Change the fixture');
    const batch = await turn.wait({ until: 'interaction' });
    if (!('requests' in batch))
      throw new Error('Expected a real Core approval');
    expect(batch.turn).toBe(turn);
    expect(batch.requests).toHaveLength(1);
    const request = batch.requests[0];
    if (request.type !== 'approval_request')
      throw new Error('Expected an approval');
    expect(request).toMatchObject({
      sessionId: session.id,
      subagentId: null,
      submissionId: turn.submissionId,
      turnId: turn.turnId,
      call: null,
    });
    expect(await session.pendingInteractions()).toEqual([request]);
    const stream = session.interactions();
    expect((await stream.next()).value).toBe(request);
    await stream.return?.();
    const observer = new AbortController();
    const aborted = turn.wait({
      until: 'manual_tool',
      signal: observer.signal,
    });
    observer.abort(new Error('observer only'));
    await expect(aborted).rejects.toThrow('observer only');
    expect(f.calls).toHaveLength(0);
    const reply = request.reply('allow_once');
    foreign = await new Agent({
      instructions: 'Independent root',
      model: 'gpt-5',
      provider: f.agent.provider,
    }).session();
    await expect(foreign.respond(reply)).rejects.toThrow();
    expect(await session.pendingInteractions()).toEqual([request]);
    await session.respond(reply);
    await expect(session.respond(reply)).rejects.toThrow();
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(f.calls).toHaveLength(1);
    expect(await session.pendingInteractions()).toEqual([]);
  } finally {
    try {
      await session?.close();
    } finally {
      try {
        await foreign?.close();
      } finally {
        await f.close();
      }
    }
  }
}, 30_000);

it('runs the native-question callback with the same issued reply protocol', async () => {
  const f = await fixture();
  try {
    let count = 0;
    const result = await f.agent.run('Change the fixture', {
      onInteraction(request, signal) {
        if (request.type === 'action_requested')
          throw new Error('Unexpected manual request');

        expect(signal.aborted).toBe(false);
        if (request.type !== 'approval_request')
          throw new Error('Expected approval');
        count++;
        return request.reply('allow_once');
      },
    });
    expect(result.finalOutput).toBe('done');
    expect(count).toBe(1);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30_000);

it('denies an approval without invoking the MCP tool', async () => {
  const f = await fixture();
  try {
    const result = await f.agent.run('Change the fixture', {
      onInteraction(request) {
        if (request.type === 'action_requested')
          throw new Error('Unexpected manual request');

        if (request.type !== 'approval_request')
          throw new Error('Expected approval');
        return request.reply('deny');
      },
    });
    expect(result.finalOutput).toBe('done');
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 30_000);

it('starts the sole real event reader before publishing MCP and refuses an unowned opening form', async () => {
  const f = await fixture({ startupQuestion: true });
  const { NativeThread: Thread } = await binding();
  const publish = Thread.prototype._replace_mcp_servers;
  const reading = vi.spyOn(Thread.prototype, '_next_session_events');
  vi.spyOn(Thread.prototype, '_replace_mcp_servers').mockImplementation(
    function (this: NativeThread, ...args) {
      expect(reading.mock.contexts.at(-1)).toBe(this);
      return publish.apply(this, args);
    },
  );
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    const opening = f.agent.session();
    opening.catch(() => {});
    const refusal = await f.startupFormReply;
    expect(refusal).toMatchObject({ id: 873, result: { action: 'cancel' } });
    expect(refusal.result?.content ?? null).toBeNull();
    session = await opening;
    expect(await session.pendingInteractions()).toEqual([]);
    expect(f.formReplies).toHaveLength(1);
    expect(reading).toHaveBeenCalled();
    await f.disconnected;
    expect(f.model.requests).toEqual([]);
    expect(f.calls).toEqual([]);
  } finally {
    try {
      await session?.close();
    } finally {
      await f.close();
    }
  }
}, 30_000);

for (const {
  formOrigin,
  deferGetUntilPostHeaders,
  retireExtraGetBeforeQuestion,
} of [
  {
    formOrigin: 'previous',
    deferGetUntilPostHeaders: false,
    retireExtraGetBeforeQuestion: false,
  },
  {
    formOrigin: 'current',
    deferGetUntilPostHeaders: false,
    retireExtraGetBeforeQuestion: false,
  },
  {
    formOrigin: 'previous',
    deferGetUntilPostHeaders: true,
    retireExtraGetBeforeQuestion: false,
  },
  {
    formOrigin: 'current',
    deferGetUntilPostHeaders: false,
    retireExtraGetBeforeQuestion: true,
  },
] as const) {
  it(`refuses an unsolicited GET-stream form from ${formOrigin} during same-server B without issuing a grant${deferGetUntilPostHeaders ? ' when GET follows POST headers' : ''}${retireExtraGetBeforeQuestion ? ' after redundant GET retirement' : ''}`, async () => {
    const f = await fixture({
      formOrigin,
      deferGetUntilPostHeaders,
      retireExtraGetBeforeQuestion,
    });
    let issued = 0;
    try {
      f.trace('agent_run_wait');
      const result = await f.agent.run('Call lookup twice', {
        onInteraction() {
          issued++;
          throw new Error('An unsolicited form must not issue a grant');
        },
      });
      f.trace('agent_run_complete');
      expect(result.finalOutput).toBe('done');
      expect(f.calls).toHaveLength(2);
      expect(f.formOrigins).toEqual([formOrigin === 'previous' ? 1 : 2]);
      expect(f.formReplies).toMatchObject([
        {
          result: {
            action: 'cancel',
          },
        },
      ]);
      expect(f.formReplies).toHaveLength(1);
      expect(f.formReplies[0]?.result?.content ?? null).toBeNull();
      expect(issued).toBe(0);
    } finally {
      await f.close();
    }
  }, 30_000);
}

for (const route of ['exec', 'patch'] as const) {
  for (const decision of ['allow_once', 'deny'] as const) {
    it(`answers the real root Environment ${route} approval with ${decision}`, async () => {
      const executor = await startPublicExecutor();
      const target = join(
        executor.cwd,
        route === 'patch' ? '../question-proof' : 'question-proof',
      );
      const output =
        route === 'exec'
          ? call(
              'exec_command',
              {
                cmd: `printf proof > '${target.replaceAll("'", "'\\''")}'`,
                sandbox_permissions: 'require_escalated',
                justification: 'One fixture-owned command',
              },
              { callId: 'reused-model-id' },
            )
          : {
              type: 'custom_tool_call',
              name: 'apply_patch',
              call_id: 'reused-model-id',
              input: `*** Begin Patch\n*** Add File: ${target}\n+proof\n*** End Patch`,
            };
      const model = new ModelServer([[output], [message('finished')]]);
      let provider: NativeProvider | undefined;
      try {
        const config = await model.config();
        provider = new NativeProvider({
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'fixture',
        });
        const agent = new Agent({
          instructions: 'Use the selected native tool.',
          model: route === 'patch' ? 'gpt-5.5' : 'gpt-5',
          provider,
        });
        let answered = 0;
        const result = await agent.run('Write the proof', {
          environment: new Environment({
            url: executor.url,
            cwd: executor.cwd,
            headers: executor.headers,
            // This loop verifies the explicit legacy escalation approval flow.
            writePolicy: 'legacy',
            tools: ['exec_command', 'write_stdin', 'apply_patch'],
          }),
          async onInteraction(request) {
            if (request.type === 'action_requested')
              throw new Error('Unexpected manual request');

            if (request.type !== 'approval_request')
              throw new Error('Expected approval');
            await expect(access(target)).rejects.toThrow();
            expect(request.call).toBeNull();
            expect(request.subagentId).toBeNull();
            expect(request.turnId).toBeTruthy();
            expect(request.description).toContain(target);
            expect(JSON.stringify(request)).not.toContain(target);
            answered++;
            return request.reply(decision);
          },
        });
        expect(result.finalOutput).toBe('finished');
        expect(
          answered,
          answered === 1
            ? undefined
            : JSON.stringify({
                route,
                decision,
                provider: model.requests.slice(0, 2).map((body) => ({
                  model: body.model,
                  toolOutputs: Array.isArray(body.input)
                    ? body.input.filter(
                        (item) =>
                          item !== null &&
                          typeof item === 'object' &&
                          !Array.isArray(item) &&
                          typeof item.type === 'string' &&
                          item.type.endsWith('_call_output'),
                      )
                    : [],
                })),
              }).slice(0, 16_384),
        ).toBe(1);
        if (decision === 'allow_once')
          expect(await readFile(target, 'utf8')).toBe(
            route === 'exec' ? 'proof' : 'proof\n',
          );
        else await expect(access(target)).rejects.toThrow();
      } finally {
        try {
          await provider?.close();
        } finally {
          await executor.close();
        }
      }
    }, 30_000);
  }
}

it('joins a consumed reply before close releases its queued successor', async () => {
  const f = await fixture();
  const { NativeThread: Thread } = await binding();
  const respond = Thread.prototype._respond_owned_native_question;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.spyOn(
    Thread.prototype,
    '_respond_owned_native_question',
  ).mockImplementation(async function (this: NativeThread, questionId, raw) {
    const accepted = await respond.call(this, questionId, raw);
    expect(accepted).toBe(true);
    entered.resolve();
    // Core has received the real response. Hold only the SDK-owned receipt.
    await release.promise;
    return accepted;
  });
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    session = await f.agent.session();
    const turn = await session.submit('Use lookup');
    const pending = await turn.wait({ until: 'interaction' });
    if (
      !('requests' in pending) ||
      pending.requests[0]?.type !== 'approval_request'
    )
      throw new Error('Expected approval');
    const reply = pending.requests[0].reply('allow_once');
    const responding = session.respond(reply);
    responding.catch(() => {});
    await entered.promise;
    const next = await session.enqueue('A successor must not start');
    const waiting = next.wait();
    waiting.catch(() => {});
    let settled = false;
    const closing = session.close();
    closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    expect(next.turnId).toBeNull();
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    await responding;
    await closing;
    await expect(waiting).rejects.toThrow();
    await expect(session.respond(reply)).rejects.toThrow();
    expect(
      f.model.requests.every(
        (request) =>
          !JSON.stringify(request.input).includes('A successor must not start'),
      ),
    ).toBe(true);
  } finally {
    release.resolve();
    try {
      await session?.close();
    } finally {
      await f.close();
    }
  }
}, 30_000);

it.each(['early', 'late'] as const)(
  'URL consent observes %s completion and survives its original root turn',
  async (order) => {
    const f = await fixture({ urlQuestion: true, urlCompletion: true });
    let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
    try {
      session = await f.agent.session();
      const cursor = session.interactions();
      const turn = await session.submit('Use lookup');
      const item = await cursor.next();
      await cursor.return?.();
      if (
        item.done ||
        item.value.type !== 'elicitation_request' ||
        item.value.mode !== 'url'
      )
        throw new Error('Expected URL');
      const request = item.value;
      expect(request.mode).toBe('url');
      expect(request.turnId).toBeNull();
      expect(request.submissionId).toBeNull();
      expect(request.serverName).toBe('fixture');
      expect(request.elicitationId).toBe('fixture-verification');
      expect(JSON.stringify(request)).not.toContain('verification.invalid');
      const consent = request.replyUrlAccept();
      if (order === 'early') await f.completeUrl();
      await session.respond(consent);
      await f.questionAnswered;
      expect(f.formReplies).toMatchObject([
        { jsonrpc: '2.0', id: 873, result: { action: 'accept' } },
      ]);
      expect(f.formReplies[0]?.result?.content ?? null).toBeNull();
      await expect(session.respond(consent)).rejects.toThrow();
      await expect(turn.wait()).resolves.toMatchObject({ finalOutput: 'done' });
      if (order === 'late') {
        const canceled = new AbortController();
        const reason = new Error('only this observer');
        const observer = request.waitForCompletion({
          timeoutMs: 5_000,
          signal: canceled.signal,
        });
        const waiting = request.waitForCompletion({ timeoutMs: 5_000 });
        canceled.abort(reason);
        await expect(observer).rejects.toBe(reason);
        await f.completeUrl();
        await expect(waiting).resolves.toBeUndefined();
      } else await request.waitForCompletion({ timeoutMs: 5_000 });
      await f.completeUrl();
      await request.waitForCompletion({ timeoutMs: 5_000 });
      expect(f.calls).toHaveLength(1);
      expect(f.formReplies).toHaveLength(1);
    } finally {
      try {
        await session?.close();
      } finally {
        await f.close();
      }
    }
  },
  30_000,
);

it('explicit URL expiry ignores late delivery of an already-consented native completion', async () => {
  const { NativeThread: Thread } = await binding();
  const originalRead = Thread.prototype._next_session_events;
  const originalStatus = Thread.prototype._native_url_completion_status;
  const originalCancel = Thread.prototype._cancel_native_url_completion;
  const originalPending = Thread.prototype._native_url_pending;
  const statusCaptured = Promise.withResolvers<void>();
  const probeCaptured = Promise.withResolvers<void>();
  const releaseStatus = Promise.withResolvers<void>();
  const releaseProbe = Promise.withResolvers<void>();
  let pendingAfterCancellation: boolean | undefined;
  vi.spyOn(Thread.prototype, '_next_session_events').mockImplementation(
    async function (this: NativeThread) {
      const raw = await originalRead.call(this);
      const event = JSON.parse(firstNativeBatchWire(raw));
      if (
        event.msg?.type === 'elicitation_status' &&
        event.msg.completed === true &&
        event.msg.server_name === 'fixture' &&
        event.subagent_id === undefined
      ) {
        statusCaptured.resolve();
        await releaseStatus.promise;
      }
      return raw;
    },
  );
  vi.spyOn(
    Thread.prototype,
    '_native_url_completion_status',
  ).mockImplementation(async function (this: NativeThread, id: string) {
    const status = await originalStatus.call(this, id);
    if (status === true) {
      probeCaptured.resolve();
      await releaseProbe.promise;
    }
    return status;
  });
  vi.spyOn(
    Thread.prototype,
    '_cancel_native_url_completion',
  ).mockImplementation(async function (this: NativeThread, id: string) {
    const canceled = await originalCancel.call(this, id);
    pendingAfterCancellation = await originalPending.call(this, id);
    return canceled;
  });
  const f = await fixture({ urlQuestion: true, urlCompletion: true });
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    session = await f.agent.session();
    const cursor = session.interactions();
    const turn = await session.submit('Use lookup');
    const finished = turn.wait();
    finished.catch(() => {});
    const item = await cursor.next();
    await cursor.return?.();
    if (
      item.done ||
      item.value.type !== 'elicitation_request' ||
      item.value.mode !== 'url'
    )
      throw new Error('Expected URL');
    const request = item.value;
    const prepared = request.replyUrlAccept();
    await session.respond(prepared);
    await f.questionAnswered;
    await expect(finished).resolves.toMatchObject({ finalOutput: 'done' });
    await f.completeUrl();
    await statusCaptured.promise;
    const waiting = request.waitForCompletion({ timeoutMs: 1_000 });
    const timedOut = expect(waiting).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    await probeCaptured.promise;
    await timedOut;
    await request.expire();
    expect(pendingAfterCancellation).toBe(false);
    await f.questionAnswered;
    expect(f.formReplies).toMatchObject([
      { id: 873, result: { action: 'accept' } },
    ]);
    expect(f.formReplies).toHaveLength(1);
    await expect(session.respond(prepared)).rejects.toThrow();
    releaseStatus.resolve();
    releaseProbe.resolve();
    await expect(
      request.waitForCompletion({ timeoutMs: 1_000 }),
    ).rejects.toThrow('expired');
    expect(f.calls).toHaveLength(1);
  } finally {
    releaseStatus.resolve();
    releaseProbe.resolve();
    try {
      await session?.close();
    } finally {
      await f.close();
    }
  }
}, 30_000);

it('explicit URL expiry refuses a foreign completion and a prepared late reply', async () => {
  const f = await fixture({ urlQuestion: true, urlCompletion: true });
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    session = await f.agent.session();
    const cursor = session.interactions();
    const turn = await session.submit('Use lookup');
    const item = await cursor.next();
    await cursor.return?.();
    if (
      item.done ||
      item.value.type !== 'elicitation_request' ||
      item.value.mode !== 'url'
    )
      throw new Error('Expected URL');
    const request = item.value;
    const late = request.replyUrlAccept();
    const completion = turn.wait();
    completion.catch(() => {});
    await f.completeUrl('another-interaction');
    await expect(
      request.waitForCompletion({ timeoutMs: 100 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    await request.expire();
    await f.questionAnswered;
    expect(f.formReplies).toMatchObject([
      { id: 873, result: { action: 'cancel' } },
    ]);
    expect(f.formReplies).toHaveLength(1);
    await expect(session.respond(late)).rejects.toThrow();
    expect(() => request.replyUrlAccept()).toThrow();
    await f.completeUrl();
    await expect(
      request.waitForCompletion({ timeoutMs: 1_000 }),
    ).rejects.toThrow('expired');
    expect(
      f.formReplies.every((reply) => reply.result?.action !== 'accept'),
    ).toBe(true);
    expect(f.calls).toHaveLength(1);
  } finally {
    try {
      await session?.close();
    } finally {
      await f.close();
    }
  }
}, 30_000);

it('explicit URL expiry retires the accepted native lifecycle after its root turn', async () => {
  const { NativeThread: Thread } = await binding();
  const read = Thread.prototype._next_session_events;
  const retired = Promise.withResolvers<void>();
  let originalToken: unknown;
  vi.spyOn(Thread.prototype, '_next_session_events').mockImplementation(
    async function (this: NativeThread) {
      const raw = await read.call(this);
      const event = JSON.parse(firstNativeBatchWire(raw));
      if (
        event?.msg?.type === 'elicitation_request' &&
        event.msg.request?.mode === 'url'
      )
        originalToken = event.msg.id;
      if (
        event?.msg?.type === 'elicitation_status' &&
        event.msg.server_name === 'fixture' &&
        event.msg.request_id === originalToken &&
        event.msg.completed === false
      )
        retired.resolve();
      return raw;
    },
  );
  const f = await fixture({ urlQuestion: true, urlCompletion: true });
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    session = await f.agent.session();
    const cursor = session.interactions();
    const turn = await session.submit('Use lookup');
    const item = await cursor.next();
    await cursor.return?.();
    if (
      item.done ||
      item.value.type !== 'elicitation_request' ||
      item.value.mode !== 'url'
    )
      throw new Error('Expected URL');
    const request = item.value;
    await session.respond(request.replyUrlAccept());
    await f.questionAnswered;
    await expect(turn.wait()).resolves.toMatchObject({ finalOutput: 'done' });
    await expect(
      request.waitForCompletion({ timeoutMs: 100 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    await request.expire();
    await retired.promise;
    await f.completeUrl();
    await expect(
      request.waitForCompletion({ timeoutMs: 1_000 }),
    ).rejects.toThrow('expired');
    expect(f.formReplies).toMatchObject([{ result: { action: 'accept' } }]);
    expect(f.formReplies).toHaveLength(1);
    expect(f.calls).toHaveLength(1);
  } finally {
    try {
      await session?.close();
    } finally {
      await f.close();
    }
  }
}, 30_000);

it('URL consent for a required-URL tool error does not invent an RPC reply or replay the tool', async () => {
  const f = await fixture({ urlRequired: true, urlCompletion: true });
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    session = await f.agent.session();
    const cursor = session.interactions();
    const turn = await session.submit('Use lookup');
    const item = await cursor.next();
    await cursor.return?.();
    if (
      item.done ||
      item.value.type !== 'elicitation_request' ||
      item.value.mode !== 'url'
    )
      throw new Error('Expected URL');
    const request = item.value;
    await session.respond(request.replyUrlAccept());
    expect(f.formReplies).toEqual([]);
    await f.completeUrl();
    await request.waitForCompletion({ timeoutMs: 5_000 });
    await expect(turn.wait()).resolves.toMatchObject({ finalOutput: 'done' });
    expect(f.formReplies).toEqual([]);
    expect(f.calls).toHaveLength(1);
  } finally {
    try {
      await session?.close();
    } finally {
      await f.close();
    }
  }
}, 30_000);

it('URL consent close retires completion observers and joins the original owner', async () => {
  const f = await fixture({ urlQuestion: true, urlCompletion: true });
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    session = await f.agent.session();
    const cursor = session.interactions();
    const turn = await session.submit('Use lookup');
    const settled = turn.wait();
    settled.catch(() => {});
    const item = await cursor.next();
    await cursor.return?.();
    if (
      item.done ||
      item.value.type !== 'elicitation_request' ||
      item.value.mode !== 'url'
    )
      throw new Error('Expected URL');
    const request = item.value;
    await session.respond(request.replyUrlAccept());
    await f.questionAnswered;
    await settled;
    const waiting = request.waitForCompletion({ timeoutMs: 5_000 });
    const expired = expect(waiting).rejects.toThrow('expired');
    await session.close();
    await expired;
    await vi.waitFor(() => expect(f.openUrlStreams()).toBe(0), {
      timeout: 5_000,
    });
    expect(() => request.replyUrlAccept()).toThrow();
    expect(f.formReplies).toHaveLength(1);
  } finally {
    try {
      await session?.close();
    } finally {
      await f.close();
    }
  }
}, 30_000);

it('URL consent uses the callback and matched completion over native stdio', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-url-stdio-'));
  const roster = join(directory, 'roster.json');
  const calls = join(directory, 'calls.jsonl');
  const replies = join(directory, 'replies.jsonl');
  const starts = join(directory, 'starts.jsonl');
  let provider: NativeProvider | undefined;
  try {
    await writeFile(
      roster,
      JSON.stringify({
        tools: [
          {
            name: 'lookup',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
        ],
        result: { content: [{ type: 'text', text: 'stdio result' }] },
        urlReplies: replies,
      }),
    );
    const model = new ModelServer([
      [
        call(
          'lookup',
          {},
          { namespace: 'mcp__fixture', callId: 'stdio-url-call' },
        ),
      ],
      [message('done')],
    ]);
    const config = await model.config();
    provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'fixture',
    });
    const agent = new Agent({
      instructions: 'Use lookup.',
      model: 'gpt-5',
      provider,
      tools: [
        new StdioMCP({
          name: 'fixture',
          tools: ['lookup'],
          approvalMode: 'preapproved',
          command: process.execPath,
          args: [
            fileURLToPath(new URL('./mcp-peer.mjs', import.meta.url)),
            roster,
            calls,
            starts,
          ],
        }),
      ],
    });
    let issued: import('../../src').UrlRequest | undefined;
    const result = await agent.run('Use lookup', {
      onInteraction(request) {
        if (request.type === 'action_requested')
          throw new Error('Unexpected manual request');

        if (request.type !== 'elicitation_request' || request.mode !== 'url')
          throw new Error('Expected URL');
        issued = request;
        return request.replyUrlAccept();
      },
    });
    expect(result.finalOutput).toBe('done');
    if (!issued) throw new Error('Missing URL request');
    await issued.waitForCompletion({ timeoutMs: 5_000 });
    const answered = (await readFile(replies, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(answered).toMatchObject([
      { id: 'url-consent', result: { action: 'accept' } },
    ]);
    expect(answered).toHaveLength(1);
    expect((await readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(1);
    const pid = JSON.parse((await readFile(starts, 'utf8')).trim())
      .pid as number;
    await provider.close();
    await vi.waitFor(
      () =>
        expect(() => process.kill(pid, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' }),
        ),
      { timeout: 8_000, interval: 20 },
    );
  } finally {
    await provider?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('completes an owned child URL while another child beforeStep stays held', async () => {
  const releaseSibling = Promise.withResolvers<void>();
  const siblingEntered = Promise.withResolvers<ChildBeforeStepContext>();
  const childContexts = new Map<string, ChildBeforeStepContext>();
  let heldChildId: string | undefined;
  let siblingPending = false;
  const native = new NativeAgents({
    interactions: true,
    maxChildren: 2,
    async beforeStep(context) {
      if (!childContexts.has(context.child.childId))
        childContexts.set(context.child.childId, context);
      heldChildId ??= context.child.childId;
      if (context.child.childId === heldChildId) {
        siblingPending = true;
        siblingEntered.resolve(context);
        try {
          await releaseSibling.promise;
        } finally {
          siblingPending = false;
        }
      }
      return undefined;
    },
  });
  const executor = await startPublicExecutor();
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  let session: Awaited<ReturnType<Agent['session']>> | undefined;
  try {
    f = await fixture({
      childQuestion: true,
      urlQuestion: true,
      urlCompletion: true,
      childAgents: native,
      spawnSibling: true,
    });
    session = await f.agent.session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
    });
    const cursor = session.interactions();
    const root = await session.submit(
      'Delegate lookup while another child waits',
    );
    const rootFinished = root.wait();
    rootFinished.catch(() => {});
    const sibling = await siblingEntered.promise;
    await f.childToolEntered;
    expect(siblingPending).toBe(true);
    f.releaseChildForm();
    const item = await cursor.next();
    await cursor.return?.();
    if (
      item.done ||
      item.value.type !== 'elicitation_request' ||
      item.value.mode !== 'url' ||
      !item.value.subagentId
    )
      throw new Error("Expected the other child's issued URL request");
    const request = item.value;
    const childId = request.subagentId;
    if (childId === null) throw new Error('Expected native child identity');
    const original = childContexts.get(childId);
    if (!original)
      throw new Error('Expected the original URL child preparation');
    expect(original.submission).not.toBe(sibling.submission);
    expect(request).toMatchObject({
      sessionId: session.id,
      subagentId: original.child.childId,
      turnId: original.child.turnId,
      submissionId: original.child.submissionId,
    });
    expect(request.turnId).not.toBe(root.turnId);
    const children = await Array.fromAsync(session.subagents());
    expect(children).toHaveLength(2);
    expect(
      children.find((child) => child.id === request.subagentId)?.turn,
    ).toBe(original.submission);
    expect(
      children.find((child) => child.id === sibling.child.childId)?.turn,
    ).toBe(sibling.submission);
    expect(original.submission.instanceId).toBe(original.child.instanceId);
    expect(siblingPending).toBe(true);
    expect(f.formReplies).toEqual([]);
    const consent = request.replyUrlAccept();
    await session.respond(consent);
    await f.childFormReply;
    await expect(session.respond(consent)).rejects.toThrow();
    await vi.waitFor(() => expect(f!.childModelInputs).toHaveLength(2), {
      timeout: 8_000,
    });
    const completed = request.waitForCompletion({ timeoutMs: 8_000 });
    await f.completeUrl();
    await expect(completed).resolves.toBeUndefined();
    expect(siblingPending).toBe(true);
    expect(f.formReplies).toMatchObject([{ result: { action: 'accept' } }]);
    expect(f.formReplies).toHaveLength(1);
    expect(f.calls).toHaveLength(1);
    f.releaseChildFinal();
    expect((await original.submission.wait()).finalOutput).toBe('child done');
    expect(siblingPending).toBe(true);
    expect(
      f.model.requests.map((request) => {
        const metadata = request.client_metadata as Record<string, string>;
        return JSON.parse(metadata['x-codex-turn-metadata']).thread_id;
      }),
    ).not.toContain(sibling.child.childId);
    releaseSibling.resolve();
    expect((await sibling.submission.wait()).finalOutput).toBe('sibling done');
    expect(siblingPending).toBe(false);
    f.releaseChildModel();
    expect((await rootFinished).finalOutput).toBe('root done');
  } finally {
    releaseSibling.resolve();
    f?.releaseChildFinal();
    f?.releaseChildModel();
    f?.releaseChildForm();
    try {
      await session?.close();
    } finally {
      try {
        await f?.close();
      } finally {
        await executor.close();
      }
    }
  }
}, 30_000);

it.each(['complete', 'cancel'] as const)(
  'opted-in child URL %s retains its original actor after the MCP call returns',
  async (outcome) => {
    const executor = await startPublicExecutor();
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    let session: Awaited<ReturnType<Agent['session']>> | undefined;
    try {
      f = await fixture({
        childQuestion: true,
        urlQuestion: true,
        urlCompletion: true,
      });
      session = await f.agent.session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      const cursor = session.interactions();
      const root = await session.submit('Delegate lookup to a child');
      const rootFinished = root.wait();
      rootFinished.catch(() => {});
      await f.childToolEntered;
      f.releaseChildForm();
      const item = await cursor.next();
      await cursor.return?.();
      if (
        item.done ||
        item.value.type !== 'elicitation_request' ||
        item.value.mode !== 'url' ||
        !item.value.subagentId
      )
        throw new Error('Expected captured child URL');
      const request = item.value;
      const childId = request.subagentId;
      if (childId === null) throw new Error('Expected native child identity');
      expect(request.mode).toBe('url');
      expect(request.turnId).not.toBeNull();
      expect(request.turnId).not.toBe(root.turnId);
      const meta = f.childModelInputs[0]!.client_metadata as Record<
        string,
        string
      >;
      expect(request.subagentId).toBe(
        JSON.parse(meta['x-codex-turn-metadata']).thread_id,
      );
      await session.respond(request.replyUrlAccept());
      await f.childFormReply;
      await vi.waitFor(() => expect(f!.childModelInputs).toHaveLength(2), {
        timeout: 8_000,
      });
      const completion = request.waitForCompletion({ timeoutMs: 8_000 });
      if (outcome === 'complete') {
        await f.completeUrl();
        await expect(completion).resolves.toBeUndefined();
      } else {
        const expired = expect(completion).rejects.toThrow('expired');
        f.interruptUrlChild(childId);
        await expired;
        await f.completeUrl();
        await expect(
          request.waitForCompletion({ timeoutMs: 1_000 }),
        ).rejects.toThrow('expired');
      }
      f.releaseChildFinal();
      f.releaseChildModel();
      await rootFinished;
      expect(f.formReplies).toMatchObject([{ result: { action: 'accept' } }]);
      expect(f.formReplies).toHaveLength(1);
      expect(f.calls).toHaveLength(1);
    } finally {
      f?.releaseChildFinal();
      f?.releaseChildModel();
      f?.releaseChildForm();
      try {
        await session?.close();
      } finally {
        try {
          await f?.close();
        } finally {
          await executor.close();
        }
      }
    }
  },
  30_000,
);

it('keeps session-scoped URL declines outside exact-turn waits', async () => {
  const f = await fixture({ urlQuestion: true });
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    f.trace('session_open_wait');
    session = await f.agent.session();
    f.trace('session_open_complete');
    const stream = session.interactions();
    const turn = await session.submit('Use lookup');
    f.trace('interaction_wait');
    const item = await stream.next();
    f.trace('interaction_received');
    await stream.return?.();
    if (
      item.done ||
      item.value.type !== 'elicitation_request' ||
      item.value.mode !== 'url'
    )
      throw new Error('Expected URL request');
    const request = item.value;
    expect(request).toMatchObject({
      submissionId: null,
      turnId: null,
      subagentId: null,
      call: null,
    });
    expect(request.description).toContain(
      'https://verification.invalid/private',
    );
    expect(JSON.stringify(request)).not.toContain('verification.invalid');
    expect(request.schema).toEqual({});
    expect(() => request.reply({} as never)).toThrow('replyUrlAccept');
    const abort = new AbortController();
    const exact = turn.wait({ until: 'interaction', signal: abort.signal });
    abort.abort(new Error('URL is session scoped'));
    await expect(exact).rejects.toThrow('URL is session scoped');
    expect(await session.pendingInteractions()).toEqual([request]);
    f.trace('question_reply_wait');
    await session.respond(request.reply(null));
    f.trace('question_reply_complete');
    f.trace('turn_result_wait');
    expect((await turn.wait()).finalOutput).toBe('done');
    f.trace('turn_result_complete');
    expect(f.formReplies).toMatchObject([{ result: { action: 'decline' } }]);
    expect(f.formReplies[0]?.result?.content ?? null).toBeNull();
  } finally {
    try {
      f.trace('session_close_wait');
      await session?.close();
      f.trace('session_close_complete');
    } finally {
      await f.close();
    }
  }
}, 30_000);

it('fails and joins an unattended real Core approval', async () => {
  const f = await fixture();
  try {
    await expect(f.agent.run('Use lookup')).rejects.toBeInstanceOf(
      InteractionRequired,
    );
    expect(f.calls).toEqual([]);
  } finally {
    await f.close();
  }
}, 30_000);

it('joins post-Thread publication failure in a selected Environment before any public turn', async () => {
  const executor = await startPublicExecutor();
  const { Engine: EngineBinding } = await binding();
  const closeEngine = EngineBinding.prototype._close_report;
  let engineClosed = false;
  const closing = vi
    .spyOn(EngineBinding.prototype, '_close_report')
    .mockImplementation(async function (this: Engine) {
      const receipt = await closeEngine.call(this);
      engineClosed = true;
      return receipt;
    });
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture({ startupQuestion: true, missingSelectedTool: true });
    const opening = f.agent.session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      }),
    });
    opening.catch(() => {});
    const refusal = await f.startupFormReply;
    expect(refusal).toMatchObject({ id: 873, result: { action: 'cancel' } });
    expect(refusal.result?.content ?? null).toBeNull();
    // The peer completes discovery with no selected lookup tool. The real
    // publication receipt must refuse it before exposing a Session.
    await expect(opening).rejects.toThrow(
      /Native MCP (publication was not confirmed|server fixture did not confirm every selected tool ready)/,
    );
    expect(engineClosed).toBe(true);
    expect(closing).toHaveBeenCalledTimes(1);
    expect(f.formReplies).toHaveLength(1);
    await f.disconnected;
    expect(f.model.requests).toEqual([]);
    expect(f.calls).toEqual([]);
    // No remote process or terminal cleanup claim comes from fixture teardown.
    // The source-bound empty terminal-store proof is a separate review input.
  } finally {
    try {
      await f?.close();
    } finally {
      await executor.close();
    }
  }
}, 30_000);

it('preserves the manual-checkpoint refusal before opening an MCP profile', async () => {
  const f = await fixture();
  try {
    const agent = new Agent({
      instructions: 'Use selected tools.',
      model: 'gpt-5',
      provider: f.agent.provider,
      tools: [
        ...f.agent.tools,
        manualTool({
          name: 'decision',
          description: '',
          parameters: z.object({}),
          result: z.string(),
        }),
      ],
    });
    await expect(agent.run('Begin')).rejects.toBeInstanceOf(
      InteractionRequired,
    );
    expect(f.methods).toEqual([]);
    expect(f.model.requests).toEqual([]);
  } finally {
    await f.close();
  }
}, 30_000);

it('answers an actual Core approval for the selected host stdio MCP tool', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-question-stdio-'));
  const roster = join(directory, 'roster.json');
  const calls = join(directory, 'calls.jsonl');
  const starts = join(directory, 'starts.jsonl');
  let provider: NativeProvider | undefined;
  try {
    await writeFile(
      roster,
      JSON.stringify({
        tools: [
          {
            name: 'lookup',
            description: 'Change one fixture record',
            annotations: { destructiveHint: true, readOnlyHint: false },
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
        ],
        result: { content: [{ type: 'text', text: 'stdio result' }] },
      }),
    );
    const model = new ModelServer([
      [call('lookup', {}, { namespace: 'mcp__fixture', callId: 'stdio-call' })],
      [message('done')],
    ]);
    const config = await model.config();
    provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'fixture',
    });
    const agent = new Agent({
      instructions: 'Use lookup.',
      model: 'gpt-5',
      provider,
      tools: [
        new StdioMCP({
          name: 'fixture',
          tools: ['lookup'],
          approvalMode: 'native',
          command: process.execPath,
          args: [
            fileURLToPath(new URL('./mcp-peer.mjs', import.meta.url)),
            roster,
            calls,
            starts,
          ],
        }),
      ],
    });
    let answered = 0;
    const result = await agent.run('Change the fixture', {
      async onInteraction(request) {
        if (request.type === 'action_requested')
          throw new Error('Unexpected manual request');

        if (request.type !== 'approval_request')
          throw new Error('Expected approval');
        await expect(access(calls)).rejects.toThrow();
        answered++;
        return request.reply('allow_once');
      },
    });
    expect(result.finalOutput).toBe('done');
    expect(answered).toBe(1);
    const recorded = (await readFile(calls, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(recorded).toMatchObject([{ name: 'lookup', arguments: {} }]);
  } finally {
    await provider?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('keeps issued native decisions usable during graceful cancellation', async () => {
  const f = await fixture();
  const { NativeThread: Thread } = await binding();
  const stop = vi.spyOn(Thread.prototype, '_request_graph_stop');
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    session = await f.agent.session();
    const turn = await session.submit('Use lookup');
    const pending = await turn.wait({ until: 'interaction' });
    if (
      !('requests' in pending) ||
      pending.requests[0]?.type !== 'approval_request'
    )
      throw new Error('Expected a real Core approval');
    const request = pending.requests[0];
    const prepared = request.reply('deny');
    const completion = turn.wait();
    completion.catch(() => {});
    const stopping = turn.cancel({ mode: 'graceful' });
    stopping.catch(() => {});
    expect(stop).toHaveBeenCalledWith('root', 'graceful');
    // Construction and delivery both remain authorized for this exact owner.
    const alternative = request.reply('allow_once');
    expect(await session.pendingInteractions()).toEqual([request]);
    await session.respond(prepared);
    await expect(session.respond(alternative)).rejects.toThrow();
    await Promise.all([
      stopping,
      expect(completion).rejects.toBeInstanceOf(TurnAborted),
    ]);
    expect(f.calls).toEqual([]);
    expect(f.model.requests).toHaveLength(1);
    expect(await session.pendingInteractions()).toEqual([]);
  } finally {
    try {
      await session?.close();
    } finally {
      await f.close();
    }
  }
}, 30_000);

it('delivers an entered tool question after the graceful fence to its waiting caller', async () => {
  const f = await fixture();
  const { NativeThread: Thread } = await binding();
  const read = Thread.prototype._next_session_events;
  const entered = Promise.withResolvers<void>();
  entered.promise.catch(() => {});
  const release = Promise.withResolvers<void>();
  const held = { value: false };
  vi.spyOn(Thread.prototype, '_next_session_events').mockImplementation(
    async function (this: NativeThread) {
      try {
        const raw = await read.call(this);
        if (
          !held.value &&
          JSON.parse(firstNativeBatchWire(raw)).msg.type ===
            'elicitation_request'
        ) {
          held.value = true;
          entered.resolve();
          // Hold the actual Core event receipt, preserving its original wire.
          await release.promise;
        }
        return raw;
      } catch (error) {
        entered.reject(error);
        throw error;
      }
    },
  );
  const stop = vi.spyOn(Thread.prototype, '_request_graph_stop');
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    session = await f.agent.session();
    const turn = await session.submit('Use lookup');
    const pending = turn.wait({ until: 'interaction' });
    pending.catch(() => {});
    const completion = turn.wait();
    completion.catch(() => {});
    await entered.promise;
    const stopping = turn.cancel({ mode: 'graceful' });
    stopping.catch(() => {});
    expect(stop).toHaveBeenCalledWith('root', 'graceful');
    release.resolve();
    const batch = await pending;
    if (
      !('requests' in batch) ||
      batch.requests[0]?.type !== 'approval_request'
    )
      throw new Error('Expected the held real Core approval');
    expect(batch.turn).toBe(turn);
    const request = batch.requests[0];
    expect(request.turnId).toBe(turn.turnId);
    const interactions = session.interactions();
    try {
      expect((await interactions.next()).value).toBe(request);
    } finally {
      await interactions.return?.();
    }
    await session.respond(request.reply('deny'));
    await Promise.all([
      stopping,
      expect(completion).rejects.toBeInstanceOf(TurnAborted),
    ]);
    expect(f.calls).toEqual([]);
    expect(f.model.requests).toHaveLength(1);
  } finally {
    release.resolve();
    try {
      await session?.close();
    } finally {
      await f.close();
    }
  }
}, 30_000);

it('revokes issued and prepared native decisions during force cancellation', async () => {
  const f = await fixture();
  const { NativeThread: Thread } = await binding();
  const stop = vi.spyOn(Thread.prototype, '_request_graph_stop');
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    session = await f.agent.session();
    const turn = await session.submit('Use lookup');
    const pending = await turn.wait({ until: 'interaction' });
    if (
      !('requests' in pending) ||
      pending.requests[0]?.type !== 'approval_request'
    )
      throw new Error('Expected a real Core approval');
    const request = pending.requests[0];
    const prepared = request.reply('allow_once');
    const completion = turn.wait();
    completion.catch(() => {});
    const stopping = turn.cancel({ mode: 'force' });
    stopping.catch(() => {});
    expect(stop).toHaveBeenCalledWith('root', 'force');
    expect(() => request.reply('deny')).toThrow('expired');
    await expect(session.respond(prepared)).rejects.toThrow();
    await Promise.all([
      stopping,
      expect(completion).rejects.toBeInstanceOf(TurnAborted),
    ]);
    expect(f.calls).toEqual([]);
    expect(f.model.requests).toHaveLength(1);
    expect(await session.pendingInteractions()).toEqual([]);
  } finally {
    try {
      await session?.close();
    } finally {
      await f.close();
    }
  }
}, 30_000);

it('keeps opening unpublished until its real publication boundary reaches the sole reader', async () => {
  const completeList = Promise.withResolvers<void>();
  const boundaryHeld = Promise.withResolvers<void>();
  const delivery = Promise.withResolvers<void>();
  const published = Promise.withResolvers<void>();
  published.promise.catch(() => {});
  const f = await fixture({
    startupQuestion: true,
    completeStartupList: completeList.promise,
  });
  const { NativeThread: Thread, Engine: EngineBinding } = await binding();
  const engineClosed = { value: false };
  const closeEngine = EngineBinding.prototype._close_report;
  const closing = vi
    .spyOn(EngineBinding.prototype, '_close_report')
    .mockImplementation(async function (this: Engine) {
      const receipt = await closeEngine.call(this);
      engineClosed.value = true;
      return receipt;
    });
  const next = Thread.prototype._next_session_events;
  const publish = Thread.prototype._replace_mcp_servers;
  const held = { value: false };
  vi.spyOn(Thread.prototype, '_next_session_events').mockImplementation(
    async function (this: NativeThread) {
      const raw = await next.call(this);
      // Inspect only the kind; deliver the exact original native wire unchanged.
      if (
        !held.value &&
        JSON.parse(firstNativeBatchWire(raw)).msg.type ===
          'sdk_mcp_publication_boundary'
      ) {
        held.value = true;
        boundaryHeld.resolve();
        await delivery.promise;
      }
      return raw;
    },
  );
  vi.spyOn(Thread.prototype, '_replace_mcp_servers').mockImplementation(
    async function (this: NativeThread, ...args) {
      try {
        const receipt = await publish.apply(this, args);
        published.resolve();
        return receipt;
      } catch (error) {
        published.reject(error);
        throw error;
      }
    },
  );
  const opened: { session?: Awaited<ReturnType<typeof f.agent.session>> } = {};
  const settled = { value: false };
  const opening = f.agent.session().then(
    (session) => {
      opened.session = session;
      settled.value = true;
      return { error: undefined };
    },
    (error: unknown) => {
      settled.value = true;
      return { error };
    },
  );
  try {
    const refusal = await f.startupFormReply;
    expect(refusal).toMatchObject({ id: 873, result: { action: 'cancel' } });
    expect(refusal.result?.content ?? null).toBeNull();
    completeList.resolve();
    await Promise.race([
      boundaryHeld.promise,
      opening.then(({ error }) => {
        throw (
          error ?? new Error('Opened before the actual publication boundary')
        );
      }),
    ]);
    // Discovery has finished and the real boundary remains held at N-API.
    await published.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled.value).toBe(false);
    delivery.resolve();
    expect((await opening).error).toBeUndefined();
    if (!opened.session) throw new Error('Expected an opened Session');
    expect(await opened.session.pendingInteractions()).toEqual([]);
    expect(f.formReplies).toHaveLength(1);
    expect(engineClosed.value).toBe(false);
    await opened.session.close();
    expect(engineClosed.value).toBe(true);
    expect(closing).toHaveBeenCalledTimes(1);
    expect(f.model.requests).toEqual([]);
    expect(f.calls).toEqual([]);
  } finally {
    completeList.resolve();
    delivery.resolve();
    await opening;
    try {
      await opened.session?.close();
    } finally {
      await f.close();
    }
  }
}, 30_000);

it('keeps original child tracing through question reply and physical handler cleanup', async () => {
  try {
    for (const disabled of [false, true]) {
      const executor = await startPublicExecutor();
      const release = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<{
        request: import('../../src/runtime/native-questions').NativeQuestion;
        reply: import('../../src/runtime/native-questions').NativeQuestionReply;
      }>();
      const f = await fixture({
        childQuestion: true,
        childAgents: new NativeAgents({ interactions: true }),
      });
      let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
      const original = f.agent.session.bind(f.agent);
      vi.spyOn(f.agent, 'session').mockImplementation(async (...args) => {
        session = await original(...args);
        return session;
      });
      let workflow: Awaited<ReturnType<typeof telemetry.startTrace>>;
      let result: ReturnType<typeof f.agent.run>;
      let calls = 0;
      const check = () => {
        const span = telemetry.getCurrentSpan()!;
        expect(span).toBeDefined();
        expect(telemetry.getCurrentTrace()).toBe(workflow);
        expect(span.context.disabled).toBe(disabled);
        expect(span.context.includeSensitiveData).toBe(false);
      };
      try {
        await telemetry.withTrace(
          { name: 'original.question.workflow', includeSensitiveData: true },
          (value) => {
            workflow = value;
            result = f.agent.run('Delegate lookup', {
              tracing: { disabled, includeSensitiveData: false },
              environment: new Environment({
                url: executor.url,
                cwd: executor.cwd,
                headers: executor.headers,
                tools: ['exec_command', 'write_stdin', 'apply_patch'],
              }),
              onInteraction: async (request) => {
                if (request.type === 'action_requested')
                  throw new Error('Unexpected manual request');

                if (
                  request.type !== 'elicitation_request' ||
                  request.mode !== 'form'
                )
                  throw new Error('Expected child form');
                expect(request.subagentId).not.toBeNull();
                check();
                calls++;
                const reply = request.reply(null);
                entered.resolve({ request, reply });
                await release.promise;
                check();
                await telemetry.withSpan(
                  { parent: null, disabled: false, includeSensitiveData: true },
                  (span) => {
                    expect(span.context.disabled).toBe(disabled);
                    expect(span.context.includeSensitiveData).toBe(false);
                  },
                );
                return reply;
              },
            });
            result.catch(() => {});
          },
        );
        await f.childToolEntered;
        f.releaseChildForm();
        const issued = await entered.promise;
        await telemetry.withTrace(
          { name: 'unrelated.question.workflow', includeSensitiveData: true },
          async () => {
            await session!.respond(issued.reply);
            await f.childFormReply;
            release.resolve();
            f.releaseChildModel();
            expect((await result!).finalOutput).toBe('root done');
          },
        );
        expect(calls).toBe(1);
        expect(f.formReplies).toHaveLength(1);
      } finally {
        release.resolve();
        f.releaseChildForm();
        f.releaseChildFinal();
        f.releaseChildModel();
        await session?.close();
        await f.close();
        await executor.close();
      }
    }
  } finally {
    await telemetry.forceFlush();
  }
}, 60_000);

it('dispatches a Session-scoped URL through a retained handler and preserves post-root completion', async () => {
  const f = await fixture({ urlQuestion: true, urlCompletion: true });
  let request: import('../../src').UrlRequest | undefined;
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    session = await f.agent.session({
      onInteraction(interaction) {
        if (
          interaction.type !== 'elicitation_request' ||
          interaction.mode !== 'url'
        )
          throw new Error('Expected URL');
        request = interaction;
        expect(interaction.turnId).toBeNull();
        expect(interaction.submissionId).toBeNull();
        return interaction.replyUrlAccept();
      },
    });
    const root = await session.submit('Use lookup');
    expect((await root.wait()).finalOutput).toBe('done');
    if (!request) throw new Error('Expected handler request');
    const short = request.waitForCompletion({ timeoutMs: 1 });
    await expect(short).rejects.toMatchObject({ name: 'TimeoutError' });
    const long = request.waitForCompletion({ timeoutMs: 5000 });
    await f.completeUrl();
    await expect(long).resolves.toBeUndefined();
    expect(f.formReplies).toHaveLength(1);
    expect(f.calls).toHaveLength(1);
  } finally {
    await session?.close();
    await f.close();
  }
}, 30_000);

it.each(['throws', 'missing_reply'] as const)(
  'fails Session-scoped handler %s without admitting queued work',
  async (kind) => {
    const f = await fixture({ urlQuestion: true, urlCompletion: true });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const problem = new Error('Application consent failed');
    let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
    try {
      session = await f.agent.session({
        async onInteraction() {
          entered.resolve();
          await release.promise;
          if (kind === 'throws') throw problem;
          return undefined as never;
        },
      });
      const root = await session.submit('Use lookup');
      const failedRoot = expect(root.wait()).rejects.toThrow(
        kind === 'throws' ? problem.message : 'issued reply',
      );
      await entered.promise;
      const queued = await session.enqueue('Must not reach the model');
      const failedQueue = expect(queued.wait()).rejects.toThrow(
        kind === 'throws' ? problem.message : 'issued reply',
      );
      release.resolve();
      await failedRoot;
      await failedQueue;
      await expect(session.close()).rejects.toThrow(
        kind === 'throws' ? problem.message : 'issued reply',
      );
      expect(f.model.requests).toHaveLength(1);
      for (const reply of f.formReplies)
        expect(reply.result?.action).not.toBe('accept');
    } finally {
      release.resolve();
      await session?.close().catch(() => {});
      await f.close();
    }
  },
  30_000,
);

it('rejects a sibling Session reply and preserves that sibling authority', async () => {
  const foreign = await fixture({ urlQuestion: true, urlCompletion: true });
  const failing = await fixture({
    urlQuestion: true,
    urlCompletion: true,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let source: Awaited<ReturnType<typeof foreign.agent.session>> | undefined;
  let destination:
    Awaited<ReturnType<typeof failing.agent.session>> | undefined;
  try {
    source = await foreign.agent.session();
    const sourceTurn = await source.submit('Use lookup');
    const cursor = source.interactions();
    const item = await cursor.next();
    await cursor.return?.();
    if (
      item.done ||
      item.value.type !== 'elicitation_request' ||
      item.value.mode !== 'url'
    )
      throw new Error('Expected sibling URL');
    const reply = item.value.replyUrlAccept();
    destination = await failing.agent.session({
      async onInteraction() {
        entered.resolve();
        await release.promise;
        return reply;
      },
    });
    const root = await destination.submit('Use lookup');
    const failedRoot = expect(root.wait()).rejects.toThrow('foreign');
    await entered.promise;
    const queued = await destination.enqueue('Must not start');
    const failedQueue = expect(queued.wait()).rejects.toThrow('foreign');
    release.resolve();
    await failedRoot;
    await failedQueue;
    await expect(destination.close()).rejects.toThrow('foreign');
    expect(failing.model.requests).toHaveLength(1);
    await source.respond(reply);
    expect((await sourceTurn.wait()).finalOutput).toBe('done');
    expect(foreign.formReplies).toMatchObject([
      { result: { action: 'accept' } },
    ]);
  } finally {
    release.resolve();
    await destination?.close().catch(() => {});
    await source?.close();
    await failing.close();
    await foreign.close();
  }
}, 30_000);

it.each(['bound', 'delivered', 'missing', 'foreign'] as const)(
  'authenticates a %s native handler return after independent delivery',
  async (kind) => {
    const f = await fixture();
    const other = kind === 'foreign' ? await fixture() : undefined;
    let foreignSession: Awaited<ReturnType<typeof f.agent.session>> | undefined;
    let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
    const entered =
      Promise.withResolvers<import('../../src').ApprovalRequest>();
    const release = Promise.withResolvers<void>();
    let bound: import('../../src').NativeQuestionReply;
    let delivered: typeof bound;
    let foreign: typeof bound;
    try {
      if (other) {
        foreignSession = await other.agent.session();
        await foreignSession.submit('Source question');
        const cursor = foreignSession.interactions();
        const next = await cursor.next();
        await cursor.return?.();
        if (next.done || next.value.type !== 'approval_request')
          throw new Error('Expected source approval');
        foreign = next.value.reply('deny');
      }
      session = await f.agent.session({
        async onInteraction(request) {
          if (request.type !== 'approval_request')
            throw new Error('Expected approval');
          bound = request.reply('deny');
          entered.resolve(request);
          await release.promise;
          return kind === 'bound'
            ? bound
            : kind === 'delivered'
              ? delivered
              : kind === 'foreign'
                ? foreign
                : (undefined as never);
        },
      });
      const root = await session.submit('Race question');
      let settled = false;
      const result = root.wait().then(
        (value) => {
          settled = true;
          return value;
        },
        (error) => {
          settled = true;
          throw error;
        },
      );
      result.catch(() => {});
      const request = await entered.promise;
      delivered = request.reply('deny');
      await session.respond(delivered);
      await expect(session.respond(delivered)).rejects.toThrow();
      expect(settled).toBe(false);
      expect(request.turnId).toBe(root.turnId);
      release.resolve();
      const outcome = await result.then(
        (value) => ({
          success: true,
          output: value.finalOutput,
          exactOwner: value.turn === root,
        }),
        (error) => ({ success: false, message: String(error) }),
      );
      if (kind === 'bound' || kind === 'delivered')
        expect(outcome).toMatchObject({
          success: true,
          output: 'done',
          exactOwner: true,
        });
      else
        expect(outcome).toMatchObject({
          success: false,
          message: expect.stringContaining(
            kind === 'foreign' ? 'foreign' : 'issued reply',
          ),
        });
    } finally {
      release.resolve();
      await session?.close().catch(() => {});
      await foreignSession?.close().catch(() => {});
      await other?.close();
      await f.close();
    }
  },
  30000,
);

it('joins owner cancellation before ignoring a late native handler return', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let session: Awaited<ReturnType<typeof f.agent.session>> | undefined;
  try {
    session = await f.agent.session({
      async onInteraction(_request, signal) {
        signal.addEventListener('abort', () => aborted.resolve(), {
          once: true,
        });
        entered.resolve();
        await release.promise;
        return undefined as never;
      },
    });
    const root = await session.submit('Cancel own question');
    const result = root.wait().catch((error) => error);
    await entered.promise;
    let stopped = false;
    const cancellation = root.cancel().then(() => {
      stopped = true;
    });
    await aborted.promise;
    expect(stopped).toBe(false);
    release.resolve();
    await cancellation;
    const failure = await result;
    expect(failure).toBeInstanceOf(TurnAborted);
  } finally {
    release.resolve();
    await session?.close().catch(() => {});
    await f.close();
  }
}, 30000);
