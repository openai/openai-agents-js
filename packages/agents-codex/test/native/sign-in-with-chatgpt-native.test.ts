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
  model?: string,
) {
  return new Agent({ instructions: 'Answer briefly.', provider, tools, model });
}

async function send(session: Session, input: string) {
  return (await session.submit(input)).wait();
}

type ModelResponses = ConstructorParameters<typeof ModelServer>[0];

/** CONNECT terminates on loopback and never resolves or forwards an external host. */
async function planEndpoint(
  responses: ModelResponses,
  options: {
    usage?: ConstructorParameters<typeof ModelServer>[1];
    beforeEnd?: ConstructorParameters<typeof ModelServer>[6];
  } = {},
) {
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
    options.usage ?? [],
    undefined,
    undefined,
    undefined,
    {
      key: await readFile(key),
      cert: await readFile(cert),
    },
    options.beforeEnd,
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

it('refuses registered beforeCompact callbacks before invocation or inference', async () => {
  const { server } = await planEndpoint([]);
  const beforeCompact = vi.fn(() => undefined);
  await using provider = plan(token()).provider;
  await using session = await new PublicAgent({
    instructions: 'Answer briefly.',
    provider,
    beforeCompact,
  }).session();
  await expect(session.compact()).rejects.toThrow(
    'Sign in with ChatGPT does not support beforeCompact callbacks',
  );
  expect(beforeCompact).not.toHaveBeenCalled();
  expect(server.requests).toHaveLength(0);
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

it.each([
  { kind: 'local', automatic: false },
  { kind: 'application', automatic: false },
  { kind: 'local', automatic: true },
  { kind: 'application', automatic: true },
] as const)(
  'keeps a registered local compaction summary through $kind reopen without replaying tools (pre-turn=$automatic)',
  async ({ kind, automatic }) => {
    const root = await directory();
    const storage =
      kind === 'local' ? localStorage(root) : fileSessionStore(root);
    const summary = 'Compacted summary: the lookup result is amber.';
    const bearer = token();
    const renewed = token(2);
    const paths: string[] = [];
    const { server } = await planEndpoint(
      [
        [call('lookup', {}, { callId: 'before-compaction' })],
        [message('Original answer')],
        [message(summary)],
        [message('Answer after reopening')],
      ],
      {
        usage: automatic
          ? [
              () => undefined,
              JSON.stringify({
                input_tokens: 260_000,
                output_tokens: 1_000,
                total_tokens: 261_000,
              }),
              () => undefined,
              () => undefined,
            ]
          : [],
      },
    );
    server.onRecord = (phase, detail) => {
      if (phase === 'MODEL_REQUEST') {
        const { method, path } = detail as { method: string; path: string };
        paths.push(`${method} ${path}`);
      }
    };
    const execute = vi.fn(() => 'amber lookup result');
    const tools = [tool({ name: 'lookup', parameters: z.object({}), execute })];
    let id: string;
    {
      await using provider = plan(bearer).provider;
      await using session = await agent(
        provider,
        tools,
        automatic ? 'gpt-6.1-sol' : undefined,
      ).session({ storage });
      id = session.id;
      expect(
        (await send(session, 'Remember the lookup result')).finalOutput,
      ).toBe('Original answer');
      if (!automatic) {
        await session.compact();
        expect(server.requests).toHaveLength(3);
        expect(JSON.stringify((await session.modelContext()).items)).toContain(
          summary,
        );
      }
      expect(execute).toHaveBeenCalledTimes(1);
    }
    {
      await using provider = plan(renewed).provider;
      await using session = await agent(
        provider,
        tools,
        automatic ? 'gpt-6.1-sol' : undefined,
      ).session({
        storage,
        resume: id,
      });
      expect(
        (await send(session, 'Continue after reopening')).finalOutput,
      ).toBe('Answer after reopening');
      expect(JSON.stringify(server.requests[2]?.input)).toContain(
        'amber lookup result',
      );
      expect(JSON.stringify(server.requests[3]?.input)).toContain(summary);
      expect(JSON.stringify(server.requests[3]?.input)).toContain(
        'Continue after reopening',
      );
      expect(JSON.stringify((await session.modelContext()).items)).toContain(
        summary,
      );
      expect(execute).toHaveBeenCalledTimes(1);
    }
    expect(server.requests).toHaveLength(4);
    expect(paths).toEqual(Array(4).fill('POST /v1/responses'));
    expect(
      server.requestHeaders.map((headers) => headers.authorization),
    ).toEqual([
      `Bearer ${bearer}`,
      `Bearer ${bearer}`,
      `Bearer ${automatic ? renewed : bearer}`,
      `Bearer ${renewed}`,
    ]);
    for (const [index, request] of server.requests.entries()) {
      expect(request).toMatchObject({ stream: true, store: false });
      expect(request).not.toHaveProperty('previous_response_id');
      expect(
        server.requestHeaders[index]?.[
          'x-openai-internal-codex-responses-lite'
        ],
      ).toBe('true');
      expect(server.requestHeaders[index]?.authorization).not.toContain(
        'synthetic-ambient-api-key',
      );
    }
    server.assertExhausted();
  },
  20_000,
);

function sseFrames(...events: object[]) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

const unacceptedSummary = 'Partial summary that must never replace the context';
function compactionPartial() {
  return [
    { type: 'response.created', response: { id: 'compaction-failure' } },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      delta: unacceptedSummary,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: message(unacceptedSummary),
    },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: call('lookup', {}, { callId: 'unaccepted-compaction-call' }),
    },
  ];
}

async function beforeFixtureDeadline<T>(pending: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error('Compaction fixture did not settle before EOF')),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it.each([
  {
    name: 'held-open partial quota',
    code: limit,
    category: 'usage_limit_exceeded',
    reason: 'quota_blocked',
    retryable: false,
  },
  {
    name: 'held-open partial throttle',
    code: 'rate_limit_exceeded',
    category: 'rate_limit_exceeded',
    reason: 'rate_limited',
    retryable: true,
  },
] as const)(
  'settles registered local compaction $name before EOF and restores its prior context',
  async ({ code, category, reason, retryable }) => {
    const root = await directory();
    const storage =
      reason === 'quota_blocked' ? localStorage(root) : fileSessionStore(root);
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { server } = await planEndpoint(
      [
        [call('lookup', {}, { callId: 'accepted-before-failure' })],
        [message('Original settled answer')],
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'x-request-id': 'registered-compaction-failure',
          },
          body: sseFrames(...compactionPartial(), {
            type: 'response.failed',
            response: {
              error: {
                code,
                message: 'Synthetic provider rejection',
                headers: { 'Retry-After': '3600' },
              },
            },
          }),
        },
        [message('Recovered original context')],
      ],
      {
        beforeEnd: async () => {
          if (server.requests.length === 3) {
            held.resolve();
            await release.promise;
          }
        },
      },
    );
    const execute = vi.fn(() => 'accepted local tool output');
    const tools = [tool({ name: 'lookup', parameters: z.object({}), execute })];
    let id: string;
    {
      await using provider = plan(token()).provider;
      await using session = await agent(provider, tools).session({ storage });
      id = session.id;
      await send(session, 'Original user input');
    }
    await using provider = plan(token(2)).provider;
    await using session = await agent(provider, tools).session({
      storage,
      resume: id,
    });
    const before = await session.modelContext();
    const history = await session.historySnapshot();
    const command = await session.executeCommand('/compact');
    assert(command.command === 'compact');
    const failed = command.turn.wait().then(
      () => {
        throw new Error('Failed compaction unexpectedly succeeded');
      },
      (error: unknown) => error,
    );
    try {
      await beforeFixtureDeadline(
        Promise.race([
          held.promise,
          failed.then((error) => {
            throw error;
          }),
        ]),
      );
      const attention = await command.turn.waitForAttention({
        signal: AbortSignal.timeout(5_000),
      });
      expect(attention).toMatchObject({ type: 'needs_attention', reason });
      assert('type' in attention && attention.type === 'needs_attention');
      expect(attention.error).toBeInstanceOf(NativeError);
      expect(attention.error).toMatchObject({
        code,
        category,
        retryable,
        statusCode: 200,
        requestId: 'registered-compaction-failure',
      });
      expect(attention.error.retryAfterMs).toBeGreaterThan(0);
      expect(attention.error.retryAfterMs).toBeLessThanOrEqual(3_600_000);
      expect(await beforeFixtureDeadline(failed)).toBe(attention.error);
      expect(server.requests).toHaveLength(3);
      expect((await session.modelContext()).items).toEqual(before.items);
      expect((await session.historySnapshot()).items).toEqual(history.items);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
    await session.close();
    await using renewedProvider = plan(token(3)).provider;
    await using recovered = await agent(renewedProvider, tools).session({
      storage,
      resume: id,
    });
    expect((await recovered.modelContext()).items).toEqual(before.items);
    expect((await recovered.historySnapshot()).items).toEqual(history.items);
    expect((await send(recovered, 'Continue after failure')).finalOutput).toBe(
      'Recovered original context',
    );
    const input = JSON.stringify(server.requests[3]?.input);
    expect(input).toContain('Original user input');
    expect(input).toContain('accepted local tool output');
    expect(input).not.toContain(unacceptedSummary);
    expect(input).not.toContain('unaccepted-compaction-call');
    expect(execute).toHaveBeenCalledTimes(1);
    server.assertExhausted();
  },
  20_000,
);

