import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeError,
  NativeProvider,
  tool,
  type Session,
} from '@openai/agents';
import {
  binding,
  type JsonObject,
  type NativeThread,
} from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

type Failure = {
  status: number;
  code: string;
  type: string;
  requestId: string;
  retryAfter?: string | null;
};
const authentication: Failure = {
  status: 401,
  code: 'invalid_api_key',
  type: 'invalid_request_error',
  requestId: 'synthetic-provider-request',
};

/** Reject before SSE starts; successful requests use the shared Responses fixture. */
async function providerPeer(
  model: ModelServer,
  failureFor: (request: JsonObject) => Failure | null | Promise<Failure | null>,
  rejectWebsocketUpgrade = false,
  retries?: { request: number; stream: number },
  websocketStatus: 401 | 426 = 401,
) {
  const config = await model.config();
  const upstream = (config['model_providers.fixture'] as { base_url: string })
    .base_url;
  const failures: unknown[] = [];
  let rejectedRequests = 0;
  const rejectedBodies: JsonObject[] = [];
  let rejectedUpgrades = 0;
  let upgradeRejection: 401 | 426 | undefined = websocketStatus;
  const upgradeMetadata: JsonObject[] = [];
  const httpMetadata: JsonObject[] = [];
  const bodyDigests: string[] = [];
  const sockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });
  // Test-only fault injection: record the Core-facing carrier, not the provider socket.
  const coreCarrierSockets = new Set<WebSocket>();
  const originalUpgrade = WebSocketServer.prototype.handleUpgrade;
  const captureUpgrade = vi
    .spyOn(WebSocketServer.prototype, 'handleUpgrade')
    .mockImplementation(function (
      this: WebSocketServer,
      request,
      socket,
      head,
      callback,
    ) {
      return originalUpgrade.call(this, request, socket, head, (accepted) => {
        if (this !== sockets) {
          coreCarrierSockets.add(accepted);
        }
        callback(accepted, request);
      });
    });
  const metadata = (
    headers: import('node:http').IncomingHttpHeaders,
  ): JsonObject => {
    const value = headers['x-codex-turn-metadata'];
    return typeof value === 'string' ? JSON.parse(value) : {};
  };
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const parsedBody = JSON.parse(body.toString());
      const failure = await failureFor(parsedBody);
      if (failure) {
        rejectedRequests++;
        rejectedBodies.push(parsedBody);
        httpMetadata.push(metadata(request.headers));
        bodyDigests.push(createHash('sha256').update(body).digest('hex'));
        response.writeHead(failure.status, {
          'content-type': 'application/json',
          ...(failure.retryAfter === null
            ? {}
            : { 'retry-after': failure.retryAfter ?? '0' }),
          'x-request-id': failure.requestId,
          'x-synthetic-private-header': 'not-public-error-data',
        });
        response.end(
          JSON.stringify({
            error: {
              message: 'Synthetic provider rejection',
              type: failure.type,
              code: failure.code,
              param: null,
            },
          }),
        );
        return;
      }
      const result = await fetch(`${upstream}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      response.writeHead(result.status, {
        'content-type': result.headers.get('content-type')!,
      });
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end('Provider fixture failed');
    }
  });
  if (rejectWebsocketUpgrade) {
    server.on('upgrade', (request, socket, head) => {
      if (upgradeRejection !== undefined) {
        rejectedUpgrades++;
        upgradeMetadata.push(metadata(request.headers));
        socket.end(
          `HTTP/1.1 ${upgradeRejection} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
        return;
      }
      sockets.handleUpgrade(request, socket, head, (websocket) => {
        websocket.on('message', async (data) => {
          try {
            const request = JSON.parse(data.toString());
            if (request.generate === false) {
              websocket.send(
                JSON.stringify({
                  type: 'response.created',
                  response: { id: 'auth-warmup' },
                }),
              );
              websocket.send(
                JSON.stringify({
                  type: 'response.completed',
                  response: { id: 'auth-warmup' },
                }),
              );
              return;
            }
            const reply = await fetch(`${upstream}/responses`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(request),
            });
            assert(reply.ok, 'Priming provider response failed');
            for (const line of (await reply.text()).split('\n')) {
              if (line.startsWith('data: ')) websocket.send(line.slice(6));
            }
          } catch (error) {
            failures.push(error);
            websocket.terminate();
          }
        });
      });
    });
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const provider = new NativeProvider({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'synthetic-loopback-only',
    supportsWebsockets: rejectWebsocketUpgrade,
  });
  if (retries) {
    // Exercise Core's existing configuration without adding a public retry API.
    const acquire = provider._acquire.bind(provider);
    vi.spyOn(provider, '_acquire').mockImplementation((captured) => {
      const lease = acquire(captured);
      lease.config['model_providers.native_agent.request_max_retries'] =
        retries.request;
      lease.config['model_providers.native_agent.stream_max_retries'] =
        retries.stream;
      return lease;
    });
  }
  return {
    provider,
    upgradeMetadata,
    httpMetadata,
    bodyDigests,
    setWebsocketRejection(status: 401 | 426 | undefined) {
      upgradeRejection = status;
    },
    async retireCoreCarrier() {
      expect(coreCarrierSockets.size).toBeGreaterThan(0);
      await Promise.all(
        [...coreCarrierSockets].map(async (socket) => {
          if (socket.readyState === 3) return;
          const closed = once(socket, 'close');
          // Await the Core pump's close handshake before the next model send.
          socket.close();
          await closed;
        }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    get rejectedRequests() {
      return rejectedRequests;
    },
    get rejectedBodies() {
      return rejectedBodies;
    },
    get rejectedUpgrades() {
      return rejectedUpgrades;
    },
    async close() {
      try {
        await provider.close();
      } finally {
        captureUpgrade.mockRestore();
        for (const socket of sockets.clients) socket.terminate();
        await new Promise<void>((resolve) => sockets.close(() => resolve()));
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      expect(failures).toEqual([]);
    },
  };
}

function expectMetadata(
  error: unknown,
  metadata: {
    statusCode: number | null;
    code: string | null;
    requestId: string | null;
    category: string | null;
  },
): asserts error is NativeError {
  expect(error).toBeInstanceOf(NativeError);
  expect(error).toMatchObject(metadata);
  expect(error).not.toHaveProperty('body');
  expect(error).not.toHaveProperty('headers');
  expect(error).not.toHaveProperty('response');
}

const absentMetadata = {
  statusCode: null,
  code: null,
  requestId: null,
  category: null,
};

afterEach(() => ModelServer.closeAll());

describe('native retry guidance', () => {
  it.each([
    { status: 429, code: 'rate_limit_exceeded', advice: '0', retryable: true },
    { status: 503, code: 'server_is_overloaded', advice: '0', retryable: true },
    {
      status: 503,
      code: 'server_is_overloaded',
      advice: null,
      retryable: false,
    },
    { status: 400, code: 'invalid_request', advice: null, retryable: false },
  ])(
    'reports $code with advice $advice after a zero retry budget',
    async ({ status, code, advice, retryable }) => {
      const model = new ModelServer([]);
      const peer = await providerPeer(
        model,
        () => ({
          ...authentication,
          status,
          code,
          retryAfter: advice,
        }),
        false,
        { request: 0, stream: 0 },
      );
      try {
        await using session = await new Agent({
          instructions: 'Follow the scripted request.',
          model: 'gpt-5',
          provider: peer.provider,
        }).session();
        const turn = await session.submit('Report the terminal error.');
        const error: unknown = await turn
          .wait()
          .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(NativeError);
        expect(error).toMatchObject({
          retryable,
          retryAfterMs: advice === null ? null : 0,
        });
        if (status === 429) {
          expect(await turn.waitForAttention()).toEqual({
            type: 'needs_attention',
            reason: 'rate_limited',
            error,
            rateLimits: { retryAfterSeconds: 0 },
          });
        } else {
          await expect(turn.waitForAttention()).rejects.toBe(error);
        }
        await expect(turn.wait()).rejects.toBe(error);
        expect(peer.rejectedRequests).toBe(1);
        model.assertExhausted();
      } finally {
        await peer.close();
      }
    },
  );

  it.each([
    { request: 1, stream: 0 },
    { request: 0, stream: 1 },
  ])(
    'honors server delay with request budget $request and stream budget $stream',
    async (retries) => {
      const times: number[] = [];
      const model = new ModelServer([]);
      const peer = await providerPeer(
        model,
        () => {
          times.push(performance.now());
          return {
            ...authentication,
            status: 503,
            code: 'server_is_overloaded',
            retryAfter: '1',
          };
        },
        false,
        retries,
      );
      try {
        await using session = await new Agent({
          instructions: 'Follow the scripted request.',
          model: 'gpt-5',
          provider: peer.provider,
        }).session();
        const error: unknown = await (
          await session.submit('Use the finite budget.')
        )
          .wait()
          .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(NativeError);
        assert(error instanceof NativeError);
        expect(error.retryable).toBe(true);
        expect(error.retryAfterMs).toBeGreaterThan(0);
        expect(error.retryAfterMs).toBeLessThanOrEqual(1000);
        expect(times).toHaveLength(2);
        expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(950);
        model.assertExhausted();
      } finally {
        await peer.close();
      }
    },
  );

  it('cancels a server-advised retry wait without another attempt', async () => {
    const model = new ModelServer([]);
    const peer = await providerPeer(
      model,
      () => ({
        ...authentication,
        status: 503,
        code: 'server_is_overloaded',
        retryAfter: '300',
      }),
      false,
      { request: 0, stream: 1 },
    );
    const native = await binding();
    const nextEvent = native.NativeThread.prototype._next_session_event;
    let retryObserved = false;
    // Observe Core selecting the retry; a sent HTTP response alone does not
    // prove that the client has consumed the advice and entered retry handling.
    const observer = vi
      .spyOn(native.NativeThread.prototype, '_next_session_event')
      .mockImplementation(async function (this: NativeThread) {
        const raw = await nextEvent.call(this);
        const event = JSON.parse(raw);
        if (event.msg.type === 'stream_error') retryObserved = true;
        return raw;
      });
    try {
      await using session = await new Agent({
        instructions: 'Follow the scripted request.',
        model: 'gpt-5',
        provider: peer.provider,
      }).session();
      const turn = await session.submit('Wait for server advice.');
      const outcome = turn.wait().catch((error: unknown) => error);
      await vi.waitFor(() => expect(retryObserved).toBe(true));
      await turn.cancel();
      expect(await outcome).toBeInstanceOf(NativeError);
      expect(peer.rejectedRequests).toBe(1);
      model.assertExhausted();
    } finally {
      observer.mockRestore();
      await peer.close();
    }
  }, 10_000);

  it('does not replay a completed tool effect when the next model request fails', async () => {
    let effects = 0;
    const model = new ModelServer([
      [call('record_effect', {}, { callId: 'effect' })],
    ]);
    const peer = await providerPeer(
      model,
      () =>
        effects
          ? {
              ...authentication,
              status: 503,
              code: 'server_is_overloaded',
              retryAfter: '0',
            }
          : null,
      false,
      { request: 1, stream: 0 },
    );
    try {
      await using session = await new Agent({
        instructions: 'Follow the scripted request.',
        model: 'gpt-5',
        provider: peer.provider,
        tools: [
          tool({
            name: 'record_effect',
            parameters: z.object({}),
            execute() {
              effects++;
              return 'effect recorded';
            },
          }),
        ],
      }).session();
      const error: unknown = await (
        await session.submit('Record one effect.')
      )
        .wait()
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(NativeError);
      expect(error).toMatchObject({ retryable: true, retryAfterMs: 0 });
      expect(effects).toBe(1);
      expect(peer.rejectedRequests).toBe(2);
      model.assertExhausted();
    } finally {
      await peer.close();
    }
  });
});

describe('Python-aligned native provider error metadata', () => {
  it.each([401, 403])(
    'cancels after a tool effect without a late authentication retry (%s)',
    async (status) => {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let effects = 0;
      let rejectAfterEffect = true;
      const model = new ModelServer([
        [call('write_once', {}, { callId: 'write-once-call' })],
        [message('fresh turn')],
      ]);
      const peer = await providerPeer(model, async () => {
        if (!effects || !rejectAfterEffect) return null;
        started.resolve();
        await release.promise;
        return { ...authentication, status };
      });
      try {
        await using session = await new Agent({
          instructions: 'Use write_once then answer.',
          model: 'gpt-5',
          provider: peer.provider,
          tools: [
            tool({
              name: 'write_once',
              parameters: z.object({}),
              execute: () => {
                effects++;
                return 'receipt-1';
              },
            }),
          ],
        }).session();
        const turn = await session.submit(
          'Record one effect then hold the auth rejection.',
        );
        const outcome = turn.wait().catch((error: unknown) => error);
        try {
          await started.promise;
          expect(effects).toBe(1);
          await turn.cancel();
          expect(await outcome).toBeInstanceOf(NativeError);
        } finally {
          release.resolve();
        }
        rejectAfterEffect = false;
        expect(
          (await (await session.submit('Answer after cancellation.')).wait())
            .finalOutput,
        ).toBe('fresh turn');
        expect(effects).toBe(1);
        expect(peer.rejectedRequests).toBe(1);
        model.assertExhausted();
      } finally {
        release.resolve();
        await peer.close();
      }
    },
    30_000,
  );

  it.each([
    { status: 401, attempts: 2 },
    { status: 403, attempts: 1 },
  ])(
    'ends terminal HTTP authentication after normal recovery ($status)',
    async ({ status, attempts }) => {
      const model = new ModelServer([]);
      const peer = await providerPeer(model, () => ({
        ...authentication,
        status,
      }));
      try {
        await using session = await new Agent({
          instructions: 'Answer.',
          model: 'gpt-5',
          provider: peer.provider,
        }).session();
        const turn = await session.submit('Reject the captured key.');
        const error: unknown = await turn
          .wait()
          .catch((error: unknown) => error);
        expectMetadata(error, {
          statusCode: status,
          code: 'invalid_api_key',
          requestId: authentication.requestId,
          category: 'authentication_error',
        });
        expect(error).toMatchObject({ retryable: false, retryAfterMs: 0 });
        expect(peer.rejectedRequests).toBe(attempts);
        await expect(turn.wait()).rejects.toBe(error);
        await expect(turn.waitForAttention()).rejects.toBe(error);
        model.assertExhausted();
      } finally {
        await peer.close();
      }
    },
  );

  it.each([
    { status: 401, attempts: 2 },
    { status: 403, attempts: 1 },
  ])(
    'retains one tool effect when later HTTP authentication fails ($status)',
    async ({ status, attempts }) => {
      const model = new ModelServer([
        [call('write_once', {}, { callId: 'write-once-call' })],
      ]);
      let effects = 0;
      const peer = await providerPeer(model, () =>
        effects ? { ...authentication, status } : null,
      );
      try {
        await using session = await new Agent({
          instructions: 'Use write_once then answer.',
          model: 'gpt-5',
          provider: peer.provider,
          tools: [
            tool({
              name: 'write_once',
              parameters: z.object({}),
              execute: () => {
                effects++;
                return 'receipt-1';
              },
            }),
          ],
        }).session();
        const error: unknown = await (
          await session.submit('Record one effect.')
        )
          .wait()
          .catch((error: unknown) => error);
        expectMetadata(error, {
          statusCode: status,
          code: 'invalid_api_key',
          requestId: authentication.requestId,
          category: 'authentication_error',
        });
        expect(error).toMatchObject({ retryable: false, retryAfterMs: 0 });
        expect(effects).toBe(1);
        expect(peer.rejectedRequests).toBe(attempts);
        expect(model.requests).toHaveLength(1);
        for (const body of peer.rejectedBodies) {
          const input = body.input as {
            type?: string;
            call_id?: string;
            output?: unknown;
          }[];
          const original = input.find((item) => item.type === 'function_call');
          const outputs = input.filter(
            (item) => item.type === 'function_call_output',
          );
          expect(outputs).toHaveLength(1);
          expect(outputs[0]?.call_id).toBe(original?.call_id);
          expect(original?.call_id).toBeTruthy();
          expect(outputs[0]?.output).toBe('receipt-1');
        }
        model.assertExhausted();
      } finally {
        await peer.close();
      }
    },
  );

  it('keeps authentication recovery available to a later model request', async () => {
    const model = new ModelServer([]);
    const peer = await providerPeer(model, () => authentication);
    try {
      await using session = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider: peer.provider,
      }).session();
      for (const attempt of [1, 2]) {
        const turn = await session.submit(
          'Reject this request once recovery is spent.',
        );
        const error: unknown = await turn
          .wait()
          .catch((error: unknown) => error);
        expectMetadata(error, {
          statusCode: 401,
          code: authentication.code,
          requestId: authentication.requestId,
          category: 'authentication_error',
        });
        expect(error).toMatchObject({ retryable: false });
        expect(peer.rejectedRequests).toBe(attempt * 2);
      }
      model.assertExhausted();
    } finally {
      await peer.close();
    }
  });

  it.each([
    {
      name: 'authentication',
      failure: authentication,
      expected: {
        statusCode: 401,
        code: 'invalid_api_key',
        requestId: authentication.requestId,
        category: 'authentication_error',
      },
    },
    {
      name: 'quota category without observed provider metadata',
      failure: {
        ...authentication,
        status: 429,
        code: 'insufficient_quota',
        type: 'insufficient_quota',
      },
      expected: { ...absentMetadata, category: 'usage_limit_exceeded' },
    },
  ])(
    'retains only native metadata for $name',
    async ({ failure, expected }) => {
      const model = new ModelServer([]);
      const peer = await providerPeer(model, () => failure);
      let session: Session | undefined;
      try {
        session = await new Agent({
          instructions: 'Reply briefly.',
          model: 'gpt-5',
          provider: peer.provider,
        }).session();
        const turn = await session.submit('Synthetic local error probe.');
        const error: unknown = await turn
          .wait()
          .catch((error: unknown) => error);
        expectMetadata(error, expected);
        // The earlier native error notice must be enriched by terminal settlement.
        expect(error.message).toBeTruthy();
        await expect(turn.wait()).rejects.toBe(error);
        if (failure.code === 'insufficient_quota') {
          expect(await turn.waitForAttention()).toEqual({
            type: 'needs_attention',
            reason: 'quota_blocked',
            error,
            rateLimits: { retryAfterSeconds: 0 },
          });
        }
        expect(peer.rejectedRequests).toBeGreaterThan(0);
        model.assertExhausted();
      } finally {
        try {
          await session?.close();
        } finally {
          await peer.close();
        }
      }
    },
    30_000,
  );

  it.each([
    { status: 401, upgrade: 401 as const, upgrades: 2, httpAttempts: 2 },
    { status: 403, upgrade: 401 as const, upgrades: 2, httpAttempts: 1 },
    { status: 401, upgrade: 426 as const, upgrades: 1, httpAttempts: 2 },
    { status: 403, upgrade: 426 as const, upgrades: 1, httpAttempts: 1 },
  ])(
    'keeps startup-preconnect recovery independent after WebSocket $upgrade ($status)',
    async ({ status, upgrade, upgrades, httpAttempts }) => {
      const model = new ModelServer([]);
      const finalHttpFailure: Failure = {
        ...authentication,
        status,
        code: 'final_http_rejection',
        requestId: 'final-http-request',
      };
      const peer = await providerPeer(
        model,
        () => finalHttpFailure,
        true,
        undefined,
        upgrade,
      );
      let session: Session | undefined;
      try {
        session = await new Agent({
          instructions: 'Reply briefly.',
          model: 'gpt-5',
          provider: peer.provider,
        }).session();
        const turn = await session.submit(
          'Reject WebSocket and HTTP requests.',
        );
        const error: unknown = await turn
          .wait()
          .catch((error: unknown) => error);
        expectMetadata(error, {
          statusCode: status,
          code: 'final_http_rejection',
          requestId: 'final-http-request',
          category: 'authentication_error',
        });
        // Startup preconnect has its own recovery budget. The real turn still
        // owns normal HTTP recovery and the final HTTP failure metadata.
        expect(error).toMatchObject({ retryable: false });
        expect(peer.rejectedUpgrades).toBe(upgrades);
        expect(peer.rejectedRequests).toBe(httpAttempts);
        expect(peer.upgradeMetadata.map((item) => item.request_kind)).toEqual(
          Array(upgrades).fill('prewarm'),
        );
        expect(peer.httpMetadata.map((item) => item.request_kind)).toEqual(
          Array(httpAttempts).fill('turn'),
        );
        if (httpAttempts === 2)
          expect(peer.bodyDigests[0]).toBe(peer.bodyDigests[1]);
        await expect(turn.wait()).rejects.toBe(error);
        model.assertExhausted();
      } finally {
        try {
          await session?.close();
        } finally {
          await peer.close();
        }
      }
    },
    30_000,
  );

  it.each([401, 403])(
    'shares exhausted recovery across a real sampling reconnect (%s)',
    async (status) => {
      let effects = 0;
      const model = new ModelServer([
        [call('write_once', {}, { callId: 'sampling-effect' })],
        [message('primed')],
      ]);
      const peer = await providerPeer(
        model,
        () => ({ ...authentication, status }),
        true,
      );
      peer.setWebsocketRejection(undefined);
      let session: Session | undefined;
      try {
        session = await new Agent({
          instructions: 'Record one effect, then answer.',
          model: 'gpt-5',
          provider: peer.provider,
          tools: [
            tool({
              name: 'write_once',
              parameters: z.object({}),
              execute() {
                effects++;
                return 'recorded once';
              },
            }),
          ],
        }).session();
        expect(
          (
            await (
              await session.submit('Prime the socket and record one effect.')
            ).wait()
          ).finalOutput,
        ).toBe('primed');
        expect(effects).toBe(1);
        expect(peer.rejectedRequests).toBe(0);
        await peer.retireCoreCarrier();
        peer.setWebsocketRejection(401);
        const turn = await session.submit(
          'Reject this fresh sampling request.',
        );
        const error: unknown = await turn
          .wait()
          .catch((error: unknown) => error);
        expectMetadata(error, {
          statusCode: status,
          code: authentication.code,
          requestId: authentication.requestId,
          category: 'authentication_error',
        });
        expect(peer.upgradeMetadata.map((item) => item.request_kind)).toEqual([
          'turn',
          'turn',
        ]);
        expect(peer.httpMetadata.map((item) => item.request_kind)).toEqual([
          'turn',
        ]);
        expect(peer.rejectedRequests).toBe(1);
        expect(error).toMatchObject({ retryable: false });
        expect(effects).toBe(1);
        await expect(turn.wait()).rejects.toBe(error);
        model.assertExhausted();
      } finally {
        await session?.close();
        await peer.close();
      }
    },
    30_000,
  );

  it('recovers and preserves a later callback NativeError without borrowed metadata', async () => {
    let failure: Failure | null = authentication;
    const cause = new Error('local callback cause');
    const local = new NativeError(
      'unexpected status 429 Too Many Requests: insufficient_quota, request id: fabricated',
      { cause },
    );
    const model = new ModelServer([
      [message('recovered')],
      [call('local_failure', {}, { callId: 'local-failure' })],
    ]);
    const peer = await providerPeer(model, () => failure);
    let session: Session | undefined;
    try {
      session = await new Agent({
        instructions: 'Reply briefly or call local_failure.',
        model: 'gpt-5',
        provider: peer.provider,
        tools: [
          tool({
            name: 'local_failure',
            parameters: z.object({}),
            execute() {
              throw local;
            },
          }),
        ],
      }).session();
      const first = await session.submit('Fail at the provider.');
      const firstError: unknown = await first
        .wait()
        .catch((error: unknown) => error);
      expectMetadata(firstError, {
        statusCode: 401,
        code: 'invalid_api_key',
        requestId: authentication.requestId,
        category: 'authentication_error',
      });
      failure = null;
      expect(
        (await (await session.submit('Recover.')).wait()).finalOutput,
      ).toBe('recovered');
      const later = await session.submit('Call local_failure.');
      await expect(later.wait()).rejects.toBe(local);
      expectMetadata(local, absentMetadata);
      expect(local.cause).toBe(cause);
      await expect(first.wait()).rejects.toBe(firstError);
      model.assertExhausted();
    } finally {
      try {
        await session?.close();
      } finally {
        await peer.close();
      }
    }
  }, 30_000);

  it('keeps overlapping sessions on one provider isolated', async () => {
    const model = new ModelServer([]);
    const bothRequested = Promise.withResolvers<void>();
    let requests = 0;
    const peer = await providerPeer(model, async (request) => {
      if (++requests === 2) bothRequested.resolve();
      await bothRequested.promise;
      return JSON.stringify(request.input).includes('second-session')
        ? { ...authentication, code: 'second_key', requestId: 'second-request' }
        : authentication;
    });
    const agent = new Agent({
      instructions: 'Reply briefly.',
      model: 'gpt-5',
      provider: peer.provider,
    });
    const sessions: Session[] = [];
    try {
      sessions.push(await agent.session());
      sessions.push(await agent.session());
      const errors = await Promise.all(
        sessions.map(async (session, index) => {
          const turn = await session.submit(
            index ? 'second-session' : 'first-session',
          );
          return turn.wait().catch((error: unknown) => error);
        }),
      );
      for (const [index, error] of errors.entries()) {
        expectMetadata(error, {
          statusCode: 401,
          code: index ? 'second_key' : 'invalid_api_key',
          requestId: index ? 'second-request' : authentication.requestId,
          category: 'authentication_error',
        });
      }
      expect(errors[0]).not.toBe(errors[1]);
      model.assertExhausted();
    } finally {
      bothRequested.resolve();
      try {
        await Promise.all(sessions.map((session) => session.close()));
      } finally {
        await peer.close();
      }
    }
  }, 30_000);

  it('retains child provider metadata without a public event consumer', async () => {
    const executor = await startPublicExecutor();
    let rootId: string | undefined;
    const model = new ModelServer([
      [
        call(
          'spawn_agent',
          { task_name: 'child', message: 'Reply.' },
          {
            namespace: 'collaboration',
            callId: 'spawn',
          },
        ),
      ],
      [message('root finished')],
    ]);
    const peer = await providerPeer(model, (request) => {
      const metadata = request.client_metadata as Record<string, string>;
      const id = String(
        JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
      );
      rootId ??= id;
      return id === rootId ? null : authentication;
    });
    let session: Session | undefined;
    try {
      session = await new Agent({
        instructions: 'Delegate.',
        model: 'gpt-5.5',
        provider: peer.provider,
        tools: [new NativeAgents()],
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      expect((await (await session.submit('Begin.')).wait()).finalOutput).toBe(
        'root finished',
      );
      const children = [];
      for await (const child of session.subagents()) children.push(child);
      expect(children).toHaveLength(1);
      const childTurn = children[0].turn;
      assert(childTurn, 'Missing spawned child turn');
      const error: unknown = await childTurn
        .wait()
        .catch((error: unknown) => error);
      expectMetadata(error, {
        statusCode: 401,
        code: 'invalid_api_key',
        requestId: authentication.requestId,
        category: 'authentication_error',
      });
      await expect(childTurn.waitForAttention()).rejects.toBe(error);
      const repeated: unknown = await childTurn
        .wait()
        .catch((error: unknown) => error);
      expectMetadata(repeated, {
        statusCode: 401,
        code: 'invalid_api_key',
        requestId: authentication.requestId,
        category: 'authentication_error',
      });
      expect(repeated.message).toBe(error.message);
      expect(error.cause).toBeInstanceOf(Error);
      expect(repeated.cause).toBeInstanceOf(Error);
      expect((repeated.cause as Error).message).toBe(
        (error.cause as Error).message,
      );
      expect(peer.rejectedRequests).toBeGreaterThan(0);
      model.assertExhausted();
    } finally {
      try {
        await session?.close();
      } finally {
        try {
          await peer.close();
        } finally {
          await executor.close();
        }
      }
    }
  }, 30_000);
});
