import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AgentCard, Message, Part, Role, Task, TaskState } from '@a2a-js/sdk';
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  type AgentExecutor,
} from '@a2a-js/sdk/server';
import { A2AError, connectA2A } from '../src/a2a/client';
import { A2AJobProvider } from '../src/a2a/provider';
import type { JobClaim } from '../src/experimental/deferred';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function peer(executor?: AgentExecutor) {
  const store = new InMemoryTaskStore();
  const calls: string[] = [];
  const headers: (string | undefined)[] = [];
  const server = createServer(async (request, response) => {
    headers.push(request.headers.authorization);
    if (request.url === '/card') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(AgentCard.toJSON(card)));
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push(JSON.parse(body).method);
    const context = new ServerCallContext({
      requestedVersion: '1.0',
      user: { isAuthenticated: true, userName: 'synthetic-user' },
    });
    const result = await rpc.handle(body, context);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(result));
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error();
  const base = `http://127.0.0.1:${address.port}`;
  const card = AgentCard.fromJSON({
    name: 'remote',
    version: '1',
    supportedInterfaces: [
      {
        url: `${base}/rpc`,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      },
    ],
  });
  const rpc = new JsonRpcTransportHandler(
    new DefaultRequestHandler(
      card,
      store,
      executor ?? {
        execute: async (context, bus) => {
          bus.publish(
            AgentEvent.task({
              ...Task.fromJSON({}),
              id: context.taskId,
              contextId: context.contextId,
              history: [context.userMessage],
              status: {
                state: TaskState.TASK_STATE_COMPLETED,
                message: undefined,
                timestamp: undefined,
              },
              artifacts: [
                {
                  artifactId: 'result',
                  name: '',
                  description: '',
                  metadata: undefined,
                  extensions: [],
                  parts: [
                    Part.fromJSON({
                      text: context.userMessage.parts[0].content?.value,
                    }),
                  ],
                },
              ],
            }),
          );
          bus.finished();
        },
        cancelTask: async () => {},
      },
    ),
  );
  return {
    endpoint: {
      name: 'remote',
      cardUrl: `${base}/card`,
      rpcUrl: `${base}/rpc`,
    },
    calls,
    headers,
    card,
    store,
  };
}

const context = { signal: new AbortController().signal };
function claim(
  action: JobClaim['action'] = 'start',
  update?: JobClaim['update'],
): JobClaim {
  return {
    key: 'invocation',
    generation: '1',
    action,
    update,
    binding: {
      tenant: 'tenant',
      runId: 'run',
      providerId: 'selected',
      sessionId: 'session',
      turnId: 'turn',
      callId: 'call',
      toolName: 'remote',
      requestDigest: 'input',
      checkpointDigest: 'checkpoint',
    },
  };
}

it('sanitizes initial host denials across provider operations before discovery or mutation effects', async () => {
  const remote = await peer();
  const sentinel = new Error('secret-host-denial-sentinel');
  let denied = false,
    authorizations = 0,
    credentials = 0,
    reservations = 0;
  const provider = new A2AJobProvider({
    endpoint: remote.endpoint,
    authorize: async () => {
      authorizations++;
      if (denied) throw sentinel;
    },
    authorization: async () => {
      credentials++;
      return 'synthetic';
    },
    reserve: async () => {
      reservations++;
    },
    encode: () => [Part.fromJSON({ text: 'hello' })],
    project: () => null,
  });
  const receipt = await provider.start(claim(), null, context);
  expect(receipt.status).toBe('completed');
  const task = JSON.parse(receipt.receipt!);
  const operations = [
    (current: typeof context) => provider.start(claim(), null, current),
    (current: typeof context) =>
      provider.observe(claim('observe', receipt), current),
    (current: typeof context) =>
      provider.respond(
        claim('respond', receipt),
        {
          taskId: task.taskId,
          contextId: task.contextId,
          challenge: 'challenge',
          generation: 1,
          result: true,
        },
        current,
      ),
    (current: typeof context) =>
      provider.cancel(claim('cancel', receipt), current),
  ];
  denied = true;
  authorizations = 0;
  credentials = 0;
  reservations = 0;
  remote.calls.length = 0;
  remote.headers.length = 0;
  for (const operation of operations) {
    const failure = await operation(context).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(A2AError);
    expect(failure).toMatchObject({
      reason: 'authorization',
      message: 'A2A authorization',
    });
    expect(String(failure)).not.toContain(sentinel.message);
    expect(failure).not.toHaveProperty('cause');
  }
  expect(authorizations).toBe(4);
  const cancellation = new Error('caller canceled');
  const controller = new AbortController();
  controller.abort(cancellation);
  for (const operation of operations)
    await expect(operation({ signal: controller.signal })).rejects.toBe(
      cancellation,
    );
  expect(authorizations).toBe(4);
  expect(credentials).toBe(0);
  expect(reservations).toBe(0);
  expect(remote.calls).toEqual([]);
  expect(remote.headers).toEqual([]);
});

it('preserves cancellation while awaiting the initial host authorization fence', async () => {
  const remote = await peer();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let credentials = 0,
    reservations = 0;
  const provider = new A2AJobProvider({
    endpoint: remote.endpoint,
    authorize: async () => {
      entered.resolve();
      await release.promise;
    },
    authorization: async () => {
      credentials++;
      return 'synthetic';
    },
    reserve: async () => {
      reservations++;
    },
    encode: () => [Part.fromJSON({ text: 'hello' })],
    project: () => null,
  });
  const controller = new AbortController(),
    cancellation = new Error('caller canceled during authorization');
  const operation = provider.start(claim(), null, {
    signal: controller.signal,
  });
  await entered.promise;
  controller.abort(cancellation);
  release.resolve();
  await expect(operation).rejects.toBe(cancellation);
  expect(credentials).toBe(0);
  expect(reservations).toBe(0);
  expect(remote.calls).toEqual([]);
  expect(remote.headers).toEqual([]);
});