it.each([
  {
    name: 'HTTP throttle',
    status: 429,
    code: 'rate_limit_exceeded',
    category: 'rate_limit_exceeded',
  },
  {
    name: 'HTTP overload',
    status: 503,
    code: 'server_is_overloaded',
    category: 'server_overloaded',
  },
  {
    name: 'context overflow',
    status: 400,
    code: 'context_length_exceeded',
    category: 'invalid_request',
  },
  {
    name: 'completed without a summary',
    status: 200,
    code: undefined,
    category: undefined,
  },
] as const)(
  'keeps registered local compaction $name to one physical attempt after restore',
  async ({ name, status, code, category }) => {
    const body =
      status !== 200
        ? JSON.stringify({
            error: { code, message: 'Synthetic provider rejection' },
          })
        : sseFrames(
            {
              type: 'response.created',
              response: { id: 'empty-compaction' },
            },
            {
              type: 'response.output_item.done',
              output_index: 0,
              item: message('  \n'),
            },
            {
              type: 'response.completed',
              response: { id: 'empty-compaction' },
            },
          );
    const { server } = await planEndpoint([
      [message('Original answer before compaction')],
      {
        status,
        body,
        headers: {
          'content-type':
            status === 200 ? 'text/event-stream' : 'application/json',
          'x-request-id': 'single-compaction-attempt',
          'retry-after': '3600',
        },
      },
      [message('Continued after rejected compaction')],
    ]);
    await using provider = plan(token()).provider;
    const owner = agent(provider);
    let state;
    {
      await using session = await owner.session();
      await send(session, 'Original input before compaction');
      if (name === 'completed without a summary')
        await session.compact({
          summary: 'Previous accepted summary, never a new result',
        });
      state = parseSessionState(JSON.stringify(await session.saveState()));
    }
    await using session = await owner.session({ state });
    const before = await session.modelContext();
    const history = await session.historySnapshot();
    const error = await session.compact().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(NativeError);
    if (category) expect(error).toMatchObject({ category });
    if (status !== 200) {
      expect(error).toMatchObject({
        statusCode: status,
        code,
        requestId: 'single-compaction-attempt',
      });
      if (status !== 400) expect(error).toHaveProperty('retryable', true);
      expect((error as NativeError).retryAfterMs).toBeGreaterThan(0);
    }
    expect(server.requests).toHaveLength(2);
    if (name === 'context overflow') {
      const input = server.requests[1]?.input;
      assert(Array.isArray(input));
      expect(input.length).toBeGreaterThan(1);
      expect(JSON.stringify(input)).toContain(
        'Original input before compaction',
      );
      expect(JSON.stringify(input)).toContain(
        'Original answer before compaction',
      );
      expect(
        (await session.saveState()).history.filter(
          (record) => record.type === 'compacted',
        ),
      ).toEqual(state.history.filter((record) => record.type === 'compacted'));
    }
    expect((await session.modelContext()).items).toEqual(before.items);
    expect((await session.historySnapshot()).items).toEqual(history.items);
    expect(
      (await send(session, 'Continue after compaction failure')).finalOutput,
    ).toBe('Continued after rejected compaction');
    expect(JSON.stringify(server.requests[2]?.input)).toContain(
      name === 'completed without a summary'
        ? 'Previous accepted summary, never a new result'
        : 'Original input before compaction',
    );
    server.assertExhausted();
  },
  20_000,
);

