import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  Agent as PublicAgent,
  type SignInWithChatGPT as PublicSignInWithChatGPT,
} from '@openai/agents';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  LocalRecoveryRequired,
  NativeError,
  NativeProvider,
  fileSessionStore,
  localStorage,
  parseSessionState,
  reconcileSessionStore,
  tool,
  type Session,
  type SessionStore,
  type SignInWithChatGPT,
} from '@openai/agents-codex';
import { NativeProviderRoutes } from '../../src/runtime/http-model';
import { ModelServer, call, message } from './fixtures/model-server';

const limit = 'subscription_sharing_usage_limit_exceeded';
const unavailable = 'subscription_sharing_usage_unavailable';
const unsupported = 'subscription_sharing_unsupported_capability';
const verifierDiagnostic = 'synthetic verifier diagnostic';
const directories: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  try {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    await ModelServer.closeAll();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(
      directories
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  }
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'agents-chatgpt-plan-'));
  directories.push(path);
  return path;
}

function token(sequence = 1, claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://auth.openai.com',
      aud: 'https://api.openai.com/v1',
      client_id: 'synthetic-registration',
      sub: 'synthetic-bearer-subject',
      scope: 'resource.invoke chatgpt.tokens.use.direct',
      nbf: now - 60,
      exp: now + 3600,
      jti: `synthetic-token-${sequence}`,
      ...claims,
    }),
  ).toString('base64url');
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.synthetic-signature`;
}

type PlanCredential = Awaited<ReturnType<SignInWithChatGPT['getCredential']>>;

function credential(
  accessToken: string,
  { clientId = 'synthetic-registration', subject = 'synthetic-account' } = {},
): PlanCredential {
  return { accessToken, issuer: 'https://auth.openai.com', clientId, subject };
}

function plan(bearer: string, profile?: Parameters<typeof credential>[1]) {
  const getCredential = vi.fn(async () =>
    credential(bearer, profile),
  ) satisfies PublicSignInWithChatGPT['getCredential'];
  const source: SignInWithChatGPT = { getCredential };
  return {
    provider: new NativeProvider({ signInWithChatGPT: source }),
    getCredential,
  };
}

function rejectingSource() {
  return {
    getCredential: vi.fn(async () => {
      throw new Error(verifierDiagnostic);
    }),
  } satisfies SignInWithChatGPT;
}

async function expectVerifierRejection(operation: Promise<unknown>) {
  const error = await operation.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect(error).toHaveProperty(
    'message',
    'Sign in with ChatGPT credential callback failed',
  );
  expect(error).not.toBeInstanceOf(LocalRecoveryRequired);
  for (const field of ['cause', 'state', 'calls', 'cleanup']) {
    expect(error).not.toHaveProperty(field);
  }
  expect(String(error)).not.toContain(verifierDiagnostic);
}

function agent(
  provider: NativeProvider,
  tools: ConstructorParameters<typeof Agent>[0]['tools'] = [],
) {
  return new Agent({ instructions: 'Answer briefly.', provider, tools });
}

async function send(session: Session, input: string) {
  return (await session.submit(input)).wait();
}

type ModelResponses = ConstructorParameters<typeof ModelServer>[0];

/** CONNECT terminates on loopback and never resolves or forwards an external host. */
async function planEndpoint(responses: ModelResponses) {
  const root = await directory();
  const ca = join(root, 'ca.pem');
  const caKey = join(root, 'ca.key');
  const cert = join(root, 'server.pem');
  const key = join(root, 'server.key');
  const csr = join(root, 'server.csr');
  const ext = join(root, 'extensions');
  const openssl = (...args: string[]) =>
    execFileSync('openssl', args, { stdio: 'ignore' });
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=Plan fixture CA',
    '-keyout',
    caKey,
    '-out',
    ca,
  );
  openssl(
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=api.openai.com',
    '-keyout',
    key,
    '-out',
    csr,
  );
  await writeFile(
    ext,
    'subjectAltName=DNS:api.openai.com\nextendedKeyUsage=serverAuth\n',
  );
  openssl(
    'x509',
    '-req',
    '-days',
    '1',
    '-in',
    csr,
    '-CA',
    ca,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-extfile',
    ext,
    '-out',
    cert,
  );
  const server = new ModelServer(
    responses,
    [],
    undefined,
    undefined,
    undefined,
    {
      key: await readFile(key),
      cert: await readFile(cert),
    },
  );
  const port = await server.port();
  const sockets = new Set<Duplex>();
  const tunnels: string[] = [];
  const proxy = createServer((_request, response) =>
    response.writeHead(502).end(),
  );
  proxy.on('connect', (request, socket, head) => {
    tunnels.push(request.url ?? '');
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (request.url !== 'api.openai.com:443') {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    const peer = connect(port, '127.0.0.1');
    sockets.add(peer);
    peer.once('close', () => sockets.delete(peer));
    peer.on('error', () => socket.destroy());
    socket.on('error', () => peer.destroy());
    socket.once('close', () => peer.destroy());
    peer.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) peer.write(head);
      peer.pipe(socket).pipe(peer);
    });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });
  const address = proxy.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  for (const name of [
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'ALL_PROXY',
    'all_proxy',
  ]) {
    vi.stubEnv(name, url);
  }
  vi.stubEnv('NO_PROXY', '127.0.0.1,localhost,::1');
  vi.stubEnv('no_proxy', '127.0.0.1,localhost,::1');
  vi.stubEnv('CODEX_CA_CERTIFICATE', ca);
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-ambient-api-key');
  return { server, tunnels };
}

async function apiKeyProvider(server: ModelServer) {
  return new NativeProvider({
    baseUrl: `http://127.0.0.1:${await server.port()}/v1`,
    apiKey: 'synthetic-ordinary-api-key',
  });
}