it('discovers two independently hosted selected targets from 500 entries and correlates each invocation', async () => {
  const peers = await Promise.all([peer(), peer()]);
  const registry = Array.from({ length: 500 }, (_, index) => ({
    name: `agent_${index}`,
    endpoint: peers[index % 2].endpoint,
  }));
  let reserves = 0;
  for (const index of [17, 402]) {
    const selected = registry[index];
    const provider = new A2AJobProvider<string>({
      endpoint: selected.endpoint,
      authorize: async () => {},
      authorization: async () => 'synthetic-token',
      reserve: async () => {
        reserves++;
      },
      encode: (input) => [Part.fromJSON({ text: input })],
      project: (task) => task.artifacts[0].parts[0].content?.value,
    });
    const result = await provider.start(claim(), selected.name, context);
    expect(result.status).toBe('completed');
    expect(result.value).toBe(selected.name);
    expect(JSON.parse(result.receipt!).scope).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(reserves).toBe(2);
  expect(peers.map((remote) => remote.calls)).toEqual([
    ['SendMessage'],
    ['SendMessage'],
  ]);
  expect(peers[0].headers[0]).toBeUndefined();
  expect(peers[0].headers[1]).toBe('Bearer synthetic-token');
});

it('rejects a card route mismatch before resolving credentials', async () => {
  const remote = await peer();
  let credentials = 0;
  await expect(
    connectA2A(
      { ...remote.endpoint, rpcUrl: `${remote.endpoint.rpcUrl}/other` },
      {
        authorization: async () => {
          credentials++;
          return 'synthetic';
        },
      },
    ),
  ).rejects.toThrow('unsupported');
  expect(credentials).toBe(0);
  expect(remote.calls).toEqual([]);
});

it.each([
  ['embedded NUL', 'synthetic-\0-credential-sentinel'],
  ['invalid ByteString', 'synthetic-\u0100-credential-sentinel'],
  ['HTTP control 0x01', 'synthetic-\u0001-credential-sentinel'],
  ['HTTP control 0x1f', 'synthetic-\u001f-credential-sentinel'],
  ['HTTP control 0x7f', 'synthetic-\u007f-credential-sentinel'],
])(
  'rejects %s credentials safely before reserving or sending an RPC',
  async (_kind, token) => {
    const remote = await peer();
    let credentials = 0,
      reservations = 0;
    const authorization = async () => {
      credentials++;
      return token;
    };
    const reserve = async () => {
      reservations++;
    };
    const client = await connectA2A(remote.endpoint, {
      authorization,
      reserve,
    });
    expect(credentials).toBe(0);
    for (const operation of [
      () => client.getTask({ tenant: '', id: 'task' }),
      () =>
        client.sendMessage({
          tenant: '',
          metadata: undefined,
          configuration: undefined,
          message: {
            ...Message.fromJSON({}),
            messageId: 'synthetic-message',
            role: Role.ROLE_USER,
            parts: [Part.fromJSON({ text: 'hello' })],
          },
        }),
    ]) {
      const failure = await operation().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(A2AError);
      expect(failure).toMatchObject({
        reason: 'authorization',
        message: 'A2A authorization',
      });
      expect(failure).not.toHaveProperty('cause');
      expect(String(failure)).not.toContain('credential-sentinel');
    }
    expect(credentials).toBe(2);
    const provider = new A2AJobProvider({
      endpoint: remote.endpoint,
      authorize: async () => {},
      authorization,
      reserve,
      encode: () => [Part.fromJSON({ text: 'hello' })],
      project: () => null,
    });
    expect(await provider.start(claim(), null, context)).toEqual({
      status: 'unknown',
    });
    expect(reservations).toBe(0);
    expect(remote.calls).toEqual([]);
  },
);

it('refuses redirects and oversized discovery before credentials', async () => {
  const remote = await peer();
  let credentials = 0;
  const redirectModes: (RequestRedirect | undefined)[] = [];
  for (const response of [
    new Response(null, {
      status: 302,
      headers: { Location: 'https://example.org' },
    }),
    new Response('x'.repeat(100)),
  ]) {
    await expect(
      connectA2A(remote.endpoint, {
        authorization: async () => {
          credentials++;
          return 'synthetic';
        },
        limits: { bodyBytes: 50 },
        fetch: async (_url, init) => {
          redirectModes.push(init?.redirect);
          return response;
        },
      }),
    ).rejects.toThrow('A2A');
  }
  expect(redirectModes).toEqual(['manual', 'manual']);
  expect(credentials).toBe(0);
});

it.each(
  [
    { kind: 'quotes', character: '"' },
    { kind: 'backslashes', character: '\\' },
    { kind: 'multibyte text', character: 'é' },
  ].flatMap((content) =>
    [
      { position: 'below', offset: 1 },
      { position: 'equal to', offset: 0 },
      { position: 'above', offset: -1 },
    ].map((boundary) => ({ ...content, ...boundary })),
  ),
)(
  'counts serialized UTF-8 request bytes for $kind $position the transport cap',
  async ({ character, offset }) => {
    const remote = await peer();
    const request = (messageId: string) => ({
      tenant: '',
      metadata: undefined,
      configuration: undefined,
      message: {
        ...Message.fromJSON({}),
        messageId,
        role: Role.ROLE_USER,
        parts: [Part.fromJSON({ text: character.repeat(200) })],
      },
    });
    let rawBytes = 0;
    const calibration = await connectA2A(remote.endpoint, {
      authorization: async () => 'synthetic',
      limits: { inputBytes: 4096 },
      fetch: async (url, init) => {
        if (typeof init?.body === 'string')
          rawBytes = Buffer.byteLength(init.body);
        return fetch(url, init);
      },
    });
    await calibration.sendMessage(request('calibration'));
    expect(rawBytes).toBeGreaterThan(0);
    remote.calls.length = 0;
    let credentials = 0,
      reservations = 0,
      dispatchedBytes = 0;
    const client = await connectA2A(remote.endpoint, {
      authorization: async () => {
        credentials++;
        return 'synthetic';
      },
      reserve: async () => {
        reservations++;
      },
      limits: { inputBytes: rawBytes + offset },
      fetch: async (url, init) => {
        if (typeof init?.body === 'string')
          dispatchedBytes = Buffer.byteLength(init.body);
        return fetch(url, init);
      },
    });
    const operation = client.sendMessage(request('boundary-id'));
    if (offset < 0) {
      await expect(operation).rejects.toMatchObject({ reason: 'limit' });
      expect(credentials).toBe(0);
      expect(reservations).toBe(0);
      expect(dispatchedBytes).toBe(0);
      expect(remote.calls).toEqual([]);
    } else {
      expect(await operation).toHaveProperty('id');
      expect(credentials).toBe(1);
      expect(reservations).toBe(1);
      expect(dispatchedBytes).toBe(rawBytes);
      expect(remote.calls).toEqual(['SendMessage']);
    }
  },
);

it('preserves a known unsent provider envelope limit', async () => {
  const remote = await peer();
  const parts = [Part.fromJSON({ text: 'hello' })];
  let credentials = 0,
    reservations = 0;
  const provider = new A2AJobProvider({
    endpoint: remote.endpoint,
    authorize: async () => {},
    authorization: async () => {
      credentials++;
      return 'synthetic';
    },
    reserve: async () => {
      reservations++;
    },
    encode: () => parts,
    project: () => null,
    limits: {
      inputBytes: Buffer.byteLength(
        JSON.stringify(parts.map((part) => Part.toJSON(part))),
      ),
    },
  });
  await expect(provider.start(claim(), null, context)).rejects.toMatchObject({
    reason: 'limit',
  });
  expect(credentials).toBe(0);
  expect(reservations).toBe(0);
  expect(remote.calls).toEqual([]);
});

it('keeps a post-dispatch provider body limit indeterminate', async () => {
  const remote = await peer();
  let reservations = 0;
  const provider = new A2AJobProvider({
    endpoint: remote.endpoint,
    authorize: async () => {},
    authorization: async () => 'synthetic',
    reserve: async () => {
      reservations++;
    },
    encode: () => [Part.fromJSON({ text: 'hello' })],
    project: () => null,
    limits: { bodyBytes: 4096 },
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      return String(url) === remote.endpoint.rpcUrl
        ? new Response('x'.repeat(8192))
        : response;
    },
  });
  expect(await provider.start(claim(), null, context)).toEqual({
    status: 'unknown',
  });
  expect(reservations).toBe(1);
  expect(remote.calls).toEqual(['SendMessage']);
});