it.each(['cancel', 'timeout'] as const)(
  'rolls registered local compaction back after consumed output_item.done and %s',
  async (ending) => {
    const release = Promise.withResolvers<void>();
    const { server } = await planEndpoint(
      [
        [message('Original settled answer')],
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: sseFrames(...compactionPartial().slice(0, 3), {
            type: 'response.metadata',
            headers: { 'x-ratelimit-remaining-requests': '7' },
          }),
        },
        [message('Continued after stopped compaction')],
      ],
      {
        beforeEnd: async () => {
          if (server.requests.length === 2) await release.promise;
        },
      },
    );
    await using provider = new NativeProvider({
      signInWithChatGPT: { getCredential: async () => credential(token()) },
      streamIdleTimeoutMs: ending === 'timeout' ? 250 : 10_000,
    });
    const execute = vi.fn(() => 'must not execute');
    const owner = agent(provider, [
      tool({ name: 'lookup', parameters: z.object({}), execute }),
    ]);
    await using session = await owner.session();
    await send(session, 'Original user input');
    const before = await session.modelContext();
    const history = await session.historySnapshot();
    const command = await session.executeCommand('/compact');
    assert(command.command === 'compact');
    const failed = command.turn.wait().then(
      () => {
        throw new Error('Stopped compaction unexpectedly succeeded');
      },
      (error: unknown) => error,
    );
    const events = command.turn.events();
    try {
      const consumed = (async () => {
        for await (const event of events) {
          if (
            event.type === 'api_rate_limits_updated' &&
            event.snapshot.requests?.remaining === 7
          )
            return;
        }
        throw new Error('Compaction ended before consuming the output marker');
      })();
      await beforeFixtureDeadline(
        Promise.race([
          consumed,
          failed.then((error) => {
            throw error;
          }),
        ]),
      );
      if (ending === 'cancel') await command.turn.cancel();
      const error = await beforeFixtureDeadline(failed);
      expect(error).toBeInstanceOf(NativeError);
      if (ending === 'cancel') {
        expect(await command.turn.waitForAttention()).toMatchObject({
          type: 'needs_attention',
          reason: 'interrupted',
          error,
        });
      } else expect(String(error)).toContain('idle timeout');
      expect(server.requests).toHaveLength(2);
      expect((await session.modelContext()).items).toEqual(before.items);
      const retained = (await session.historySnapshot()).items;
      expect(retained).toEqual(
        ending === 'cancel'
          ? [
              ...history.items,
              expect.objectContaining({
                type: 'message',
                role: 'user',
                content: [
                  expect.objectContaining({
                    type: 'input_text',
                    text: expect.stringMatching(/^<turn_aborted>\n/),
                  }),
                ],
                internal_chat_message_metadata_passthrough:
                  expect.objectContaining({
                    content_item_kinds: ['generic.turn_aborted'],
                    turn_id: command.turn.turnId,
                  }),
              }),
            ]
          : history.items,
      );
      expect(JSON.stringify(retained)).not.toContain(unacceptedSummary);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await events.return?.();
    }
    const state = parseSessionState(JSON.stringify(await session.saveState()));
    await session.close();
    await using restored = await owner.session({ state });
    expect((await send(restored, 'Continue after stop')).finalOutput).toBe(
      'Continued after stopped compaction',
    );
    expect(JSON.stringify(server.requests[2]?.input)).toContain(
      'Original user input',
    );
    expect(JSON.stringify(server.requests[2]?.input)).not.toContain(
      unacceptedSummary,
    );
    expect(execute).not.toHaveBeenCalled();
    server.assertExhausted();
  },
  20_000,
);