it('captures once after validation and releases the provider lease on cancellation', async () => {
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<PlanCredential>();
  const getCredential = vi.fn(() => {
    started.resolve();
    return pending.promise;
  });
  const provider = new NativeProvider({
    signInWithChatGPT: { getCredential },
  });
  const owner = agent(provider);
  const controller = new AbortController();
  const opening = owner.session({ signal: controller.signal });
  const rejected = expect(opening).rejects.toThrow('cancel opening');
  await started.promise;
  await expect(provider.close()).rejects.toThrow();
  controller.abort(new Error('cancel opening'));
  await rejected;
  pending.reject(new Error('synthetic callback secret'));
  await provider.close();
  expect(getCredential).toHaveBeenCalledTimes(1);
});

it('rejects incompatible routes and invalid credentials before inference', async () => {
  const { server, tunnels } = await planEndpoint([]);
  const source = { getCredential: vi.fn(async () => credential(token())) };
  expect(
    () =>
      new NativeProvider({
        signInWithChatGPT: source,
        apiKey: 'synthetic-conflicting-key',
      }),
  ).toThrow(/signInWithChatGPT/);
  const now = Math.floor(Date.now() / 1000);
  vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
  for (const invalid of [
    token() as unknown as PlanCredential,
    credential('malformed-bearer'),
    credential(token(1, { nbf: now - 60, exp: now - 6 })),
    credential(token(1, { nbf: now + 6 })),
    credential(token(1, { scope: 'resource.invoke' })),
    credential(token(), { clientId: 'other-synthetic-registration' }),
  ]) {
    await using provider = new NativeProvider({
      signInWithChatGPT: { getCredential: async () => invalid },
    });
    await expect(agent(provider).run('invalid credential')).rejects.toThrow(
      /^Invalid Sign in with ChatGPT credential$/,
    );
  }
  await using provider = new NativeProvider({ signInWithChatGPT: source });
  await expect(
    agent(provider).run('unsupported', { prepareRequest: () => undefined }),
  ).rejects.toThrow(/direct local function tools and settled state/);
  expect(source.getCredential).not.toHaveBeenCalled();
  expect(tunnels).toHaveLength(0);
  server.assertExhausted();
});

it('accepts a small host clock difference before registered inference', async () => {
  const now = Math.floor(Date.now() / 1000);
  vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
  const { server } = await planEndpoint([
    [message('issued')],
    [message('renew soon')],
  ]);
  for (const [claims, expected] of [
    [{ nbf: now + 4 }, 'issued'],
    [{ exp: now - 4 }, 'renew soon'],
  ] as const) {
    await using provider = plan(token(1, claims)).provider;
    await expect(
      agent(provider).run('test clock difference'),
    ).resolves.toMatchObject({
      finalOutput: expected,
    });
  }
  expect(server.requests).toHaveLength(2);
  server.assertExhausted();
});