it.each(['current', 'authorization', 'reserve'] as const)(
  'preserves caller abort rejected during the asynchronous %s fence',
  async (phase) => {
    const remote = await peer();
    const controller = new AbortController();
    const cancellation = new Error('synthetic cancellation');
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let armed = false,
      credentials = 0,
      reservations = 0;
    const fence = async () => {
      entered.resolve();
      await release.promise;
      controller.signal.throwIfAborted();
    };
    const client = await connectA2A(remote.endpoint, {
      signal: controller.signal,
      current: async () => {
        if (armed && phase === 'current') await fence();
      },
      authorization: async () => {
        credentials++;
        if (phase === 'authorization') await fence();
        return 'synthetic';
      },
      reserve: async () => {
        reservations++;
        if (phase === 'reserve') await fence();
      },
    });
    armed = true;
    const operation = client.sendMessage({
      tenant: '',
      metadata: undefined,
      configuration: undefined,
      message: {
        ...Message.fromJSON({}),
        messageId: 'abort-fence',
        role: Role.ROLE_USER,
        parts: [Part.fromJSON({ text: 'hello' })],
      },
    });
    const result = expect(operation).rejects.toBe(cancellation);
    await entered.promise;
    controller.abort(cancellation);
    release.resolve();
    await result;
    expect(credentials).toBe(phase === 'current' ? 0 : 1);
    expect(reservations).toBe(phase === 'reserve' ? 1 : 0);
    expect(remote.calls).toEqual([]);
  },
);

it.each(['initial', 'after-credential'] as const)(
  'preserves caller abort rejected during provider %s authorization',
  async (phase) => {
    const remote = await peer();
    const controller = new AbortController();
    const cancellation = new Error('synthetic provider cancellation');
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let credentials = 0,
      reservations = 0;
    const provider = new A2AJobProvider({
      endpoint: remote.endpoint,
      authorize: async () => {
        if (phase === 'initial' || credentials > 0) {
          entered.resolve();
          await release.promise;
          controller.signal.throwIfAborted();
        }
      },
      authorization: async () => {
        credentials++;
        return 'synthetic';
      },
      reserve: async () => {
        reservations++;
      },
      encode: () => [Part.fromJSON({ text: 'hello' })],
      project: () => null,
    });
    const operation = provider.start(claim(), null, {
      signal: controller.signal,
    });
    const result = expect(operation).rejects.toBe(cancellation);
    await entered.promise;
    controller.abort(cancellation);
    release.resolve();
    await result;
    expect(credentials).toBe(phase === 'initial' ? 0 : 1);
    expect(reservations).toBe(0);
    expect(remote.calls).toEqual([]);
  },
);

it.each(['fetch', 'post-ack-policy'] as const)(
  'does not reuse another request limit as unsent proof after %s',
  async (phase) => {
    const remote = await peer();
    const request = {
      tenant: '',
      metadata: undefined,
      configuration: undefined,
      message: {
        ...Message.fromJSON({}),
        messageId: 'old-limit',
        role: Role.ROLE_USER,
        parts: [Part.fromJSON({ text: 'hello' })],
      },
    };
    const earlier = await connectA2A(remote.endpoint, {
      authorization: async () => 'synthetic',
      limits: { inputBytes: 1 },
    });
    const previousFailure = await earlier
      .sendMessage(request)
      .catch((error: unknown) => error);
    expect(previousFailure).toMatchObject({ reason: 'limit' });
    expect(remote.calls).toEqual([]);
    let reservations = 0,
      projections = 0;
    const provider = new A2AJobProvider({
      endpoint: remote.endpoint,
      authorize: async () => {
        if (phase === 'post-ack-policy' && remote.calls.includes('SendMessage'))
          throw previousFailure;
      },
      authorization: async () => 'synthetic',
      reserve: async () => {
        reservations++;
      },
      encode: () => [Part.fromJSON({ text: 'hello' })],
      project: () => {
        projections++;
        return null;
      },
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (phase === 'fetch' && String(url) === remote.endpoint.rpcUrl)
          throw previousFailure;
        return response;
      },
    });
    expect(await provider.start(claim(), null, context)).toEqual({
      status: 'unknown',
    });
    expect(reservations).toBe(1);
    expect(projections).toBe(0);
    expect(remote.calls).toEqual(['SendMessage']);
  },
);

it('keeps provider object admission before discovery and transport sizing', async () => {
  const remote = await peer();
  let credentials = 0,
    reservations = 0;
  const parts = [Part.fromJSON({ text: 'x'.repeat(1024) })];
  expect(Buffer.byteLength(JSON.stringify(parts))).toBeGreaterThan(128);
  const provider = new A2AJobProvider({
    endpoint: remote.endpoint,
    authorize: async () => {},
    authorization: async () => {
      credentials++;
      return 'synthetic';
    },
    reserve: async () => {
      reservations++;
    },
    encode: () => parts,
    project: () => null,
    limits: { inputBytes: 128 },
  });
  await expect(provider.start(claim(), null, context)).rejects.toMatchObject({
    reason: 'limit',
  });
  expect(credentials).toBe(0);
  expect(reservations).toBe(0);
  expect(remote.headers).toEqual([]);
  expect(remote.calls).toEqual([]);
});

it.each(
  ['discovery', 'poll'].flatMap((phase) =>
    [401, 429, 503].map((status) => ({ phase, status })),
  ),
)(
  'cancels rejected $phase bodies with status $status without leaking cleanup errors',
  async ({ phase, status }) => {
    const remote = await peer();
    let canceled = 0;
    const bodies: ReadableStream<Uint8Array>[] = [];
    const transport: typeof fetch = async (url, init) => {
      if (phase === 'poll' && String(url) === remote.endpoint.cardUrl)
        return fetch(url, init);
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          canceled++;
          if (status === 503) throw new Error('secret-cleanup-sentinel');
        },
      });
      bodies.push(body);
      return new Response(body, { status });
    };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const operation = async () => {
          const client = await connectA2A(remote.endpoint, {
            authorization: async () => 'synthetic',
            fetch: transport,
          });
          await client.getTask({ tenant: '', id: 'task' });
        };
        const failure = await operation().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(A2AError);
        expect(failure).toMatchObject({ message: 'A2A unavailable' });
        expect(failure).not.toHaveProperty('cause');
        expect(String(failure)).not.toContain('secret-cleanup-sentinel');
      }
      expect(canceled).toBe(2);
    } finally {
      await Promise.all(bodies.map((body) => body.cancel().catch(() => {})));
    }
  },
);

