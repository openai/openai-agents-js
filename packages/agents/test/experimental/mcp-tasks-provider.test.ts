import { MCPInputReply } from '../../src/experimental/mcp-tasks/input-reply';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MCPTasksProvider,
  type MCPTasksProviderOptions,
} from '../../src/experimental/mcp-tasks/provider';

const input = { pages: 3 };
type Claim = Parameters<MCPTasksProvider<typeof input>['start']>[0];
type Update = Awaited<ReturnType<MCPTasksProvider<typeof input>['start']>>;
type Frame = {
  jsonrpc: string;
  id: string;
  method: string;
  params: Record<string, unknown>;
};
const context = () => ({ signal: new AbortController().signal });
const closePeers: Array<() => Promise<void>> = [];
const selected = {
  name: 'render',
  inputSchema: {
    type: 'object',
    properties: { pages: { type: 'integer' } },
    required: ['pages'],
  },
};
const discovery = {
  resultType: 'complete',
  supportedVersions: ['2026-07-28'],
  capabilities: {
    tools: {},
    extensions: { 'io.modelcontextprotocol/tasks': {} },
  },
};
const task = {
  taskId: 'private-task/雪',
  status: 'working',
  createdAt: '2026-11-01T00:00:00Z',
  lastUpdatedAt: '2026-11-01T00:00:00Z',
  ttlMs: 60_000,
  pollIntervalMs: 0,
};
const privateComplete = {
  resultType: 'complete',
  content: [{ type: 'text', text: 'private-peer-content' }],
  structuredContent: { private: 'private-peer-structure' },
  _meta: { canary: 'private-peer-meta' },
  isError: true,
};
function starting(): Claim {
  return {
    binding: {
      tenant: 'tenant',
      runId: 'run',
      providerId: 'render/v1',
      sessionId: 'session',
      turnId: 'turn',
      callId: 'original',
      toolName: 'render',
      requestDigest: createHash('sha256').update('{"pages":3}').digest('hex'),
      checkpointDigest: 'checkpoint-digest',
    },
    key: 'private-business-key',
    generation: 'generation-1',
    action: 'start',
  };
}
function observing(update: Update, initial = starting()): Claim {
  return { ...initial, action: 'observe', update, generation: 'generation-2' };
}
function listing(tools: unknown[] = [selected], nextCursor?: string) {
  return {
    resultType: 'complete',
    ttlMs: 0,
    cacheScope: 'private',
    tools,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}
function send(response: ServerResponse, id: string, result: unknown) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}
async function peer(
  overrides: Partial<
    Record<
      | 'server/discover'
      | 'tools/list'
      | 'tools/call'
      | 'tasks/get'
      | 'tasks/update'
      | 'tasks/cancel',
      (frame: Frame, response: ServerResponse) => void
    >
  > = {},
) {
  const frames: Frame[] = [];
  const errors: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      let data = '';
      for await (const chunk of request) data += String(chunk);
      const frame = JSON.parse(data) as Frame;
      frames.push(frame);
      if (request.method !== 'POST' || request.url !== '/mcp')
        throw new Error('Unexpected route');
      const custom = overrides[frame.method as keyof typeof overrides];
      if (custom) custom(frame, response);
      else if (frame.method === 'server/discover')
        send(response, frame.id, discovery);
      else if (frame.method === 'tools/list')
        send(response, frame.id, listing());
      else if (frame.method === 'tools/call')
        send(response, frame.id, { resultType: 'task', ...task });
      else if (frame.method === 'tasks/get')
        send(response, frame.id, { resultType: 'complete', ...task });
      else if (
        frame.method === 'tasks/update' ||
        frame.method === 'tasks/cancel'
      )
        send(response, frame.id, { resultType: 'complete' });
      else throw new Error('Unexpected method');
    } catch (error) {
      errors.push(error);
      response.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture address');
  closePeers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    expect(errors).toEqual([]);
  });
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    frames,
    count: (method: string) =>
      frames.filter((frame) => frame.method === method).length,
  };
}
function provider(
  endpoint: string,
  overrides: Partial<MCPTasksProviderOptions> = {},
) {
  return new MCPTasksProvider<typeof input>({
    endpoint,
    tool: 'render',
    fetch: globalThis.fetch,
    authorize: async () => 'synthetic-provider-token',
    timeoutMs: 2_000,
    admitPending: () => true,
    ...overrides,
  });
}
afterEach(async () => {
  await Promise.all(closePeers.splice(0).map((close) => close()));
});

