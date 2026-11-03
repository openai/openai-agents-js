import assert from 'node:assert/strict';
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
) {
  const config = await model.config();
  const upstream = (config['model_providers.fixture'] as { base_url: string })
    .base_url;
  const failures: unknown[] = [];
  let rejectedRequests = 0;
  let rejectedUpgrades = 0;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const failure = await failureFor(JSON.parse(body.toString()));
      if (failure) {
        rejectedRequests++;
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
    server.on('upgrade', (_request, socket) => {
      rejectedUpgrades++;
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
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
    get rejectedRequests() {
      return rejectedRequests;
    },
    get rejectedUpgrades() {
      return rejectedUpgrades;
    },
    async close() {
      try {
        await provider.close();
      } finally {
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

  it('uses final HTTP failure metadata after rejected WebSocket upgrades', async () => {
    const model = new ModelServer([]);
    const finalHttpFailure: Failure = {
      ...authentication,
      status: 403,
      code: 'final_http_rejection',
      requestId: 'final-http-request',
    };
    const peer = await providerPeer(model, () => finalHttpFailure, true);
    let session: Session | undefined;
    try {
      session = await new Agent({
        instructions: 'Reply briefly.',
        model: 'gpt-5',
        provider: peer.provider,
      }).session();
      const turn = await session.submit('Reject WebSocket and HTTP requests.');
      const error: unknown = await turn.wait().catch((error: unknown) => error);
      expectMetadata(error, {
        statusCode: 403,
        code: 'final_http_rejection',
        requestId: 'final-http-request',
        category: 'authentication_error',
      });
      // Core retries upgrade failures and then switches to HTTP. The terminal
      // metadata must describe that last failure, rather than an earlier 401.
      expect(peer.rejectedUpgrades).toBeGreaterThan(0);
      expect(peer.rejectedRequests).toBeGreaterThan(0);
      await expect(turn.wait()).rejects.toBe(error);
      model.assertExhausted();
    } finally {
      try {
        await session?.close();
      } finally {
        await peer.close();
      }
    }
  }, 30_000);

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