it.each(['throwing', 'oversized'])(
  'retains an acknowledged receipt after a %s projection and observes it after restart',
  async (failure) => {
    const remote = await peer();
    let reservations = 0,
      projections = 0;
    const options = {
      endpoint: remote.endpoint,
      authorize: async () => {},
      authorization: async () => 'synthetic',
      reserve: async () => {
        reservations++;
      },
      encode: () => [Part.fromJSON({ text: 'hello' })],
      limits: { bodyBytes: 2048 },
    };
    const original = new A2AJobProvider({
      ...options,
      project: () => {
        projections++;
        if (failure === 'throwing')
          throw new Error('secret-projection-sentinel');
        return 'x'.repeat(4096);
      },
    });
    const update = await original.start(claim(), null, context);
    expect(update.status).toBe('unknown');
    expect(update).not.toHaveProperty('value');
    expect(update.receipt).toEqual(expect.any(String));
    expect(projections).toBe(1);
    const receipt = JSON.parse(update.receipt!);
    expect(receipt).toEqual({
      scope: expect.stringMatching(/^[a-f0-9]{64}$/),
      taskId: expect.any(String),
      contextId: expect.any(String),
    });
    const replacement = new A2AJobProvider({
      ...options,
      project: () => 'accepted',
    });
    expect(
      await replacement.start(claim('start', update), null, context),
    ).toEqual({
      status: 'completed',
      receipt: update.receipt,
      value: 'accepted',
    });
    expect(remote.calls).toEqual(['SendMessage', 'GetTask']);
    expect(reservations).toBe(1);
  },
);

it('keeps a body limit error safe when reader cleanup rejects', async () => {
  const remote = await peer();
  let canceled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(64));
    },
    cancel() {
      canceled++;
      throw new Error('secret-cleanup-sentinel');
    },
  });
  const failure = await connectA2A(remote.endpoint, {
    authorization: async () => 'synthetic',
    limits: { bodyBytes: 32 },
    fetch: async () => new Response(body),
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(A2AError);
  expect(failure).toMatchObject({ message: 'A2A limit' });
  expect(failure).not.toHaveProperty('cause');
  expect(String(failure)).not.toContain('secret-cleanup-sentinel');
  expect(canceled).toBe(1);
});

it.each(['revoked authority', 'missing identity'])(
  'does not retain an acknowledged task under %s',
  async (rejection) => {
    const remote = await peer();
    let allowed = true,
      acknowledged = false,
      projections = 0;
    const provider = new A2AJobProvider({
      endpoint: remote.endpoint,
      authorize: async () => {
        if (!allowed) throw new Error('revoked');
      },
      authorization: async () => 'synthetic',
      reserve: async () => {},
      encode: () => [Part.fromJSON({ text: 'hello' })],
      project: () => {
        projections++;
        return 'rejected';
      },
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (String(url) !== remote.endpoint.rpcUrl) return response;
        acknowledged = true;
        if (rejection === 'revoked authority') {
          allowed = false;
          return response;
        }
        const payload = await response.json();
        expect(payload.result.task.contextId).toEqual(expect.any(String));
        payload.result.task.contextId = '';
        return new Response(JSON.stringify(payload), {
          headers: response.headers,
        });
      },
    });
    expect(await provider.start(claim(), null, context)).toEqual({
      status: 'unknown',
    });
    expect(acknowledged).toBe(true);
    expect(projections).toBe(0);
    expect(remote.calls).toEqual(['SendMessage']);
  },
);

it('retains only the existing receipt when an observed task identity changes', async () => {
  const remote = await peer();
  let reservations = 0,
    projections = 0,
    changed = false;
  const options = {
    endpoint: remote.endpoint,
    authorize: async () => {},
    authorization: async () => 'synthetic',
    reserve: async () => {
      reservations++;
    },
    encode: () => [Part.fromJSON({ text: 'hello' })],
    project: () => 'accepted',
  };
  const update = await new A2AJobProvider(options).start(
    claim(),
    null,
    context,
  );
  const replacement = new A2AJobProvider({
    ...options,
    project: () => {
      projections++;
      return 'rejected';
    },
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (String(url) !== remote.endpoint.rpcUrl) return response;
      const payload = await response.json();
      expect(payload.result.contextId).toBe(
        JSON.parse(update.receipt!).contextId,
      );
      payload.result.contextId = 'different-context';
      changed = true;
      return new Response(JSON.stringify(payload), {
        headers: response.headers,
      });
    },
  });
  expect(await replacement.observe(claim('observe', update), context)).toEqual({
    status: 'unknown',
    receipt: update.receipt,
  });
  expect(changed).toBe(true);
  expect(projections).toBe(0);
  expect(
    await new A2AJobProvider(options).observe(
      claim('observe', update),
      context,
    ),
  ).toEqual(update);
  expect(remote.calls).toEqual(['SendMessage', 'GetTask', 'GetTask']);
  expect(reservations).toBe(1);
});

it('keeps lost create acknowledgments unknown and only observes a known receipt after restart', async () => {
  const remote = await peer();
  let reserves = 0;
  const options = {
    endpoint: remote.endpoint,
    authorize: async () => {},
    authorization: async () => 'synthetic',
    reserve: async () => {
      reserves++;
    },
    encode: (input: string) => [Part.fromJSON({ text: input })],
    project: () => 'result',
  };
  const original = new A2AJobProvider(options);
  const result = await original.start(claim(), 'hello', context);
  const replacement = new A2AJobProvider(options);
  expect(
    (await replacement.start(claim('start', result), 'hello', context)).status,
  ).toBe('completed');
  expect(remote.calls).toEqual(['SendMessage', 'GetTask']);
  expect(reserves).toBe(1);
  let mutations = 0;
  const lost = new A2AJobProvider({
    ...options,
    fetch: async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(url).endsWith('/card')) return fetch(url, init);
      mutations++;
      throw new Error('secret-peer-data');
    },
  });
  expect(await lost.start(claim(), 'hello', context)).toEqual({
    status: 'unknown',
  });
  expect(mutations).toBe(1);
});

