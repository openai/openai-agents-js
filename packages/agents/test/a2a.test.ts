import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
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
        fetch: async () => response,
      }),
    ).rejects.toThrow('A2A');
  }
  expect(credentials).toBe(0);
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