it.each(['pre_turn', 'mid_turn'] as const)(
  'preserves registered %s local compaction quota failure and settled tool effects',
  async (phase) => {
    const release = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const { server } = await planEndpoint(
      [
        phase === 'mid_turn'
          ? [
              call(
                'lookup',
                {},
                { callId: 'settled-before-mid-turn-compaction' },
              ),
            ]
          : [message('Settled answer before automatic compaction')],
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: sseFrames(...compactionPartial(), {
            type: 'response.failed',
            response: {
              error: { code: limit, message: 'Synthetic compaction quota' },
            },
          }),
        },
        [message('Recovered summary after automatic compaction failure')],
        [message('Fresh operation completed')],
      ],
      {
        usage: [
          JSON.stringify({
            input_tokens: 260_000,
            output_tokens: 1_000,
            total_tokens: 261_000,
          }),
          () => undefined,
          () => undefined,
          () => undefined,
        ],
        beforeEnd: async () => {
          if (server.requests.length === 2) {
            held.resolve();
            await release.promise;
          }
        },
      },
    );
    const execute = vi.fn(
      () => 'settled tool output before automatic compaction',
    );
    await using provider = plan(token()).provider;
    const owner = new Agent({
      instructions: 'Answer briefly.',
      model: 'gpt-6.1-sol',
      provider,
      tools: [tool({ name: 'lookup', parameters: z.object({}), execute })],
    });
    await using session = await owner.session();
    let turn = await session.submit('Original automatic-compaction input');
    if (phase === 'pre_turn') {
      expect((await turn.wait()).finalOutput).toBe(
        'Settled answer before automatic compaction',
      );
      turn = await session.submit(
        'Pending user input after the settled answer',
      );
    }
    const failed = turn.wait().then(
      () => {
        throw new Error(
          'Quota-blocked automatic compaction unexpectedly succeeded',
        );
      },
      (error: unknown) => error,
    );
    try {
      await beforeFixtureDeadline(
        Promise.race([
          held.promise,
          failed.then((error) => {
            throw error;
          }),
        ]),
      );
      const attention = await turn.waitForAttention({
        signal: AbortSignal.timeout(5_000),
      });
      expect(attention).toMatchObject({
        type: 'needs_attention',
        reason: 'quota_blocked',
      });
      assert('type' in attention && attention.type === 'needs_attention');
      expect(attention.error).toMatchObject({
        code: limit,
        category: 'usage_limit_exceeded',
        retryable: false,
      });
      expect(await beforeFixtureDeadline(failed)).toBe(attention.error);
      expect(server.requests).toHaveLength(2);
      const context = JSON.stringify((await session.modelContext()).items);
      expect(context).toContain('Original automatic-compaction input');
      if (phase === 'pre_turn')
        expect(context).toContain(
          'Pending user input after the settled answer',
        );
      expect(context).not.toContain(unacceptedSummary);
      expect(execute).toHaveBeenCalledTimes(phase === 'mid_turn' ? 1 : 0);
      if (phase === 'mid_turn')
        expect(context).toContain(
          'settled tool output before automatic compaction',
        );
    } finally {
      release.resolve();
    }
    const state = parseSessionState(JSON.stringify(await session.saveState()));
    await session.close();
    await using restored = await owner.session({ state });
    const restoredContext = JSON.stringify(
      (await restored.modelContext()).items,
    );
    expect(restoredContext).toContain(
      phase === 'pre_turn'
        ? 'Pending user input after the settled answer'
        : 'settled tool output before automatic compaction',
    );
    expect(restoredContext).not.toContain(unacceptedSummary);
    expect(
      (await send(restored, 'Fresh input after automatic compaction failure'))
        .finalOutput,
    ).toBe('Fresh operation completed');
    expect(JSON.stringify(server.requests[3]?.input)).toContain(
      'Fresh input after automatic compaction failure',
    );
    expect(JSON.stringify(server.requests[3]?.input)).toContain(
      'Recovered summary after automatic compaction failure',
    );
    expect(execute).toHaveBeenCalledTimes(phase === 'mid_turn' ? 1 : 0);
    server.assertExhausted();
  },
  20_000,
);