describe('MCP Tasks provider creation and observation', () => {
  it('walks every list page before exactly one create and never polls during start', async () => {
    const server = await peer({
      'tools/list': (frame, response) =>
        send(
          response,
          frame.id,
          frame.params.cursor === undefined
            ? listing([selected], 'last')
            : listing([{ name: 'other', inputSchema: { type: 'object' } }]),
        ),
    });
    const admissions: unknown[][] = [];
    const result = await provider(server.endpoint, {
      admitPending: (...args) => {
        admissions.push(args);
        return true;
      },
    }).start(starting(), input, context());
    expect(result).toMatchObject({
      status: 'pending',
      receipt: expect.any(String),
      value: { pollAt: expect.any(Number) },
    });
    expect(server.frames.map((frame) => frame.method)).toEqual([
      'server/discover',
      'tools/list',
      'tools/list',
      'tools/call',
    ]);
    expect(server.frames.at(-1)?.params).toMatchObject({
      name: 'render',
      arguments: input,
    });
    expect(server.count('tasks/get')).toBe(0);
    expect(admissions).toHaveLength(1);
    expect(admissions[0].slice(1)).toEqual([task.taskId, null]);
    expect(provider(server.endpoint)).not.toHaveProperty('reconcileCreation');
  });

  it('rejects a changed normalized input digest before HTTP', async () => {
    const server = await peer();
    await expect(
      provider(server.endpoint).start(starting(), { pages: 4 }, context()),
    ).rejects.toMatchObject({ kind: 'authorization' });
    expect(server.frames).toEqual([]);
  });

  it('sanitizes strict deferred input rejection before HTTP', async () => {
    const server = await peer();
    const initial = starting();
    const claim = {
      ...initial,
      binding: {
        ...initial.binding,
        requestDigest: createHash('sha256').update('{"pages":0}').digest('hex'),
      },
    };
    await expect(
      provider(server.endpoint).start(claim, { pages: -0 }, context()),
    ).rejects.toMatchObject({ kind: 'authorization' });
    expect(server.frames).toEqual([]);
  });

  for (const invalid of [
    'missing',
    'duplicate same page',
    'duplicate later page',
    'repeated cursor',
    'unending pages',
    'malformed listing',
  ] as const) {
    it(`refuses ${invalid} declarations before creation`, async () => {
      let pages = 0;
      const server = await peer({
        'tools/list': (frame, response) => {
          pages++;
          const result =
            invalid === 'missing'
              ? listing([])
              : invalid === 'duplicate same page'
                ? listing([selected, selected])
                : invalid === 'duplicate later page'
                  ? listing([selected], pages === 1 ? 'second' : undefined)
                  : invalid === 'repeated cursor'
                    ? listing(pages === 1 ? [selected] : [], 'same-cursor')
                    : invalid === 'unending pages'
                      ? listing(pages === 1 ? [selected] : [], `page-${pages}`)
                      : { ...listing(), ttlMs: -1 };
          send(response, frame.id, result);
        },
      });
      await expect(
        provider(server.endpoint).start(starting(), input, context()),
      ).rejects.toMatchObject({ kind: 'unsupported' });
      expect(server.count('tools/call')).toBe(0);
      expect(server.count('tools/list')).toBeLessThanOrEqual(32);
      if (invalid === 'unending pages')
        expect(server.count('tools/list')).toBe(32);
    });
  }

  for (const invalid of ['legacy revision', 'missing extension'] as const) {
    it(`rejects ${invalid} discovery without listing or create`, async () => {
      const server = await peer({
        'server/discover': (frame, response) =>
          send(
            response,
            frame.id,
            invalid === 'legacy revision'
              ? { ...discovery, supportedVersions: ['2025-11-25'] }
              : { ...discovery, capabilities: { tools: {} } },
          ),
      });
      await expect(
        provider(server.endpoint).start(starting(), input, context()),
      ).rejects.toMatchObject({ kind: 'unsupported' });
      expect(server.frames.map((frame) => frame.method)).toEqual([
        'server/discover',
      ]);
    });
  }

  it('does not execute peer output schemas or compile unrelated references', async () => {
    const server = await peer({
      'tools/list': (frame, response) =>
        send(
          response,
          frame.id,
          listing([
            {
              name: 'unrelated',
              inputSchema: { type: 'object' },
              outputSchema: { $ref: 'https://peer-schema.invalid/never-fetch' },
            },
            {
              ...selected,
              outputSchema: {
                type: 'object',
                properties: { value: { pattern: '[' } },
                required: ['not-returned'],
              },
            },
          ]),
        ),
      'tools/call': (frame, response) =>
        send(response, frame.id, privateComplete),
    });
    expect(
      await provider(server.endpoint).start(starting(), input, context()),
    ).toEqual({ status: 'completed', value: { content: [], isError: true } });
    expect(server.count('tools/call')).toBe(1);
  });

  for (const exclusion of [
    'selected reference',
    'header-bearing argument',
    'invalid absent header declaration',
  ] as const) {
    it(`refuses ${exclusion} before tools/call`, async () => {
      const declaration =
        exclusion === 'selected reference'
          ? {
              ...selected,
              outputSchema: {
                properties: {
                  value: { $ref: 'https://schema.invalid/private' },
                },
              },
            }
          : {
              ...selected,
              inputSchema: {
                type: 'object',
                properties:
                  exclusion === 'header-bearing argument'
                    ? { pages: { type: 'integer', 'x-mcp-header': 'X-Route' } }
                    : {
                        absent: {
                          type: 'string',
                          'x-mcp-header': 'bad header',
                        },
                      },
              },
            };
      const server = await peer({
        'tools/list': (frame, response) =>
          send(response, frame.id, listing([declaration])),
      });
      await expect(
        provider(server.endpoint).start(starting(), input, context()),
      ).rejects.toMatchObject({ kind: 'unsupported' });
      expect(server.count('tools/call')).toBe(0);
    });
  }

  for (const admission of ['missing', 'false', 'throws'] as const) {
    it(`keeps task creation unknown with no receipt when pending admission ${admission}`, async () => {
      const server = await peer();
      const admitPending =
        admission === 'missing'
          ? undefined
          : admission === 'false'
            ? () => false
            : () => {
                throw new Error('synthetic-private-admission-cause');
              };
      const update = await provider(server.endpoint, { admitPending }).start(
        starting(),
        input,
        context(),
      );
      expect(update).toEqual({ status: 'unknown' });
      expect(server.count('tools/call')).toBe(1);
      expect(server.count('tasks/get')).toBe(0);
      expect(inspect(update, { depth: null })).not.toContain(
        'synthetic-private-admission-cause',
      );
    });
  }

  for (const raw of [
    { resultType: 'task', ...task, ttlMs: false, content: [] },
    { resultType: 'input_required', requestState: 'private-state' },
  ]) {
    it(`does not replay uncertain creation with raw result ${raw.resultType}`, async () => {
      const server = await peer({
        'tools/call': (frame, response) => send(response, frame.id, raw),
      });
      expect(
        await provider(server.endpoint).start(starting(), input, context()),
      ).toEqual({ status: 'unknown' });
      expect(server.count('tools/call')).toBe(1);
      expect(server.count('tasks/get')).toBe(0);
    });
  }

  it('withholds all peer completed content by default even when isError is true', async () => {
    const server = await peer({
      'tools/call': (frame, response) =>
        send(response, frame.id, privateComplete),
    });
    const result = await provider(server.endpoint).start(
      starting(),
      input,
      context(),
    );
    expect(result).toEqual({
      status: 'completed',
      value: { content: [], isError: true },
    });
    expect(JSON.stringify(result)).not.toMatch(/private-peer/);
  });

  it('captures only the finite JSON returned by result admission', async () => {
    const server = await peer({
      'tools/call': (frame, response) =>
        send(response, frame.id, privateComplete),
    });
    const admitted = { report: { pages: [3] } };
    let supplied: unknown;
    const result = await provider(server.endpoint, {
      admitResult: (_claim, raw) => {
        supplied = raw;
        return admitted;
      },
    }).start(starting(), input, context());
    expect(supplied).toEqual(privateComplete);
    admitted.report.pages.push(99);
    expect(result).toEqual({
      status: 'completed',
      value: {
        content: [],
        isError: true,
        structuredContent: { report: { pages: [3] } },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/private-peer/);
  });

  for (const invalid of ['nonfinite', 'cyclic', 'callback failure'] as const) {
    it(`fails closed for ${invalid} result admission without peer output`, async () => {
      const server = await peer({
        'tools/call': (frame, response) =>
          send(response, frame.id, privateComplete),
      });
      const cyclic: { self?: unknown } = {};
      cyclic.self = cyclic;
      const admitResult = () => {
        if (invalid === 'callback failure')
          throw new Error('private-admission-error');
        return invalid === 'nonfinite' ? { value: Infinity } : cyclic;
      };
      expect(
        await provider(server.endpoint, { admitResult }).start(
          starting(),
          input,
          context(),
        ),
      ).toEqual({ status: 'failed' });
      expect(server.count('tools/call')).toBe(1);
    });
  }

  it('authorizes an early wake without HTTP and returns detached saved polling data', async () => {
    const server = await peer({
      'tools/call': (frame, response) =>
        send(response, frame.id, {
          resultType: 'task',
          ...task,
          pollIntervalMs: 60_000,
        }),
    });
    const authorizations: string[] = [];
    const adapter = provider(server.endpoint, {
      authorize: async (_claim, action) => {
        authorizations.push(action);
        return 'synthetic-observe-token';
      },
    });
    const before = Date.now();
    const pending = await adapter.start(starting(), input, context());
    const after = Date.now();
    const deadline = (pending.value as { pollAt: number }).pollAt;
    expect(deadline).toBeGreaterThanOrEqual(before + 60_000);
    expect(deadline).toBeLessThanOrEqual(after + 60_000);
    const count = server.frames.length;
    const authCount = authorizations.length;
    const observed = await adapter.observe(observing(pending), context());
    expect(observed).toEqual(pending);
    expect(observed).not.toBe(pending);
    expect(observed.value).not.toBe(pending.value);
    expect(authorizations.slice(authCount)).toEqual(['observe']);
    expect(server.frames).toHaveLength(count);
  });

  it('waits until a short post-start poll deadline and observes exactly once', async () => {
    let observedAt = 0;
    const server = await peer({
      'tools/call': (frame, response) =>
        send(response, frame.id, {
          resultType: 'task',
          ...task,
          pollIntervalMs: 100,
        }),
      'tasks/get': (frame, response) => {
        observedAt = Date.now();
        send(response, frame.id, {
          resultType: 'complete',
          ...task,
          status: 'completed',
          result: privateComplete,
        });
      },
    });
    const adapter = provider(server.endpoint);
    const initial = starting();
    const pending = await adapter.start(initial, input, context());
    const deadline = (pending.value as { pollAt: number }).pollAt;
    const result = await adapter.observe(
      { ...initial, update: pending },
      context(),
    );
    expect(observedAt).toBeGreaterThanOrEqual(deadline);
    expect(result).toEqual({
      status: 'completed',
      receipt: pending.receipt,
      value: { content: [], isError: true },
    });
    expect(server.count('tasks/get')).toBe(1);
    expect(server.count('tools/call')).toBe(1);
    expect(server.frames.map((frame) => frame.method)).toEqual([
      'server/discover',
      'tools/list',
      'tools/call',
      'server/discover',
      'tasks/get',
    ]);
  });

  it('returns a detached post-start update without HTTP when polling exceeds its budget', async () => {
    const server = await peer({
      'tools/call': (frame, response) =>
        send(response, frame.id, {
          resultType: 'task',
          ...task,
          pollIntervalMs: 60_000,
        }),
    });
    const authorizations: string[] = [];
    const adapter = provider(server.endpoint, {
      timeoutMs: 500,
      authorize: async (_claim, action) => {
        authorizations.push(action);
        return 'synthetic-post-start-token';
      },
    });
    const initial = starting();
    const pending = await adapter.start(initial, input, context());
    const frames = server.frames.length;
    const authorized = authorizations.length;
    const result = await adapter.observe(
      { ...initial, update: pending },
      context(),
    );
    expect(result).toEqual(pending);
    expect(result).not.toBe(pending);
    expect(result.value).not.toBe(pending.value);
    expect(server.frames).toHaveLength(frames);
    expect(authorizations.slice(authorized)).toEqual(['observe']);
    expect(server.count('tasks/get')).toBe(0);
    expect(server.count('tools/call')).toBe(1);
  });

  for (const field of [
    'tenant',
    'runId',
    'providerId',
    'sessionId',
    'turnId',
    'callId',
    'toolName',
    'requestDigest',
    'checkpointDigest',
    'key',
    'endpoint',
    'tool',
  ] as const) {
    it(`rejects a receipt transplanted to another ${field} before task dispatch`, async () => {
      const server = await peer();
      const pending = await provider(server.endpoint).start(
        starting(),
        input,
        context(),
      );
      let claim = observing(pending);
      if (field === 'key') claim = { ...claim, key: 'another-key' };
      else if (field !== 'endpoint' && field !== 'tool')
        claim = {
          ...claim,
          binding: { ...claim.binding, [field]: 'different-binding' },
        };
      const adapter = provider(
        field === 'endpoint' ? `${server.endpoint}/other` : server.endpoint,
        field === 'tool' ? { tool: 'different-tool' } : {},
      );
      await expect(adapter.observe(claim, context())).rejects.toMatchObject({
        kind: 'authorization',
      });
      expect(server.count('tools/call')).toBe(1);
      expect(server.count('tasks/get')).toBe(0);
    });
  }

  for (const truth of [
    'wrong task ID',
    'malformed',
    'expired',
    'unavailable',
    'completed without result',
  ] as const) {
    it(`preserves the receipt as unknown for ${truth} task truth`, async () => {
      const server = await peer({
        'tasks/get': (frame, response) => {
          if (truth === 'expired') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: frame.id,
                error: { code: -32602, message: 'private-expired-task' },
              }),
            );
          } else if (truth === 'unavailable')
            response
              .writeHead(503, { 'Content-Type': 'application/json' })
              .end('{"private":"unavailable"}');
          else
            send(response, frame.id, {
              resultType: 'complete',
              ...task,
              ...(truth === 'wrong task ID'
                ? { taskId: 'another-task' }
                : truth === 'malformed'
                  ? { ttlMs: false }
                  : { status: 'completed' }),
            });
        },
      });
      const adapter = provider(server.endpoint);
      const pending = await adapter.start(starting(), input, context());
      const result = await adapter.observe(observing(pending), context());
      expect(result).toMatchObject({
        status: 'unknown',
        receipt: pending.receipt,
      });
      expect(JSON.stringify(result)).not.toMatch(
        /another-task|private-expired-task|unavailable/,
      );
      expect(server.count('tools/call')).toBe(1);
      expect(server.count('tasks/get')).toBe(1);
      expect(server.frames.at(-1)?.params.taskId).toBe(task.taskId);
    });
  }

  for (const status of [
    'working',
    'cancelled',
    'failed',
    'completed',
  ] as const) {
    it(`records actual ${status} truth from one exact tasks/get`, async () => {
      const server = await peer({
        'tasks/get': (frame, response) =>
          send(response, frame.id, {
            resultType: 'complete',
            ...task,
            status,
            ...(status === 'completed' ? { result: privateComplete } : {}),
          }),
      });
      const adapter = provider(server.endpoint);
      const pending = await adapter.start(starting(), input, context());
      const result = await adapter.observe(observing(pending), context());
      expect(result.status).toBe(status === 'working' ? 'pending' : status);
      expect(result.receipt).toBe(pending.receipt);
      if (status === 'completed')
        expect(result.value).toEqual({ content: [], isError: true });
      expect(server.count('tools/call')).toBe(1);
      expect(server.count('tasks/get')).toBe(1);
      expect(server.frames.at(-1)?.params.taskId).toBe(task.taskId);
    });
  }

  it('admits a complete canonical private form and returns detached requests with its challenge', async () => {
    const requests = {
      approval: {
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message: 'private-form-prompt',
          requestedSchema: {
            type: 'object',
            properties: { accept: { type: 'boolean' } },
            required: ['accept'],
          },
        },
      },
    };
    const server = await peer({
      'tasks/get': (frame, response) =>
        send(response, frame.id, {
          resultType: 'complete',
          ...task,
          status: 'input_required',
          pollIntervalMs: 60_000,
          inputRequests: requests,
        }),
    });
    const admitted: Array<string | null> = [];
    const adapter = provider(server.endpoint, {
      admitPending: (_claim, id, encoded) => {
        expect(id).toBe(task.taskId);
        admitted.push(encoded);
        return true;
      },
    });
    const pending = await adapter.start(starting(), input, context());
    const form = await adapter.observe(observing(pending), context());
    expect(form).toMatchObject({
      status: 'inputRequired',
      receipt: pending.receipt,
      value: {
        requests,
        pollAt: expect.any(Number),
        challenge: expect.any(String),
      },
    });
    expect(admitted[0]).toBeNull();
    expect(JSON.parse(admitted[1]!)).toEqual(requests);
    const count = server.frames.length;
    const cached = await adapter.observe(observing(form), context());
    expect(cached).toEqual(form);
    expect(cached.value).not.toBe(form.value);
    expect((cached.value as { requests: unknown }).requests).not.toBe(
      (form.value as { requests: unknown }).requests,
    );
    expect(server.frames).toHaveLength(count);
  });
});