it('rejects a model without Lite metadata before sending a request', async () => {
  const { server, tunnels } = await planEndpoint([]);
  await using provider = plan(token()).provider;
  const unsupported = new Agent({
    instructions: 'Answer briefly.',
    model: 'synthetic-model-without-lite-metadata',
    provider,
  });
  await expect(unsupported.session()).rejects.toThrow(/Responses Lite model/);
  expect(tunnels).toHaveLength(0);
  server.assertExhausted();
});

it('sends Lite HTTP with native-only authorization, local tool continuation, and settled checkpoint renewal', async () => {
  const bearer = token();
  const renewed = token(2, { sub: 'rotated-synthetic-bearer-subject' });
  const { server, tunnels } = await planEndpoint([
    [call('lookup', { subject: 'test' }, { callId: 'lookup-once' })],
    [message('resolved')],
    [message('resumed')],
  ]);
  const route = NativeProviderRoutes.prototype as unknown as {
    handle(request: IncomingMessage): Promise<boolean>;
  };
  const privateHop = vi.spyOn(route, 'handle');
  const paths: string[] = [];
  server.onRecord = (phase, detail) => {
    if (phase === 'MODEL_REQUEST') {
      const { method, path } = detail as { method: string; path: string };
      paths.push(`${method} ${path}`);
    }
  };
  const execute = vi.fn(() => 'local result');
  const tools = [
    tool({
      name: 'lookup',
      description: 'Look up a subject',
      parameters: z.object({ subject: z.string() }),
      execute,
    }),
  ];
  const first = plan(bearer);
  await using firstProvider = first.provider;
  expect(firstProvider.apiKey).toBeUndefined();
  let checkpoint;
  {
    await using session = await agent(firstProvider, tools).session();
    await expect(session.realtime()).rejects.toThrow(
      /does not support Realtime/,
    );
    await expect(session.buildRealtimeSipConfig()).rejects.toThrow(
      /does not support Realtime/,
    );
    await expect(session.compact()).rejects.toThrow(
      /does not support model-backed compaction/,
    );
    expect((await send(session, 'remember this')).finalOutput).toBe('resolved');
    await session.compact({ summary: 'Supplied summary: remember this' });
    expect(server.requests).toHaveLength(2);
    expect((await session.saveState()).format_version).toBe(16);
    checkpoint = parseSessionState(JSON.stringify(await session.fork()));
    expect(checkpoint.format_version).toBe(16);
  }
  expect(first.getCredential).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledTimes(1);
  const rejectedSource = rejectingSource();
  await using rejectedProvider = new NativeProvider({
    signInWithChatGPT: rejectedSource,
  });
  await expectVerifierRejection(
    new PublicAgent({
      instructions: 'Answer briefly.',
      provider: rejectedProvider,
      tools,
    }).run('must not resume', { state: checkpoint, returnState: true }),
  );
  expect(rejectedSource.getCredential).toHaveBeenCalledTimes(1);
  expect(server.requests).toHaveLength(2);
  expect(execute).toHaveBeenCalledTimes(1);
  const second = plan(renewed);
  await using secondProvider = second.provider;
  const result = await new PublicAgent({
    instructions: 'Answer briefly.',
    provider: secondProvider,
    tools,
  }).run('continue', { state: checkpoint, returnState: true });
  expect(result.finalOutput).toBe('resumed');
  expect(result.state?.format_version).toBe(16);
  expect(second.getCredential).toHaveBeenCalledTimes(1);
  expect(tunnels.length).toBeGreaterThan(0);
  expect(new Set(tunnels)).toEqual(new Set(['api.openai.com:443']));
  expect(paths).toEqual(Array(3).fill('POST /v1/responses'));
  expect(server.requestHeaders.map((headers) => headers.authorization)).toEqual(
    [`Bearer ${bearer}`, `Bearer ${bearer}`, `Bearer ${renewed}`],
  );
  expect(
    server.requestHeaders[0]?.['x-openai-internal-codex-responses-lite'],
  ).toBe('true');
  const firstRequest = server.requests[0];
  expect(firstRequest).toMatchObject({ stream: true, store: false });
  const input = firstRequest?.input;
  assert(Array.isArray(input));
  const additionalTools = input.find(
    (item) =>
      item &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      item.type === 'additional_tools',
  );
  expect(additionalTools).toMatchObject({
    role: 'developer',
    tools: [
      {
        type: 'namespace',
        name: 'functions',
        tools: [
          {
            type: 'function',
            name: 'lookup',
            parameters: { properties: { subject: { type: 'string' } } },
          },
        ],
      },
    ],
  });
  expect(server.requests[0]).not.toHaveProperty('previous_response_id');
  expect(JSON.stringify(server.requests[1]?.input)).toContain('lookup-once');
  expect(JSON.stringify(server.requests[1]?.input)).toContain('local result');
  expect(JSON.stringify(server.requests[2]?.input)).toContain(
    'Supplied summary: remember this',
  );
  expect(privateHop).not.toHaveBeenCalled();
  for (const secret of [
    bearer,
    renewed,
    'synthetic-registration',
    'synthetic-account',
    'synthetic-bearer-subject',
  ]) {
    expect(JSON.stringify(checkpoint)).not.toContain(secret);
  }
  server.assertExhausted();
});