it('reconciles an accepted lost create only through an authorized application receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a2a-reconcile-'));
  const ledger = join(directory, 'effect.json');
  let expected: Record<string, unknown> = {};
  let effects = 0;
  const remote = await peer({
    execute: async (request, bus) => {
      expect(request.userMessage.parts[0].content).toEqual({
        $case: 'text',
        value: 'synthetic-order',
      });
      await writeFile(
        ledger,
        JSON.stringify({
          ...expected,
          taskId: request.taskId,
          contextId: request.contextId,
        }),
        { flag: 'wx', mode: 0o600 },
      );
      effects++;
      bus.publish(
        AgentEvent.task({
          ...Task.fromJSON({}),
          id: request.taskId,
          contextId: request.contextId,
          status: {
            state: TaskState.TASK_STATE_COMPLETED,
            message: undefined,
            timestamp: undefined,
          },
        }),
      );
      bus.finished();
    },
    cancelTask: async () => {},
  });
  let reservations = 0;
  let allowed = true;
  let revokeDuringCredentials = false;
  let dropped = false;
  const provider = new A2AJobProvider<string>({
    endpoint: remote.endpoint,
    authorize: async () => {
      if (!allowed) throw new Error('Host authority revoked');
    },
    authorization: async () => 'synthetic',
    reserve: async () => {
      reservations++;
    },
    encode: (order) => [Part.fromJSON({ text: order })],
    project: () => 'completed',
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (init?.method === 'POST' && !dropped) {
        dropped = true;
        await response.arrayBuffer();
        throw new Error('Synthetic accepted-create acknowledgment loss');
      }
      return response;
    },
  });
  const current = claim();
  expected = {
    principal: 'synthetic-user',
    endpoint: remote.endpoint.rpcUrl,
    order: 'synthetic-order',
    binding: current.binding,
    key: current.key,
    generation: current.generation,
  };
  try {
    const unknown = await provider.start(current, 'synthetic-order', context);
    expect(unknown).toEqual({ status: 'unknown' });
    // A replacement host has been reading its configured application ledger independently of A2A.
    const saved = JSON.parse(await readFile(ledger, 'utf8')) as Record<
      string,
      unknown
    >;
    const reconcile = async (
      receipt: Record<string, unknown> | undefined,
      source = 'application-ledger',
    ) => {
      if (!allowed || source !== 'application-ledger' || !receipt)
        return undefined;
      if (
        Object.entries(expected).some(
          ([key, value]) =>
            JSON.stringify(receipt[key]) !== JSON.stringify(value),
        )
      )
        return undefined;
      if (
        typeof receipt.taskId !== 'string' ||
        typeof receipt.contextId !== 'string' ||
        !receipt.taskId ||
        !receipt.contextId
      )
        return undefined;
      const client = await connectA2A(remote.endpoint, {
        current: async () => {
          if (!allowed) throw new Error('Host authority revoked');
        },
        authorization: async () => {
          if (revokeDuringCredentials) allowed = false;
          return 'synthetic';
        },
      });
      const task = await client
        .getTask({ tenant: '', id: receipt.taskId })
        .catch(() => undefined);
      if (!task) return undefined;
      if (task.id !== receipt.taskId || task.contextId !== receipt.contextId)
        return undefined;
      return task.status?.state;
    };
    expect(await reconcile(undefined)).toBeUndefined();
    expect(await reconcile(saved, 'peer-metadata')).toBeUndefined();
    for (const [key, value] of Object.entries({
      principal: 'foreign-user',
      endpoint: 'https://foreign.example/rpc',
      order: 'other-order',
      binding: {},
      key: 'foreign',
      generation: '2',
      taskId: '',
      contextId: '',
    }))
      expect(await reconcile({ ...saved, [key]: value })).toBeUndefined();
    allowed = false;
    expect(await reconcile(saved)).toBeUndefined();
    expect(remote.calls).toEqual(['SendMessage']);
    allowed = true;
    revokeDuringCredentials = true;
    expect(await reconcile(saved)).toBeUndefined();
    expect(remote.calls).toEqual(['SendMessage']);
    allowed = true;
    revokeDuringCredentials = false;
    expect(await reconcile(saved)).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(remote.calls).toEqual(['SendMessage', 'GetTask']);
    expect(unknown).toEqual({ status: 'unknown' });
    expect(JSON.parse(await readFile(ledger, 'utf8'))).toEqual(saved);
    expect(effects).toBe(1);
    expect(reservations).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps auth-required out of generic input approvals', async () => {
  const remote = await peer({
    execute: async (request, bus) => {
      bus.publish(
        AgentEvent.task({
          ...Task.fromJSON({}),
          id: request.taskId,
          contextId: request.contextId,
          status: {
            state: TaskState.TASK_STATE_AUTH_REQUIRED,
            message: undefined,
            timestamp: undefined,
          },
        }),
      );
      bus.finished();
    },
    cancelTask: async () => {},
  });
  const provider = new A2AJobProvider({
    endpoint: remote.endpoint,
    authorize: async () => {},
    authorization: async () => 'synthetic',
    reserve: async () => {},
    encode: () => [Part.fromJSON({ text: 'hello' })],
    project: () => null,
  });
  expect(await provider.start(claim(), null, context)).toMatchObject({
    status: 'pending',
    value: { authRequired: true },
  });
});

it('uses official JSON-RPC serialization for text parts', async () => {
  const remote = await peer();
  const client = await connectA2A(remote.endpoint, {
    authorization: async () => 'synthetic',
  });
  const result = await client.sendMessage({
    tenant: '',
    configuration: undefined,
    metadata: undefined,
    message: {
      ...Message.fromJSON({}),
      messageId: 'original-invocation',
      role: Role.ROLE_USER,
      parts: [Part.fromJSON({ text: 'hello' })],
    },
  });
  expect('id' in result && result.history[0].messageId).toBe(
    'original-invocation',
  );
});

it('passes only an explicit validated trace carrier to credentialed RPC calls', async () => {
  const remote = await peer();
  const seen: { url: string; trace: string | null }[] = [];
  const traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
  const client = await connectA2A(remote.endpoint, {
    authorization: async () => 'synthetic',
    parentTrace: { traceparent },
    fetch: async (url, init) => {
      seen.push({
        url: String(url),
        trace: new Headers(init?.headers).get('traceparent'),
      });
      return fetch(url, init);
    },
  });
  await client.sendMessage({
    tenant: '',
    configuration: undefined,
    metadata: undefined,
    message: {
      ...Message.fromJSON({}),
      messageId: 'traced-invocation',
      role: Role.ROLE_USER,
      parts: [Part.fromJSON({ text: 'hello' })],
    },
  });
  expect(seen.map((request) => request.trace)).toEqual([null, traceparent]);
});

it('sanitizes peer errors and credential resolver failures without a raw cause', async () => {
  const remote = await peer();
  for (const payload of [
    'secret-peer-data',
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: 'secret-peer-data' },
    }),
  ]) {
    const client = await connectA2A(remote.endpoint, {
      authorization: async () => 'synthetic',
      fetch: async (url, init) =>
        String(url).endsWith('/card')
          ? fetch(url, init)
          : new Response(payload),
    });
    try {
      await client.getTask({ tenant: '', id: 'task' });
      throw new Error('Expected rejection');
    } catch (error) {
      expect(String(error)).not.toContain('secret-peer-data');
      expect(error).not.toHaveProperty('cause');
    }
  }
  const client = await connectA2A(remote.endpoint, {
    authorization: async () => {
      throw new Error('secret-credential-data');
    },
  });
  await expect(client.getTask({ tenant: '', id: 'task' })).rejects.toThrow(
    'authorization',
  );
  expect(remote.calls).toEqual([]);
});