it('keeps private form challenges stable across wire negative zero and journal JSON', async () => {
  let negativeZero = true;
  const server = await peer({
    'tasks/get': (frame, response) => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: frame.id,
        result: {
          resultType: 'complete',
          ...task,
          status: 'input_required',
          inputRequests: {
            approval: formRequest('Approve amount', {
              type: 'object',
              properties: { amount: { type: 'number', default: 0 } },
              required: ['amount'],
            }),
          },
        },
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        negativeZero ? body.replace('"default":0', '"default":-0') : body,
      );
    },
  });
  const adapter = provider(server.endpoint);
  const pending = await adapter.start(starting(), input, context());
  const first = await adapter.observe(observing(pending), context());
  expect(first.status).toBe('inputRequired');
  negativeZero = false;
  const restored = JSON.parse(JSON.stringify(first)) as Update;
  const second = await adapter.observe(observing(restored), context());
  expect(second.status).toBe('inputRequired');
  expect((second.value as { challenge: string }).challenge).toBe(
    (first.value as { challenge: string }).challenge,
  );
});

const flatSchema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
};
function formRequest(
  message = 'private-form-question',
  schema: unknown = flatSchema,
) {
  return {
    method: 'elicitation/create',
    params: { mode: 'form', message, requestedSchema: schema },
  };
}
async function formFixture(
  config: {
    options?: Partial<MCPTasksProviderOptions>;
    requests?: Record<string, unknown>;
    taskId?: string;
    mutation?: (frame: Frame, response: ServerResponse) => void;
  } = {},
) {
  const taskId = config.taskId ?? task.taskId;
  let detail: unknown = {
    resultType: 'complete',
    ...task,
    taskId,
    status: 'input_required',
    pollIntervalMs: 60_000,
    inputRequests: config.requests ?? {
      first: formRequest(),
      second: formRequest('other private question'),
    },
  };
  const server = await peer({
    'tools/call': (frame, response) =>
      send(response, frame.id, { resultType: 'task', ...task, taskId }),
    'tasks/get': (frame, response) => send(response, frame.id, detail),
    ...(config.mutation
      ? { 'tasks/update': config.mutation, 'tasks/cancel': config.mutation }
      : {}),
  });
  const reservations: Array<MCPInputReply | null> = [];
  const settings: Partial<MCPTasksProviderOptions> = {
    allowInputReplies: true,
    reserveMutation: async (_claim, reply) => {
      reservations.push(reply);
      return true;
    },
    ...config.options,
  };
  const adapter = provider(server.endpoint, settings);
  const pending = await adapter.start(starting(), input, context());
  const form = await adapter.observe(observing(pending), context());
  expect(form.status).toBe('inputRequired');
  const control = (action: 'respond' | 'cancel'): Claim => ({
    ...observing(form),
    action,
  });
  const reply = (
    responses = {
      first: {
        action: 'accept' as const,
        content: { answer: 'host-approved' },
      },
    },
  ) =>
    new MCPInputReply({
      challenge: (form.value as { challenge: string }).challenge,
      responses,
    });
  return {
    server,
    adapter,
    form,
    pending,
    reservations,
    settings,
    control,
    reply,
    setDetail: (value: unknown) => {
      detail = value;
    },
  };
}