it('keeps named HTTP and SSE failures and never repeats a physical request', async () => {
  const bearer = token();
  const sse = (...events: object[]) =>
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  const callFrame = {
    type: 'response.output_item.done',
    output_index: 0,
    item: call('unsafe', {}, { callId: 'interrupted-call' }),
  };
  const cases = [
    { status: 401, body: JSON.stringify({ detail: bearer }) },
    {
      status: 403,
      detail: 'Synthetic serving region restriction',
      body: JSON.stringify({ detail: 'Synthetic serving region restriction' }),
    },
    {
      status: 400,
      code: unsupported,
      param: 'tools[0].type',
      category: 'invalid_request',
      retryable: false,
      body: JSON.stringify({
        error: { code: unsupported, param: 'tools[0].type', message: bearer },
      }),
    },
    {
      status: 429,
      code: limit,
      category: 'usage_limit_exceeded',
      retryable: false,
    },
    {
      status: 503,
      code: unavailable,
      category: 'server_overloaded',
      retryable: true,
      retryAfter: '10',
    },
    { status: 307, location: 'https://elsewhere.invalid/v1/responses' },
    {
      status: 200,
      code: limit,
      category: 'usage_limit_exceeded',
      retryable: false,
      body: sse({
        type: 'response.failed',
        response: { error: { code: limit, message: bearer } },
      }),
    },
    {
      status: 200,
      code: unavailable,
      category: 'server_overloaded',
      retryable: true,
      retryAfter: '10',
      body: sse({ type: 'error', code: unavailable, message: bearer }),
    },
    {
      status: 200,
      terminalReason: 'Sign in with ChatGPT response was incomplete',
      body: sse(callFrame, {
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'interrupted' } },
      }),
    },
    {
      status: 200,
      terminalReason: 'stream closed before response.completed',
      body: sse(callFrame),
    },
    {
      status: 200,
      terminalReason: 'Sign in with ChatGPT response was incomplete',
      body: sse(
        {
          ...callFrame,
          // Exercise the native command envelope without a command to run.
          item: call('exec_command', {}, { callId: 'inert-native-command' }),
        },
        {
          type: 'response.incomplete',
          response: { incomplete_details: { reason: 'interrupted' } },
        },
      ),
    },
  ];
  const { server, tunnels } = await planEndpoint(
    cases.map(({ status, code, location, body, retryAfter }, index) => ({
      status,
      body:
        body ??
        JSON.stringify({ error: { code, param: bearer, message: bearer } }),
      headers: {
        'content-type':
          status === 200 ? 'text/event-stream' : 'application/json',
        'x-request-id': `plan-request-${index}`,
        ...(retryAfter ? { 'retry-after': retryAfter } : {}),
        ...(location ? { location } : {}),
      },
    })),
  );
  const execute = vi.fn(() => 'unexpected');
  const { provider, getCredential } = plan(bearer);
  await using planProvider = provider;
  const owner = agent(planProvider, [
    tool({
      name: 'unsafe',
      description: 'Test interrupted tool',
      parameters: z.object({}),
      execute,
    }),
  ]);
  for (const [index, entry] of cases.entries()) {
    const error = await owner
      .run('one attempt')
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(NativeError);
    expect(error).toMatchObject({
      statusCode: entry.status,
      requestId: `plan-request-${index}`,
    });
    if (entry.code)
      expect(error).toMatchObject({
        code: entry.code,
        category: entry.category,
        retryable: entry.retryable,
      });
    if (entry.retryAfter) {
      const retryAfterMs = (error as NativeError).retryAfterMs;
      expect(retryAfterMs).toBeGreaterThan(0);
      expect(retryAfterMs).toBeLessThanOrEqual(Number(entry.retryAfter) * 1000);
    } else if (entry.code) {
      expect(error).toHaveProperty('retryAfterMs', null);
    }
    if (entry.terminalReason)
      expect(error).toHaveProperty(
        'message',
        expect.stringContaining(entry.terminalReason),
      );
    if (entry.detail)
      expect(error).toHaveProperty(
        'message',
        expect.stringContaining(JSON.stringify({ detail: entry.detail })),
      );
    expect(error).toHaveProperty('param', entry.param ?? null);
    expect(String(error)).not.toContain(bearer);
    expect(server.requests).toHaveLength(index + 1);
    expect(execute).not.toHaveBeenCalled();
  }
  expect(getCredential).toHaveBeenCalledTimes(cases.length);
  expect(new Set(tunnels)).toEqual(new Set(['api.openai.com:443']));
  server.assertExhausted();
});