it('fences a revoked current claim after credential resolution and before mutation reservation', async () => {
  const remote = await peer();
  let allowed = true,
    reserved = 0;
  const provider = new A2AJobProvider({
    endpoint: remote.endpoint,
    authorize: async () => {
      if (!allowed) throw new Error('revoked');
    },
    authorization: async () => {
      allowed = false;
      return 'synthetic';
    },
    reserve: async () => {
      reserved++;
    },
    encode: () => [Part.fromJSON({ text: 'hello' })],
    project: () => null,
  });
  expect(await provider.start(claim(), null, context)).toEqual({
    status: 'unknown',
  });
  expect(reserved).toBe(0);
  expect(remote.calls).toEqual([]);
});

it('keeps an uncertain reply reservation bound to the challenge when the answer or worker generation changes', async () => {
  const remote = await peer({
    execute: async (request, bus) => {
      bus.publish(
        AgentEvent.task({
          ...Task.fromJSON({}),
          id: request.taskId,
          contextId: request.contextId,
          status: {
            state: TaskState.TASK_STATE_INPUT_REQUIRED,
            timestamp: undefined,
            message: {
              ...Message.fromJSON({}),
              parts: [
                Part.fromJSON({
                  data: {
                    challenge: 'challenge',
                    generation: 1,
                    tool: 'decision',
                    arguments: {},
                  },
                }),
              ],
            },
          },
        }),
      );
      bus.finished();
    },
    cancelTask: async () => {},
  });
  const reservations = new Set<string>();
  let replySends = 0;
  const provider = new A2AJobProvider({
    endpoint: remote.endpoint,
    authorize: async () => {},
    authorization: async () => 'synthetic',
    reserve: async (_claim, _operation, actionId) => {
      if (reservations.has(actionId)) throw new Error('already spent');
      reservations.add(actionId);
    },
    encode: () => [Part.fromJSON({ text: 'hello' })],
    project: () => null,
    fetch: async (url, init) => {
      if (
        typeof init?.body === 'string' &&
        JSON.parse(init.body).params?.message?.taskId
      ) {
        replySends++;
        throw new Error('lost reply acknowledgment');
      }
      return fetch(url, init);
    },
  });
  const pending = await provider.start(claim(), null, context);
  const receipt = JSON.parse(pending.receipt!);
  const reply = {
    taskId: receipt.taskId,
    contextId: receipt.contextId,
    challenge: 'challenge',
    generation: 1,
    result: false,
  };
  expect(
    (await provider.respond(claim('respond', pending), reply, context)).status,
  ).toBe('unknown');
  expect(
    (
      await provider.respond(
        { ...claim('respond', pending), generation: 'next-worker' },
        { ...reply, result: true },
        context,
      )
    ).status,
  ).toBe('unknown');
  expect(replySends).toBe(1);
  expect(reservations.size).toBe(2);
});

it.each(['missing message', 'unsupported text', 'malformed data'])(
  'keeps %s input-required proposals unknown with an acknowledged receipt',
  async (shape) => {
    const remote = await peer({
      execute: async (request, bus) => {
        bus.publish(
          AgentEvent.task({
            ...Task.fromJSON({}),
            id: request.taskId,
            contextId: request.contextId,
            status: {
              state: TaskState.TASK_STATE_INPUT_REQUIRED,
              timestamp: undefined,
              message:
                shape === 'missing message'
                  ? undefined
                  : {
                      ...Message.fromJSON({}),
                      parts: [
                        Part.fromJSON(
                          shape === 'unsupported text'
                            ? { text: 'answer me' }
                            : { data: { tool: 'confirm' } },
                        ),
                      ],
                    },
            },
          }),
        );
        bus.finished();
      },
      cancelTask: async () => {},
    });
    const provider = new A2AJobProvider({
      endpoint: remote.endpoint,
      authorize: async () => {},
      authorization: async () => 'synthetic',
      reserve: async () => {},
      encode: () => [Part.fromJSON({ text: 'hello' })],
      project: () => null,
    });
    const update = await provider.start(claim(), null, context);
    expect(update.status).toBe('unknown');
    expect(update).not.toHaveProperty('value');
    expect(JSON.parse(update.receipt!)).toMatchObject({
      taskId: expect.any(String),
      contextId: expect.any(String),
    });
    expect(await provider.observe(claim('observe', update), context)).toEqual(
      update,
    );
    expect(remote.calls).toEqual(['SendMessage', 'GetTask']);
  },
);

it.each([300_000, 800_000])(
  'bounds inline image input by official wire bytes (%i bytes)',
  async (size) => {
    const remote = await peer({
      execute: async (request, bus) => {
        bus.publish(
          AgentEvent.task({
            ...Task.fromJSON({}),
            id: request.taskId,
            contextId: request.contextId,
            status: {
              state: TaskState.TASK_STATE_COMPLETED,
              message: undefined,
              timestamp: undefined,
            },
          }),
        );
        bus.finished();
      },
      cancelTask: async () => {},
    });
    let credentials = 0,
      reservations = 0;
    const part = Part.fromJSON({
      raw: Buffer.alloc(size, 120).toString('base64'),
      mediaType: 'image/png',
    });
    const provider = new A2AJobProvider({
      endpoint: remote.endpoint,
      authorize: async () => {},
      authorization: async () => {
        credentials++;
        return 'synthetic';
      },
      reserve: async () => {
        reservations++;
      },
      encode: () => [part],
      project: () => null,
    });
    const operation = provider.start(claim(), null, context);
    if (size < 400_000) {
      expect(
        Buffer.byteLength(JSON.stringify([Part.toJSON(part)])),
      ).toBeLessThan(1024 * 1024);
      expect(await operation).toMatchObject({
        status: 'completed',
        value: null,
      });
      expect(remote.calls).toEqual(['SendMessage']);
      expect(reservations).toBe(1);
    } else {
      await expect(operation).rejects.toMatchObject({ reason: 'limit' });
      expect(remote.headers).toEqual([]);
      expect(credentials).toBe(0);
      expect(reservations).toBe(0);
    }
  },
);

it.each(['discovery fetch', 'RPC fetch', 'RPC body'])(
  'preserves caller cancellation during %s',
  async (phase) => {
    const remote = await peer();
    const controller = new AbortController(),
      cancellation = new Error('caller transport cancellation');
    const entered = Promise.withResolvers<void>();
    const options = {
      authorization: async () => 'synthetic',
      signal: controller.signal,
      fetch: (async (url, init) => {
        if (
          String(url) === remote.endpoint.cardUrl &&
          phase !== 'discovery fetch'
        )
          return fetch(url, init);
        if (phase === 'RPC body') {
          return new Response(
            new ReadableStream({
              start(stream) {
                init!.signal!.addEventListener(
                  'abort',
                  () => stream.error(init!.signal!.reason),
                  { once: true },
                );
                entered.resolve();
              },
            }),
          );
        }
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => reject(init!.signal!.reason),
            { once: true },
          );
          entered.resolve();
        });
      }) as typeof fetch,
    };
    const operation =
      phase === 'discovery fetch'
        ? connectA2A(remote.endpoint, options)
        : (await connectA2A(remote.endpoint, options)).getTask({
            tenant: '',
            id: 'task',
          });
    await entered.promise;
    controller.abort(cancellation);
    await expect(operation).rejects.toBe(cancellation);
  },
);