it.each([
  [200, false],
  [429, false],
  [200, true],
  [429, true],
] as const)(
  'settles a direct registered throttle Turn over HTTP %s without replay or fallback (retry policy: %s)',
  async (status, useRetryPolicy) => {
    const bearer = token();
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const requestId = `direct-registered-throttle-${status}`;
    const { server } = await planEndpoint(
      [
        {
          status,
          headers: {
            'content-type':
              status === 200 ? 'text/event-stream' : 'application/json',
            'x-request-id': requestId,
            'retry-after': '3600',
          },
          body:
            status === 200
              ? sseFrames(
                  {
                    type: 'response.created',
                    response: { id: 'direct-throttle' },
                  },
                  // The retry-policy case isolates auth from the partial-output replay fence.
                  ...(useRetryPolicy
                    ? []
                    : [
                        {
                          type: 'response.output_item.done',
                          output_index: 0,
                          item: message('Unaccepted direct partial answer'),
                        },
                      ]),
                  {
                    type: 'response.failed',
                    response: {
                      error: {
                        code: 'rate_limit_exceeded',
                        message: 'Synthetic throttle',
                        headers: { 'Retry-After': '3600' },
                      },
                    },
                  },
                )
              : JSON.stringify({
                  error: {
                    code: 'rate_limit_exceeded',
                    message: 'Synthetic throttle',
                  },
                }),
        },
      ],
      {
        beforeEnd:
          status === 200
            ? async () => {
                held.resolve();
                await release.promise;
              }
            : undefined,
      },
    );
    const paths: string[] = [];
    server.onRecord = (phase, detail) => {
      if (phase === 'MODEL_REQUEST') {
        const { method, path } = detail as { method: string; path: string };
        paths.push(`${method} ${path}`);
      }
    };
    const route = NativeProviderRoutes.prototype as unknown as {
      handle(request: IncomingMessage): Promise<boolean>;
    };
    const privateHop = vi.spyOn(route, 'handle');
    const source = plan(bearer);
    await using provider = source.provider;
    const policy = vi.fn(() => ({ retry: true, delayMs: 0 }));
    const owner = agent(provider);
    if (useRetryPolicy)
      owner.modelSettings = { retry: { maxRetries: 1, policy } };
    const rolloutRoot = useRetryPolicy ? await directory() : undefined;
    await using session = await owner.session(
      rolloutRoot ? { storage: localStorage(rolloutRoot) } : {},
    );
    const turn = await session.submit('One physical throttle attempt');
    const failed = turn.wait().then(
      () => {
        throw new Error('Throttled Turn unexpectedly succeeded');
      },
      (error: unknown) => error,
    );
    try {
      if (status === 200)
        await beforeFixtureDeadline(
          Promise.race([
            held.promise,
            failed.then((error) => {
              throw error;
            }),
          ]),
        );
      const attention = await turn.waitForAttention({
        signal: AbortSignal.timeout(5_000),
      });
      expect(policy).not.toHaveBeenCalled();
      expect(attention).toMatchObject({
        type: 'needs_attention',
        reason: 'rate_limited',
      });
      assert('type' in attention && attention.type === 'needs_attention');
      expect(attention.error).toBeInstanceOf(NativeError);
      expect(attention.error).toMatchObject({
        statusCode: status,
        code: 'rate_limit_exceeded',
        category: 'rate_limit_exceeded',
        retryable: true,
        requestId,
      });
      expect(attention.error.retryAfterMs).toBeGreaterThan(0);
      expect(attention.error.retryAfterMs).toBeLessThanOrEqual(3_600_000);
      expect(session.rateLimits()).toEqual(attention.rateLimits);
      expect(await beforeFixtureDeadline(failed)).toBe(attention.error);
      expect(paths).toEqual(['POST /v1/responses']);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]).toMatchObject({ stream: true, store: false });
      expect(server.requests[0]).not.toHaveProperty('previous_response_id');
      expect(server.requestHeaders[0]?.authorization).toBe(`Bearer ${bearer}`);
      expect(server.requestHeaders[0]?.authorization).not.toContain(
        'synthetic-ambient-api-key',
      );
      expect(
        server.requestHeaders[0]?.['x-openai-internal-codex-responses-lite'],
      ).toBe('true');
      expect(source.getCredential).toHaveBeenCalledTimes(1);
      expect(privateHop).not.toHaveBeenCalled();
      server.assertExhausted();

      if (rolloutRoot) {
        await session.close();
        const rollout = (await readdir(rolloutRoot, { recursive: true })).find(
          (name) => name.endsWith(`${session.id}.jsonl`),
        );
        assert(rollout, 'Expected the retained root rollout');
        const attempts = (await readFile(join(rolloutRoot, rollout), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .filter(
            ({ type, payload }) =>
              type === 'event_msg' &&
              payload.type === '_sdk_model_attempt' &&
              payload.turn_id === turn.turnId,
          )
          .map(({ payload }) => payload.data);
        expect(attempts.map(({ phase }) => phase)).toEqual([
          'started',
          'finished',
          'terminal',
        ]);
        const attemptId = attempts[0].attempt_id;
        expect(attemptId).toEqual(expect.stringMatching(/\S/));
        for (const attempt of attempts) {
          expect(attempt).toMatchObject({
            attempt_id: attemptId,
            owner_attempt_id: attemptId,
            terminal_attempt_id: null,
          });
        }
        expect(attempts.slice(1).map(({ usage }) => usage.requests)).toEqual([
          1, 1,
        ]);
      }
    } finally {
      release.resolve();
    }
  },
  20_000,
);

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
    let stored: Buffer;
    if (storage) {
      const historyDb =
        kind === 'local' ? join(root, 'thread_history_1.sqlite') : undefined;
      const files = await readdir(root, {
        recursive: true,
        withFileTypes: true,
      });
      const buffers = await Promise.all(
        files
          .filter((entry) => entry.isFile())
          .map((entry) => join(entry.parentPath, entry.name))
          .filter((path) => path !== historyDb)
          .map((path) =>
            readFile(path).catch((error: NodeJS.ErrnoException) => {
              if (
                historyDb &&
                error.code === 'ENOENT' &&
                (path === `${historyDb}-shm` || path === `${historyDb}-wal`)
              ) {
                return Buffer.alloc(0);
              }
              throw error;
            }),
          ),
      );
      if (historyDb) {
        // SQLite can checkpoint WAL bytes into the database and remove both sidecars.
        buffers.push(await readFile(historyDb));
      }
      stored = Buffer.concat(buffers);
    } else {
      stored = Buffer.from(JSON.stringify(bound));
    }
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
  20_000,
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