it.each(['portable', 'local', 'application'] as const)(
  'binds %s resume in both directions and preserves API-key state',
  async (kind) => {
    const root = await directory();
    const storage =
      kind === 'local'
        ? localStorage(root)
        : kind === 'application'
          ? fileSessionStore(root)
          : undefined;
    const original = token();
    const renewed = token(2);
    const { server } = await planEndpoint([
      [message('saved plan')],
      [message('resumed plan')],
    ]);
    const ordinary = new ModelServer([
      [message('saved ordinary')],
      [message('resumed ordinary')],
    ]);
    await using first = plan(original).provider;
    await using same = plan(renewed).provider;
    await using differentRegistration = plan(
      token(3, { client_id: 'other-synthetic-registration' }),
      { clientId: 'other-synthetic-registration' },
    ).provider;
    await using differentSubject = plan(token(4), {
      subject: 'other-synthetic-account',
    }).provider;
    await using ordinaryProvider = await apiKeyProvider(ordinary);

    async function save(provider: NativeProvider) {
      await using session = await agent(provider).session(
        storage ? { storage } : {},
      );
      await send(session, 'prior conversation');
      return storage
        ? { storage, resume: session.id }
        : { state: await session.saveState() };
    }
    const bound = await save(first);
    const unbound = await save(ordinaryProvider);
    const mismatch = /matching Sign in with ChatGPT registration and account/;
    await expect(agent(differentRegistration).session(bound)).rejects.toThrow(
      mismatch,
    );
    await expect(agent(differentSubject).session(bound)).rejects.toThrow(
      mismatch,
    );
    await expect(agent(ordinaryProvider).session(bound)).rejects.toThrow(
      mismatch,
    );
    await expect(agent(same).session(unbound)).rejects.toThrow(mismatch);
    if (
      kind === 'application' &&
      storage &&
      'acquire' in storage &&
      'resume' in bound
    ) {
      const receipt = {
        sessionId: bound.resume!,
        turnId: 'unmatched-turn',
        callId: 'unmatched-call',
        result: 'receipt',
      };
      await expect(
        reconcileSessionStore(storage, receipt, {
          signInWithChatGPT: undefined,
        }),
      ).rejects.toThrow(mismatch);
      await expect(
        reconcileSessionStore(storage, receipt, {
          signInWithChatGPT: {
            getCredential: async () =>
              credential(token(3), { subject: 'other-synthetic-account' }),
          },
        }),
      ).rejects.toThrow(mismatch);
    }
    {
      await using resumed = await agent(same).session(bound);
      expect((await send(resumed, 'continue')).finalOutput).toBe(
        'resumed plan',
      );
    }
    {
      await using resumed = await agent(ordinaryProvider).session(unbound);
      expect((await send(resumed, 'continue')).finalOutput).toBe(
        'resumed ordinary',
      );
    }
    const stored = storage
      ? Buffer.concat(
          await Promise.all(
            (await readdir(root, { recursive: true, withFileTypes: true }))
              .filter((entry) => entry.isFile())
              .map((entry) => readFile(join(entry.parentPath, entry.name))),
          ),
        )
      : Buffer.from(JSON.stringify(bound));
    for (const value of [
      original,
      renewed,
      'synthetic-registration',
      'synthetic-account',
    ]) {
      expect(stored.includes(value)).toBe(false);
    }
    expect(server.requestHeaders[1]?.authorization).toBe(`Bearer ${renewed}`);
    expect(
      ordinary.requestHeaders.map((headers) => headers.authorization),
    ).toEqual(Array(2).fill('Bearer synthetic-ordinary-api-key'));
    server.assertExhausted();
    ordinary.assertExhausted();
  },
);