it('rejects a manual-reply challenge from another task before reservation or send', async () => {
  const remote = await peer({
    execute: async (request, bus) => {
      bus.publish(
        AgentEvent.task({
          ...Task.fromJSON({}),
          id: request.taskId,
          contextId: request.contextId,
          status: {
            state: TaskState.TASK_STATE_INPUT_REQUIRED,
            timestamp: undefined,
            message: {
              ...Message.fromJSON({}),
              parts: [
                Part.fromJSON({
                  data: {
                    challenge: 'challenge',
                    generation: 1,
                    tool: 'decision',
                    arguments: {},
                  },
                }),
              ],
            },
          },
        }),
      );
      bus.finished();
    },
    cancelTask: async () => {},
  });
  const reservations: string[] = [];
  const sent: string[] = [];
  const provider = new A2AJobProvider({
    endpoint: remote.endpoint,
    authorize: async () => {},
    authorization: async () => 'synthetic',
    reserve: async (_claim, operation) => {
      reservations.push(operation);
    },
    encode: () => [Part.fromJSON({ text: 'hello' })],
    project: () => null,
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (typeof init?.body === 'string') {
        sent.push(init.body);
        if (JSON.parse(init.body).method === 'GetTask') {
          const payload = await response.json();
          payload.result.id = 'different-task';
          return new Response(JSON.stringify(payload), {
            headers: response.headers,
          });
        }
      }
      return response;
    },
  });
  const pending = await provider.start(claim(), null, context);
  expect(pending.status).toBe('inputRequired');
  const receipt = JSON.parse(pending.receipt!);
  await expect(
    provider.respond(
      claim('respond', pending),
      {
        taskId: receipt.taskId,
        contextId: receipt.contextId,
        challenge: 'challenge',
        generation: 1,
        result: 'confidential-answer-sentinel',
      },
      context,
    ),
  ).rejects.toMatchObject({ reason: 'authorization' });
  expect(reservations).toEqual(['start']);
  expect(remote.calls).toEqual(['SendMessage', 'GetTask']);
  expect(sent.join('')).not.toContain('confidential-answer-sentinel');
});

it.each(['respond', 'cancel'] as const)(
  'preserves a known unsent provider %s limit and permits a corrected retry',
  async (operation) => {
    let conversation = '';
    const remote = await peer({
      execute: async (request, bus) => {
        conversation = request.contextId;
        const replying = request.userMessage.parts[0].content?.$case === 'data';
        bus.publish(
          AgentEvent.task({
            ...Task.fromJSON({}),
            id: request.taskId,
            contextId: request.contextId,
            status: {
              state: replying
                ? TaskState.TASK_STATE_COMPLETED
                : TaskState.TASK_STATE_INPUT_REQUIRED,
              timestamp: undefined,
              message: replying
                ? undefined
                : {
                    ...Message.fromJSON({}),
                    role: Role.ROLE_AGENT,
                    parts: [
                      Part.fromJSON({
                        data: {
                          challenge: 'bounded-reply',
                          generation: 1,
                          tool: 'decision',
                          arguments: {},
                        },
                      }),
                    ],
                  },
            },
          }),
        );
        bus.finished();
      },
      cancelTask: async (id, bus) => {
        bus.publish(
          AgentEvent.task({
            ...Task.fromJSON({}),
            id,
            contextId: conversation,
            status: {
              state: TaskState.TASK_STATE_CANCELED,
              timestamp: undefined,
              message: undefined,
            },
          }),
        );
        bus.finished();
      },
    });
    const credentials: string[] = [],
      reservations: string[] = [];
    const provider = (inputBytes?: number) =>
      new A2AJobProvider({
        endpoint: remote.endpoint,
        authorize: async () => {},
        authorization: async (op) => {
          credentials.push(op);
          return 'synthetic';
        },
        reserve: async (_claim, op) => {
          reservations.push(op);
        },
        encode: () => [Part.fromJSON({ text: 'hello' })],
        project: () => null,
        limits: { inputBytes },
      });
    const admitted = await provider().start(claim(), null, context),
      receipt = JSON.parse(admitted.receipt!);
    expect(admitted.status).toBe('inputRequired');
    const before = structuredClone(admitted),
      reply = {
        taskId: receipt.taskId,
        contextId: receipt.contextId,
        challenge: 'bounded-reply',
        generation: 1,
        result: 'x'.repeat(256),
      };
    credentials.length = 0;
    reservations.length = 0;
    remote.calls.length = 0;
    const bounded = provider(
      operation === 'respond' ? Buffer.byteLength(JSON.stringify(reply)) : 1,
    );
    await expect(
      operation === 'respond'
        ? bounded.respond(claim('respond', admitted), reply, context)
        : bounded.cancel(claim('cancel', admitted), context),
    ).rejects.toMatchObject({ reason: 'limit' });
    expect(admitted).toEqual(before);
    expect(reservations).toEqual([]);
    expect(credentials).toEqual(operation === 'respond' ? ['observe'] : []);
    expect(remote.calls).toEqual(operation === 'respond' ? ['GetTask'] : []);
    const retried =
      operation === 'respond'
        ? await provider().respond(claim('respond', admitted), reply, context)
        : await provider().cancel(claim('cancel', admitted), context);
    expect(retried).toMatchObject({
      status: operation === 'respond' ? 'completed' : 'cancelled',
      receipt: admitted.receipt,
    });
    expect(reservations).toEqual([operation]);
    expect(remote.calls).toEqual(
      operation === 'respond'
        ? ['GetTask', 'GetTask', 'SendMessage']
        : ['CancelTask'],
    );
  },
);