describe('MCP Tasks host-approved input and cancellation', () => {
  for (const missing of ['disabled replies', 'missing reservation'] as const) {
    it(`denies ${missing} before a mutation or fresh task read`, async () => {
      const f = await formFixture({
        options:
          missing === 'disabled replies'
            ? { allowInputReplies: false }
            : { reserveMutation: undefined },
      });
      const count = f.server.frames.length;
      await expect(
        f.adapter.respond(f.control('respond'), f.reply(), context()),
      ).rejects.toMatchObject({ kind: 'authorization' });
      expect(f.server.frames).toHaveLength(count);
      expect(f.reservations).toEqual([]);
      expect(f.server.count('tasks/update')).toBe(0);
      if (missing === 'missing reservation')
        await expect(
          f.adapter.cancel(f.control('cancel'), context()),
        ).rejects.toMatchObject({ kind: 'authorization' });
    });
  }

  for (const invalid of [
    'wrong challenge',
    'unknown request key',
    'extra answer',
    'missing required answer',
  ] as const) {
    it(`refuses ${invalid} without reserving or sending an answer`, async () => {
      const f = await formFixture();
      const response =
        invalid === 'wrong challenge'
          ? new MCPInputReply({
              challenge: 'foreign-challenge',
              responses: { first: { action: 'decline' } },
            })
          : invalid === 'unknown request key'
            ? new MCPInputReply({
                challenge: (f.form.value as { challenge: string }).challenge,
                responses: { foreign: { action: 'decline' } },
              })
            : new MCPInputReply({
                challenge: (f.form.value as { challenge: string }).challenge,
                responses: {
                  first: {
                    action: 'accept',
                    content:
                      invalid === 'extra answer'
                        ? { answer: 'approved', extra: 'refused' }
                        : {},
                  },
                },
              });
      const outcome = await f.adapter
        .respond(f.control('respond'), response, context())
        .catch((error) => error);
      expect(outcome.status === 'unknown' || outcome instanceof Error).toBe(
        true,
      );
      expect(f.reservations).toEqual([]);
      expect(f.server.count('tasks/update')).toBe(0);
    });
  }

  for (const action of ['accept', 'decline', 'cancel'] as const) {
    it(`sends only the selected immutable request key for form action ${action}`, async () => {
      const f = await formFixture();
      const answer =
        action === 'accept'
          ? { action, content: { answer: 'host-approved' } }
          : { action };
      const response = new MCPInputReply({
        challenge: (f.form.value as { challenge: string }).challenge,
        responses: { first: answer },
      });
      const count = f.server.count('tasks/get');
      const result = await f.adapter.respond(
        f.control('respond'),
        response,
        context(),
      );
      expect(result).toMatchObject({
        status: 'pending',
        receipt: f.form.receipt,
        value: { pollAt: expect.any(Number) },
      });
      expect(f.server.count('tasks/get')).toBe(count + 1);
      expect(f.server.count('tasks/update')).toBe(1);
      expect(f.server.count('tasks/cancel')).toBe(0);
      expect(f.server.frames.at(-1)?.params).toMatchObject({
        taskId: task.taskId,
        inputResponses: { first: answer },
      });
      expect(f.server.frames.at(-1)?.params.inputResponses).not.toHaveProperty(
        'second',
      );
      expect(f.reservations).toHaveLength(1);
      expect(f.reservations[0]).toBe(response);
    });
  }

  it('projects a structurally typed decline response to action without private extra fields', async () => {
    const f = await formFixture();
    const response = {
      action: 'decline' as const,
      debug: f.control('respond').key,
      privateMetadata: { canary: 'host-private-response-extra' },
    };
    const reply = new MCPInputReply({
      challenge: (f.form.value as { challenge: string }).challenge,
      responses: { first: response },
    });
    const result = await f.adapter.respond(
      f.control('respond'),
      reply,
      context(),
    );
    expect(result.status).toBe('pending');
    expect(f.server.count('tasks/update')).toBe(1);
    expect(f.server.frames.at(-1)?.params.inputResponses).toEqual({
      first: { action: 'decline' },
    });
    expect(JSON.stringify(f.server.frames.at(-1))).not.toContain(
      response.debug,
    );
    expect(JSON.stringify(f.server.frames.at(-1))).not.toContain(
      'host-private-response-extra',
    );
  });

  for (const changed of [
    'new form',
    'completed',
    'failed',
    'cancelled',
  ] as const) {
    it(`returns fresh ${changed} truth without spending the obsolete reply`, async () => {
      const f = await formFixture();
      f.setDetail({
        resultType: 'complete',
        ...task,
        status: changed === 'new form' ? 'input_required' : changed,
        ...(changed === 'new form'
          ? {
              inputRequests: {
                replacement: formRequest('new immutable request'),
              },
              lastUpdatedAt: '2026-11-01T00:00:01Z',
            }
          : {}),
        ...(changed === 'completed' ? { result: privateComplete } : {}),
      });
      const result = await f.adapter.respond(
        f.control('respond'),
        f.reply(),
        context(),
      );
      expect(result.status).toBe(
        changed === 'new form' ? 'inputRequired' : changed,
      );
      expect(result.receipt).toBe(f.form.receipt);
      if (changed === 'new form')
        expect((result.value as { challenge: string }).challenge).not.toBe(
          (f.form.value as { challenge: string }).challenge,
        );
      expect(f.reservations).toEqual([]);
      expect(f.server.count('tasks/update')).toBe(0);
    });
  }

  for (const constraint of [
    'pattern',
    'nested object',
    'reference',
    'combinator',
  ] as const) {
    it(`does not execute or reserve a form with unsupported ${constraint}`, async () => {
      const schema =
        constraint === 'pattern'
          ? {
              ...flatSchema,
              properties: { answer: { type: 'string', pattern: '[' } },
            }
          : constraint === 'nested object'
            ? {
                ...flatSchema,
                properties: {
                  answer: {
                    type: 'object',
                    properties: { nested: { type: 'string' } },
                  },
                },
              }
            : constraint === 'reference'
              ? {
                  ...flatSchema,
                  properties: {
                    answer: { $ref: 'https://schema.invalid/private' },
                  },
                }
              : {
                  ...flatSchema,
                  oneOf: [{ properties: { answer: { const: 'untrusted' } } }],
                };
      // Core already refuses nested/reference field shapes on observation.
      // Start from a real accepted form, then test that fresh unsupported truth
      // still cannot reach the reservation callback or a mutation.
      const rejectedOnRead =
        constraint === 'nested object' || constraint === 'reference';
      const f = await formFixture({
        requests: {
          first: formRequest(
            'private prompt',
            rejectedOnRead ? flatSchema : schema,
          ),
        },
      });
      if (rejectedOnRead)
        f.setDetail({
          resultType: 'complete',
          ...task,
          status: 'input_required',
          inputRequests: { first: formRequest('private prompt', schema) },
        });
      const outcome = await f.adapter
        .respond(f.control('respond'), f.reply(), context())
        .catch((error) => error);
      expect(outcome.status === 'unknown' || outcome instanceof Error).toBe(
        true,
      );
      expect(f.reservations).toEqual([]);
      expect(f.server.count('tasks/update')).toBe(0);
    });
  }

  for (const reflected of [
    'prompt',
    'schema',
    'taskId',
    'requestKey',
    'answer',
  ] as const) {
    it(`refuses final rotated credential reflection in ${reflected} before reservation`, async () => {
      const token = 'synthetic-final-rotation-token';
      const key = reflected === 'requestKey' ? token : 'first';
      const requests = {
        [key]: formRequest(
          reflected === 'prompt' ? `approve ${token}` : 'private prompt',
          reflected === 'schema'
            ? {
                ...flatSchema,
                properties: { answer: { type: 'string', description: token } },
              }
            : flatSchema,
        ),
      };
      let respondTokens = 0;
      const f = await formFixture({
        requests,
        taskId: reflected === 'taskId' ? `private-${token}` : undefined,
        options: {
          authorize: async (_claim, action) =>
            action === 'respond' && ++respondTokens === 4
              ? token
              : `synthetic-safe-${action}-${respondTokens}`,
        },
      });
      const reply = new MCPInputReply({
        challenge: (f.form.value as { challenge: string }).challenge,
        responses: {
          [key]: {
            action: 'accept',
            content: { answer: reflected === 'answer' ? token : 'approved' },
          },
        },
      });
      const error = await f.adapter
        .respond(f.control('respond'), reply, context())
        .catch((error) => error);
      expect(error).toMatchObject({ kind: 'authorization' });
      expect(respondTokens).toBe(4);
      expect(f.reservations).toEqual([]);
      expect(f.server.count('tasks/update')).toBe(0);
      expect(inspect(error, { depth: null })).not.toContain(token);
    });
  }

  it('denies revoked current authorization before reservation and mutation', async () => {
    let respondTokens = 0;
    const f = await formFixture({
      options: {
        authorize: async (_claim, action) => {
          if (action === 'respond' && ++respondTokens === 4)
            throw new Error('private-revoked-principal');
          return 'synthetic-current-token';
        },
      },
    });
    const error = await f.adapter
      .respond(f.control('respond'), f.reply(), context())
      .catch((error) => error);
    expect(error).toMatchObject({ kind: 'authorization' });
    expect(f.reservations).toEqual([]);
    expect(f.server.count('tasks/update')).toBe(0);
    expect(inspect(error, { depth: null })).not.toContain(
      'private-revoked-principal',
    );
  });

  it('submits one overlapping answer when the host atomically reserves all selected keys', async () => {
    // This state models only the host callback contract, not durable journal recovery.
    const spent = new Set<string>();
    const candidates: string[][] = [];
    const f = await formFixture({
      options: {
        reserveMutation: async (_claim, reply) => {
          const keys = Object.keys(reply!.responses).sort();
          candidates.push(keys);
          if (keys.some((key) => spent.has(key))) return false;
          for (const key of keys) spent.add(key);
          return true;
        },
      },
    });
    const response = new MCPInputReply({
      challenge: (f.form.value as { challenge: string }).challenge,
      responses: { first: { action: 'decline' }, second: { action: 'cancel' } },
    });
    const results = await Promise.allSettled([
      f.adapter.respond(f.control('respond'), response, context()),
      f.adapter.respond(f.control('respond'), response, context()),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(candidates).toEqual([
      ['first', 'second'],
      ['first', 'second'],
    ]);
    expect([...spent].sort()).toEqual(['first', 'second']);
    expect(f.server.count('tasks/update')).toBe(1);
  });

  it('keeps a lost mutation acknowledgment unknown and its host reservation spent across provider instances', async () => {
    let spent = false;
    let attempts = 0;
    const f = await formFixture({
      mutation: (_frame, response) => response.destroy(),
      options: {
        reserveMutation: async () => {
          attempts++;
          if (spent) return false;
          spent = true;
          return true;
        },
      },
    });
    const result = await f.adapter.respond(
      f.control('respond'),
      f.reply(),
      context(),
    );
    expect(result).toMatchObject({
      status: 'unknown',
      receipt: f.form.receipt,
      value: { pollAt: expect.any(Number) },
    });
    expect(spent).toBe(true);
    expect(f.server.count('tasks/update')).toBe(1);
    const fresh = provider(f.server.endpoint, f.settings);
    await expect(
      fresh.respond(
        { ...f.control('respond'), generation: 'generation-3' },
        f.reply(),
        context(),
      ),
    ).rejects.toMatchObject({ kind: 'authorization' });
    expect(attempts).toBe(2);
    expect(spent).toBe(true);
    expect(f.server.count('tasks/update')).toBe(1);
  });

  it('keeps a lost cancellation acknowledgment unknown and its single reservation spent across provider instances', async () => {
    let spent = false;
    const reservations: Array<MCPInputReply | null> = [];
    const f = await formFixture({
      mutation: (_frame, response) => response.destroy(),
      options: {
        reserveMutation: async (_claim, reply) => {
          reservations.push(reply);
          if (spent) return false;
          spent = true;
          return true;
        },
      },
    });
    const result = await f.adapter.cancel(f.control('cancel'), context());
    expect(result).toMatchObject({
      status: 'unknown',
      receipt: f.form.receipt,
      value: { pollAt: expect.any(Number) },
    });
    expect(spent).toBe(true);
    expect(reservations).toEqual([null]);
    expect(f.server.count('tasks/cancel')).toBe(1);
    const fresh = provider(f.server.endpoint, f.settings);
    await expect(
      fresh.cancel(
        {
          ...f.control('cancel'),
          generation: 'generation-3',
        },
        context(),
      ),
    ).rejects.toMatchObject({ kind: 'authorization' });
    expect(spent).toBe(true);
    expect(reservations).toEqual([null, null]);
    expect(f.server.count('tasks/cancel')).toBe(1);
    expect(f.server.count('tasks/update')).toBe(0);
    expect(f.server.count('tools/call')).toBe(1);
  });

  it('rechecks live truth before cancellation and treats its acknowledgment as pending', async () => {
    const f = await formFixture();
    const gets = f.server.count('tasks/get');
    const result = await f.adapter.cancel(f.control('cancel'), context());
    expect(result).toMatchObject({
      status: 'pending',
      receipt: f.form.receipt,
      value: { pollAt: expect.any(Number) },
    });
    expect(f.server.count('tasks/get')).toBe(gets + 1);
    expect(f.server.count('tasks/cancel')).toBe(1);
    expect(f.reservations).toEqual([null]);
  });

  for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
    it(`does not cancel or reserve a task already ${terminal}`, async () => {
      const f = await formFixture();
      f.setDetail({
        resultType: 'complete',
        ...task,
        status: terminal,
        ...(terminal === 'completed' ? { result: privateComplete } : {}),
      });
      const result = await f.adapter.cancel(f.control('cancel'), context());
      expect(result.status).toBe(terminal);
      expect(f.reservations).toEqual([]);
      expect(f.server.count('tasks/cancel')).toBe(0);
    });
  }

  it('retains unknown truth without issuing a cancellation or HTTP poll', async () => {
    const f = await formFixture();
    const before = f.server.frames.length;
    const unknown: Update = {
      status: 'unknown',
      receipt: f.form.receipt,
      value: { pollAt: 0 },
    };
    expect(
      await f.adapter.cancel(
        { ...f.control('cancel'), update: unknown },
        context(),
      ),
    ).toEqual(unknown);
    expect(f.server.frames).toHaveLength(before);
    expect(f.reservations).toEqual([]);
  });

  it('never turns a caller-aborted observation into remote cancellation', async () => {
    const arrived = Promise.withResolvers<void>();
    let hold = false;
    const server = await peer({
      'tasks/get': (frame, response) => {
        if (!hold)
          send(response, frame.id, { resultType: 'complete', ...task });
        else {
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.flushHeaders();
          response.write(': waiting\n\n');
          arrived.resolve();
        }
      },
    });
    const reservations: unknown[] = [];
    const adapter = provider(server.endpoint, {
      reserveMutation: async (...args) => {
        reservations.push(args);
        return true;
      },
    });
    const pending = await adapter.start(starting(), input, context());
    hold = true;
    const abort = new AbortController();
    const running = adapter.observe(observing(pending), {
      signal: abort.signal,
    });
    const rejected = expect(running).rejects.toMatchObject({
      kind: 'interrupted',
    });
    await arrived.promise;
    abort.abort();
    await rejected;
    expect(reservations).toEqual([]);
    expect(server.count('tasks/cancel')).toBe(0);
    expect(server.count('tools/call')).toBe(1);
  });
});