it.each(['local', 'application'] as const)(
  'checks %s account binding before showing or reconciling interrupted tool effects',
  async (kind) => {
    const bearer = token();
    const root = await directory();
    const effects = join(root, 'effects');
    const { server } = await planEndpoint([
      [call('record', {}, { callId: 'record-once' })],
      [message('continued')],
    ]);
    const child = fork(
      fileURLToPath(
        new URL('./fixtures/custom-storage-worker.ts', import.meta.url),
      ),
      [
        JSON.stringify({
          directory: root,
          effects,
          plan: true,
          local: kind === 'local',
          mode: 'hold-effect',
        }),
      ],
      {
        execArgv: ['--import', 'tsx'],
        env: {
          ...process.env,
          SYNTHETIC_PLAN_CREDENTIAL: JSON.stringify(credential(bearer)),
        },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      },
    );
    const exited = new Promise<void>((resolve) => child.once('exit', resolve));
    cleanups.push(async () => {
      child.kill('SIGKILL');
      await exited;
    });
    type Effect = { threadId: string; turnId: string; callId: string };
    const { threadId, turnId, callId } = await new Promise<Effect>(
      (resolve, reject) => {
        child.on('message', (value) => {
          const message = value as Effect & { type: string; message?: string };
          if (message.type === 'effect') resolve(message);
          if (message.type === 'failure') reject(new Error(message.message));
        });
        child.once('error', reject);
        void exited.then(() =>
          reject(new Error('Fixture exited before effect')),
        );
      },
    );
    child.kill('SIGKILL');
    await exited;

    const path =
      kind === 'local'
        ? join(
            root,
            (await readdir(root, { recursive: true })).find((name) =>
              name.endsWith(`${threadId}.jsonl`),
            )!,
          )
        : join(root, `${threadId}.json`);
    const before = await readFile(path, 'utf8');
    const durable = fileSessionStore(root);
    if (kind === 'application')
      await rm(join(root, `${threadId}.lock`), { recursive: true });
    const acquire = vi.fn(durable.acquire);
    const read = vi.fn(durable.read);
    let releaseBlocked = false;
    const release = vi.fn(
      async (...args: Parameters<SessionStore['release']>) => {
        if (releaseBlocked) throw new Error('fixture release unavailable');
        await durable.release(...args);
      },
    );
    const commit = vi.fn(durable.commit);
    const store: SessionStore = { ...durable, acquire, read, release, commit };
    const storage = kind === 'local' ? localStorage(root) : store;
    const execute = vi.fn(() => 'must not execute the recorded call again');
    const tools = [
      tool({
        name: 'record',
        description: 'Record one application effect.',
        parameters: z.object({}),
        execute,
      }),
    ];
    const receipt = {
      threadId,
      turnId,
      callId,
      outcome: 'applied' as const,
      result: 'verified effect',
    };
    const resumeOptions =
      kind === 'local'
        ? {
            storage: localStorage(root),
            resume: threadId,
            reconciledCalls: [receipt],
          }
        : { storage: store, resume: threadId };
    const recorder = (provider: NativeProvider) =>
      new Agent({
        instructions: 'Use record when requested.',
        provider,
        tools,
      });
    const rejectedSource = rejectingSource();
    await using rejectedProvider = new NativeProvider({
      signInWithChatGPT: rejectedSource,
    });
    await expectVerifierRejection(
      recorder(rejectedProvider).session(resumeOptions),
    );
    expect(rejectedSource.getCredential).toHaveBeenCalledTimes(1);
    const result = {
      sessionId: threadId,
      turnId,
      callId,
      result: receipt.result,
    };
    if (kind === 'application') {
      await expectVerifierRejection(
        reconcileSessionStore(store, result, {
          signInWithChatGPT: rejectedSource,
        }),
      );
      expect(rejectedSource.getCredential).toHaveBeenCalledTimes(2);
      for (const invalid of [null, {}]) {
        await expect(
          reconcileSessionStore(store, result, {
            signInWithChatGPT: invalid as SignInWithChatGPT,
          }),
        ).rejects.toThrow(/^signInWithChatGPT requires getCredential$/);
      }
      for (const operation of [acquire, read, commit, release]) {
        expect(operation).not.toHaveBeenCalled();
      }
    }
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(execute).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(1);

    await using wrong = plan(token(2), {
      subject: 'different-account',
    }).provider;
    const mismatch = await recorder(wrong)
      .session(resumeOptions)
      .catch((error: unknown) => error);
    expect(mismatch).toBeInstanceOf(Error);
    expect(mismatch).toMatchObject({
      message: expect.stringContaining('registration and account'),
    });
    expect(mismatch).not.toBeInstanceOf(LocalRecoveryRequired);
    expect(mismatch).not.toHaveProperty('calls');
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(server.requests).toHaveLength(1);
    if (kind === 'application') {
      expect(acquire).toHaveBeenCalledExactlyOnceWith(threadId);
      const fence = await acquire.mock.results[0].value;
      expect(read).toHaveBeenCalledExactlyOnceWith(threadId, fence);
      expect(release).toHaveBeenCalledExactlyOnceWith(threadId, fence);
      expect(acquire).toHaveBeenCalledBefore(read);
      expect(read).toHaveBeenCalledBefore(release);
      expect(commit).not.toHaveBeenCalled();

      acquire.mockClear();
      read.mockClear();
      release.mockClear();
      releaseBlocked = true;
      const error = await reconcileSessionStore(store, result, {
        signInWithChatGPT: {
          getCredential: async () =>
            credential(token(4), { subject: 'different-account' }),
        },
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(NativeError);
      const rejected = error as NativeError;
      try {
        expect(rejected.message).toContain('registration and account');
        expect(rejected.message).toContain('writer cleanup failed');
        expect(rejected.message).not.toContain('fixture release unavailable');
        expect(rejected.cleanup).toBeDefined();
        await expect(rejected.cleanup!.close()).rejects.toThrow(
          /canonical storage operation failed/,
        );
      } finally {
        releaseBlocked = false;
        await rejected.cleanup?.close();
      }
      const rejectedFence = await acquire.mock.results[0].value;
      expect(acquire).toHaveBeenCalledExactlyOnceWith(threadId);
      expect(read).toHaveBeenCalledExactlyOnceWith(threadId, rejectedFence);
      expect(release.mock.calls.length).toBeGreaterThan(1);
      expect(release.mock.calls).toEqual(
        Array.from({ length: release.mock.calls.length }, () => [
          threadId,
          rejectedFence,
        ]),
      );
      expect(commit).not.toHaveBeenCalled();
      expect(await readFile(path, 'utf8')).toBe(before);
    }

    const renewed = token(3);
    await using matching = plan(renewed).provider;
    await expect(
      recorder(matching).session({ storage, resume: threadId }),
    ).rejects.toMatchObject({ calls: [expect.objectContaining({ callId })] });
    if (kind === 'application') {
      await reconcileSessionStore(store, result, {
        signInWithChatGPT: { getCredential: async () => credential(renewed) },
      });
    }
    await using resumed = await recorder(matching).session(resumeOptions);
    expect((await send(resumed, 'continue')).finalOutput).toBe('continued');
    expect(execute).not.toHaveBeenCalled();
    expect(await readFile(effects, 'utf8')).toBe('effect\n');
    expect(JSON.stringify(server.requests[1])).toContain('verified effect');
    expect(await readFile(path, 'utf8')).not.toContain(renewed);
    server.assertExhausted();
  },
  30_000,
);