it.each(['respond', 'cancel'] as const)(
  'keeps a post-dispatch %s limit unknown with its receipt',
  async (operation) => {
    let conversation = '';
    const remote = await peer({
      execute: async (request, bus) => {
        conversation = request.contextId;
        const replying = request.userMessage.parts[0].content?.$case === 'data';
        bus.publish(
          AgentEvent.task({
            ...Task.fromJSON({}),
            id: request.taskId,
            contextId: request.contextId,
            status: {
              state: replying
                ? TaskState.TASK_STATE_COMPLETED
                : TaskState.TASK_STATE_INPUT_REQUIRED,
              timestamp: undefined,
              message: replying
                ? undefined
                : {
                    ...Message.fromJSON({}),
                    role: Role.ROLE_AGENT,
                    parts: [
                      Part.fromJSON({
                        data: {
                          challenge: 'bounded-reply',
                          generation: 1,
                          tool: 'decision',
                          arguments: {},
                        },
                      }),
                    ],
                  },
            },
          }),
        );
        bus.finished();
      },
      cancelTask: async (id, bus) => {
        bus.publish(
          AgentEvent.task({
            ...Task.fromJSON({}),
            id,
            contextId: conversation,
            status: {
              state: TaskState.TASK_STATE_CANCELED,
              timestamp: undefined,
              message: undefined,
            },
          }),
        );
        bus.finished();
      },
    });
    const reservations: string[] = [];
    const options = {
      endpoint: remote.endpoint,
      authorize: async () => {},
      authorization: async () => 'synthetic',
      reserve: async (_claim: JobClaim, op: string) => {
        reservations.push(op);
      },
      encode: () => [Part.fromJSON({ text: 'hello' })],
      project: () => null,
    };
    const provider = new A2AJobProvider(options),
      admitted = await provider.start(claim(), null, context),
      receipt = JSON.parse(admitted.receipt!);
    reservations.length = 0;
    remote.calls.length = 0;
    const broken = new A2AJobProvider({
      ...options,
      limits: { bodyBytes: 2048 },
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (
          typeof init?.body === 'string' &&
          JSON.parse(init.body).method ===
            (operation === 'respond' ? 'SendMessage' : 'CancelTask')
        )
          return new Response('x'.repeat(4096));
        return response;
      },
    });
    const result =
      operation === 'respond'
        ? await broken.respond(
            claim('respond', admitted),
            {
              taskId: receipt.taskId,
              contextId: receipt.contextId,
              challenge: 'bounded-reply',
              generation: 1,
              result: true,
            },
            context,
          )
        : await broken.cancel(claim('cancel', admitted), context);
    expect(result).toEqual({ status: 'unknown', receipt: admitted.receipt });
    expect(reservations).toEqual([operation]);
    expect(
      await provider.observe(claim('observe', result), context),
    ).toMatchObject({
      status: operation === 'respond' ? 'completed' : 'cancelled',
      receipt: admitted.receipt,
    });
    expect(remote.calls).toEqual(
      operation === 'respond'
        ? ['GetTask', 'SendMessage', 'GetTask']
        : ['CancelTask', 'GetTask'],
    );
  },
);

it.each(
  ['send', 'observe'].flatMap((operation) =>
    ['fetch', 'body'].flatMap((phase) =>
      [true, false].map((allowed) => ({ operation, phase, allowed })),
    ),
  ),
)(
  'fences a revoked direct-client response for $operation/$phase with authority=$allowed',
  async ({ operation, phase, allowed }) => {
    const remote = await peer();
    const request = {
      tenant: '',
      configuration: undefined,
      metadata: undefined,
      message: {
        ...Message.fromJSON({}),
        messageId: 'response-fence',
        role: Role.ROLE_USER,
        parts: [Part.fromJSON({ text: 'hello' })],
      },
    };
    const initial = await (
      await connectA2A(remote.endpoint, {
        authorization: async () => 'synthetic',
      })
    ).sendMessage(request);
    if (!('id' in initial)) throw new Error('Expected Task');
    remote.calls.length = 0;
    let current = true;
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const client = await connectA2A(remote.endpoint, {
      authorization: async () => 'synthetic',
      current: async () => {
        if (!current) throw new Error('private revoked policy');
      },
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (String(url) !== remote.endpoint.rpcUrl) return response;
        if (phase === 'fetch') {
          entered.resolve();
          await release.promise;
          return response;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              const split = Math.floor(bytes.length / 2);
              stream.enqueue(bytes.subarray(0, split));
              entered.resolve();
              void release.promise.then(() => {
                stream.enqueue(bytes.subarray(split));
                stream.close();
              });
            },
          }),
          { headers: response.headers },
        );
      },
    });
    const pending =
      operation === 'send'
        ? client.sendMessage(request)
        : client.getTask({ tenant: '', id: initial.id });
    const result = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await entered.promise;
    current = allowed;
    release.resolve();
    const settled = await result;
    if (allowed) expect('value' in settled && 'id' in settled.value).toBe(true);
    else {
      expect('error' in settled && settled.error).toMatchObject({
        reason: 'authorization',
      });
      expect(String('error' in settled && settled.error)).not.toContain(
        'private revoked policy',
      );
    }
    expect(remote.calls).toEqual([
      operation === 'send' ? 'SendMessage' : 'GetTask',
    ]);
  },
  30000,
);

it('captures reused encoder parts before awaiting host authorization', async () => {
  const remote = await peer();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const template = Part.fromJSON({
    text: 'initial',
    metadata: { input: 'initial' },
  });
  const provider = new A2AJobProvider<string>({
    endpoint: remote.endpoint,
    authorize: async (current) => {
      if (current.key === 'A') {
        entered.resolve();
        await release.promise;
      }
    },
    authorization: async () => 'synthetic',
    reserve: async () => {},
    encode: (input) => {
      template.content = { $case: 'text', value: input };
      template.metadata!.input = input;
      return [template];
    },
    project: (task) => ({
      text: task.history[0].parts[0].content?.value,
      metadata: task.history[0].parts[0].metadata,
    }),
  });
  const first = provider.start({ ...claim(), key: 'A' }, 'A', context);
  try {
    await entered.promise;
    const second = await provider.start({ ...claim(), key: 'B' }, 'B', context);
    release.resolve();
    expect(await first).toMatchObject({
      status: 'completed',
      value: { text: 'A', metadata: { input: 'A' } },
    });
    expect(second).toMatchObject({
      status: 'completed',
      value: { text: 'B', metadata: { input: 'B' } },
    });
  } finally {
    release.resolve();
    await first;
  }
});

it('captures reused projected JSON before concurrent starts return', async () => {
  const sent = new Set<string>();
  const remote = await peer({
    async execute(current, bus) {
      const text = current.userMessage.parts[0].content?.value as string;
      sent.add(text);
      bus.publish(
        AgentEvent.task({
          ...Task.fromJSON({}),
          id: current.taskId,
          contextId: current.contextId,
          history: [current.userMessage],
          status: {
            state: TaskState.TASK_STATE_COMPLETED,
            message: undefined,
            timestamp: undefined,
          },
        }),
      );
      bus.finished();
    },
    async cancelTask() {},
  });
  const release = Promise.withResolvers<void>();
  const waiting = new Set<string>();
  const returned = new Set<string>();
  const template = { nested: { text: '' } };
  const provider = new A2AJobProvider<string>({
    endpoint: remote.endpoint,
    authorize: async (current) => {
      if (sent.has(current.key)) {
        waiting.add(current.key);
        if (waiting.size === 2) release.resolve();
        await release.promise;
      }
    },
    authorization: async () => 'synthetic',
    reserve: async () => {},
    encode: (text) => [Part.fromJSON({ text })],
    project: (task) => {
      expect(returned.size).toBe(0);
      template.nested.text = task.history[0].parts[0].content?.value as string;
      return template;
    },
  });
  const starts = ['A', 'B'].map((key) =>
    provider.start({ ...claim(), key }, key, context).then((update) => {
      returned.add(key);
      return update;
    }),
  );
  try {
    expect(await Promise.all(starts)).toMatchObject([
      { status: 'completed', value: { nested: { text: 'A' } } },
      { status: 'completed', value: { nested: { text: 'B' } } },
    ]);
  } finally {
    release.resolve();
    await Promise.all(starts);
  }
});
