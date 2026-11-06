import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ThumbnailStore } from '../../../../examples/codex/external-job-store';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

const ORIGINAL_CALL = 'original-thumbnail-call';
const RESULT_BYTES = '{"byteCount":3085}';
const TENANT = 'local-mcp-studio';
const TRUSTED_REQUESTS = {
  approval: {
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: 'Approve this one blue thumbnail.',
      requestedSchema: {
        type: 'object',
        properties: { approved: { type: 'boolean' } },
        required: ['approved'],
      },
    },
  },
};
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  try {
    await ModelServer.closeAll();
  } finally {
    await Promise.all(cleanup.splice(0).map((close) => close()));
  }
});

async function taskPeer(
  loseCreation = false,
  lostMutation?: 'respond' | 'cancel',
) {
  const frames: JsonObject[] = [];
  const effects: Array<{ taskId: string; arguments: unknown }> = [];
  const failures: unknown[] = [];
  let completed = false;
  let inputRequired = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/mcp')
        throw new Error('Unexpected Tasks request route');
      if (request.headers.authorization !== 'Bearer local-only')
        throw new Error('Missing fresh host authorization.');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const frame = JSON.parse(Buffer.concat(chunks).toString()) as JsonObject;
      frames.push(frame);
      const params = frame.params as JsonObject;
      let result: JsonObject;
      if (frame.method === 'server/discover')
        result = {
          resultType: 'complete',
          supportedVersions: ['2026-07-28'],
          capabilities: {
            tools: {},
            extensions: { 'io.modelcontextprotocol/tasks': {} },
          },
        };
      else if (frame.method === 'tools/list')
        result = {
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private',
          tools: [
            {
              name: 'render_thumbnail',
              inputSchema: {
                type: 'object',
                properties: {
                  color: { type: 'string', enum: ['red', 'blue'] },
                },
                required: ['color'],
                additionalProperties: false,
              },
            },
          ],
        };
      else if (frame.method === 'tools/call') {
        if (params.name !== 'render_thumbnail')
          throw new Error('Unexpected selected tool');
        const taskId = randomUUID();
        effects.push({ taskId, arguments: params.arguments });
        if (loseCreation) {
          response.destroy();
          return;
        }
        result = { resultType: 'task', ...taskFields(taskId, 'working') };
      } else if (frame.method === 'tasks/get') {
        const effect = effects.find(
          (effect) => effect.taskId === params.taskId,
        );
        if (!effect) throw new Error('Unissued task ID');
        result = {
          resultType: 'complete',
          ...taskFields(
            effect.taskId,
            completed
              ? 'completed'
              : inputRequired
                ? 'input_required'
                : 'working',
          ),
          ...(inputRequired && !completed
            ? { inputRequests: TRUSTED_REQUESTS }
            : {}),
          ...(completed
            ? {
                result: {
                  resultType: 'complete',
                  content: [
                    { type: 'text', text: 'private-thumbnail-diagnostics' },
                  ],
                  structuredContent: {
                    byteCount: 3085,
                    internalPath: '/private/target-thumbnail',
                    rawImage: 'private-image-data',
                  },
                  _meta: { private: 'private-peer-metadata' },
                },
              }
            : {}),
        };
      } else if (
        (lostMutation === 'respond' && frame.method === 'tasks/update') ||
        (lostMutation === 'cancel' && frame.method === 'tasks/cancel')
      ) {
        if (!effects.some((effect) => effect.taskId === params.taskId))
          throw new Error('Unissued mutation task ID');
        if (lostMutation === 'respond')
          expect(params.inputResponses).toEqual({
            approval: { action: 'accept', content: { approved: true } },
          });
        // The target received the operation but has not applied it: the immutable
        // form remains active, or cancellation is queued while the task works.
        response.destroy();
        return;
      } else throw new Error('Unexpected MCP task operation');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }));
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing Tasks peer address');
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    expect(failures).toEqual([]);
  });
  return {
    port: address.port,
    frames,
    effects,
    requireInput: () => {
      inputRequired = true;
    },
    complete: () => {
      completed = true;
    },
  };
}
function taskFields(taskId: string, status: string) {
  return {
    taskId,
    status,
    createdAt: '2026-11-02T00:00:00Z',
    lastUpdatedAt: '2026-11-02T00:00:01Z',
    ttlMs: 60_000,
    pollIntervalMs: 0,
  };
}
async function stateDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-tasks-recovery-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function snapshot(directory: string, order: string) {
  return new ThumbnailStore(directory, TENANT).transaction((db) =>
    db
      .prepare(
        'SELECT phase,binding,checkpoint,receipt_update,result,finished FROM orders WHERE tenant=? AND order_id=?',
      )
      .get(TENANT, order),
  ) as {
    phase: string;
    binding: string;
    checkpoint: string;
    receipt_update: string | null;
    result: string | null;
    finished: string | null;
  };
}
async function modelPort(model: ModelServer) {
  const config = await model.config();
  return Number(
    new URL(
      (config['model_providers.fixture'] as { base_url: string }).base_url,
    ).port,
  );
}
async function run(
  directory: string,
  order: string,
  mcpPort: number,
  model: ModelServer,
  crash = false,
  mutation?: 'observe' | 'respond' | 'cancel',
) {
  const port = await modelPort(model);
  const args = mutation
    ? [
        'exec',
        'tsx',
        'packages/agents-codex/test/native/fixtures/mcp-tasks-mutate.ts',
        directory,
        order,
        String(mcpPort),
        String(port),
        mutation,
      ]
    : crash
      ? [
          'exec',
          'tsx',
          'packages/agents-codex/test/native/fixtures/mcp-tasks-crash-after-save.ts',
          directory,
          order,
          String(mcpPort),
          String(port),
        ]
      : [
          'exec',
          'tsx',
          'examples/codex/mcp-tasks.ts',
          'run',
          order,
          '--directory',
          directory,
          '--mcp-port',
          String(mcpPort),
          '--model-port',
          String(port),
        ];
  const child = spawn('pnpm', args, {
    cwd: resolve(import.meta.dirname, '../../../..'),
    env: { ...process.env, OPENAI_API_KEY: 'synthetic-unused-loopback-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => {
    stdout += String(data);
  });
  child.stderr.on('data', (data) => {
    stderr += String(data);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid && process.platform !== 'win32')
      process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  }, 25_000);
  try {
    const [code, signal] = await once(child, 'close');
    expect(timedOut, stderr).toBe(false);
    expect(signal, stderr).toBeNull();
    return { code, stdout: stdout.trim(), stderr, pid: child.pid };
  } finally {
    clearTimeout(timer);
  }
}
function scriptedModel() {
  return new ModelServer([
    [call('render_thumbnail', { color: 'blue' }, { callId: ORIGINAL_CALL })],
    (request) => {
      const outputs = (request.input as JsonObject[]).filter(
        (item) => item.type === 'function_call_output',
      );
      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toMatchObject({
        call_id: ORIGINAL_CALL,
        output: RESULT_BYTES,
      });
      expect(typeof outputs[0].output).toBe('string');
      expect(JSON.stringify(request.input)).not.toMatch(
        /private-thumbnail|private-image|private-peer|internalPath|rawImage/,
      );
      return [message('Verified thumbnail size: 3085 bytes.')];
    },
  ]);
}
function originalBinding(row: ReturnType<typeof snapshot>) {
  expect(JSON.parse(row.binding)).toMatchObject({
    tenant: TENANT,
    callId: ORIGINAL_CALL,
    toolName: 'render_thumbnail',
    providerId: 'local-mcp-thumbnail-v1',
  });
}

it('runs pending, completion and finished MCP CLI advances in fresh processes with one original-call result', async () => {
  const directory = await stateDirectory();
  const peer = await taskPeer();
  const model = scriptedModel();
  const first = await run(directory, 'order-one', peer.port, model);
  expect(first, first.stderr).toMatchObject({ code: 0, stdout: 'pending' });
  expect(peer.effects).toHaveLength(1);
  expect(peer.effects[0].arguments).toEqual({ color: 'blue' });
  expect(model.requests).toHaveLength(1);
  originalBinding(snapshot(directory, 'order-one'));
  peer.complete();
  const second = await run(directory, 'order-one', peer.port, model);
  expect(second, second.stderr).toMatchObject({ code: 0, stdout: 'completed' });
  expect(second.pid).not.toBe(first.pid);
  expect(peer.effects).toHaveLength(1);
  const finished = snapshot(directory, 'order-one');
  originalBinding(finished);
  expect(finished.result).toBe(RESULT_BYTES);
  expect(finished.finished).not.toBeNull();
  expect(model.requests).toHaveLength(2);
  const calls = peer.frames.length;
  const third = await run(directory, 'order-one', peer.port, model);
  expect(third, third.stderr).toMatchObject({ code: 0, stdout: 'completed' });
  expect(new Set([first.pid, second.pid, third.pid]).size).toBe(3);
  expect(peer.frames).toHaveLength(calls);
  expect(model.requests).toHaveLength(2);
  expect(snapshot(directory, 'order-one').result).toBe(RESULT_BYTES);
  model.assertExhausted();
}, 90_000);

it('keeps lost task creation unknown across a fresh CLI restart without another create', async () => {
  const directory = await stateDirectory();
  const peer = await taskPeer(true);
  const model = new ModelServer([
    [call('render_thumbnail', { color: 'blue' }, { callId: ORIGINAL_CALL })],
  ]);
  const first = await run(directory, 'lost-create', peer.port, model);
  expect(first, first.stderr).toMatchObject({ code: 0, stdout: 'unknown' });
  expect(peer.effects).toHaveLength(1);
  const row = snapshot(directory, 'lost-create');
  originalBinding(row);
  expect(row.result).toBeNull();
  expect(row.finished).toBeNull();
  const count = peer.frames.length;
  const second = await run(directory, 'lost-create', peer.port, model);
  expect(second, second.stderr).toMatchObject({ code: 0, stdout: 'unknown' });
  expect(second.pid).not.toBe(first.pid);
  expect(peer.effects).toHaveLength(1);
  expect(peer.frames).toHaveLength(count);
  expect(model.requests).toHaveLength(1);
  model.assertExhausted();
}, 60_000);

it('replays saved exact public bytes after a real Journal.saveResult crash without provider HTTP', async () => {
  const directory = await stateDirectory();
  const peer = await taskPeer();
  const model = scriptedModel();
  const first = await run(directory, 'saved-result', peer.port, model);
  expect(first, first.stderr).toMatchObject({ code: 0, stdout: 'pending' });
  peer.complete();
  const crashed = await run(directory, 'saved-result', peer.port, model, true);
  expect(crashed, crashed.stderr).toMatchObject({ code: 73, stdout: '' });
  const saved = snapshot(directory, 'saved-result');
  originalBinding(saved);
  expect(saved.result).toBe(RESULT_BYTES);
  expect(saved.finished).toBeNull();
  expect(JSON.parse(saved.receipt_update!).status).toBe('completed');
  expect(model.requests).toHaveLength(1);
  const count = peer.frames.length;
  const resumed = await run(directory, 'saved-result', peer.port, model);
  expect(resumed, resumed.stderr).toMatchObject({
    code: 0,
    stdout: 'completed',
  });
  expect(new Set([first.pid, crashed.pid, resumed.pid]).size).toBe(3);
  expect(peer.frames).toHaveLength(count);
  expect(peer.effects).toHaveLength(1);
  expect(snapshot(directory, 'saved-result').result).toBe(saved.result);
  expect(snapshot(directory, 'saved-result').finished).not.toBeNull();
  expect(model.requests).toHaveLength(2);
  model.assertExhausted();
}, 90_000);

for (const operation of ['respond', 'cancel'] as const) {
  it(`recovers truth after a lost ${operation} reply without repeating the persisted spent mutation`, async () => {
    const directory = await stateDirectory();
    const peer = await taskPeer(false, operation);
    const model = new ModelServer([
      [call('render_thumbnail', { color: 'blue' }, { callId: ORIGINAL_CALL })],
    ]);
    const order = `lost-${operation}`;
    const first = await run(directory, order, peer.port, model);
    expect(first, first.stderr).toMatchObject({ code: 0, stdout: 'pending' });
    if (operation === 'respond') {
      peer.requireInput();
      const form = await run(
        directory,
        order,
        peer.port,
        model,
        false,
        'observe',
      );
      expect(form, form.stderr).toMatchObject({
        code: 0,
        stdout: 'inputRequired',
      });
    }
    const original = snapshot(directory, order);
    const receipt = JSON.parse(original.receipt_update!).receipt;
    originalBinding(original);
    const lost = await run(
      directory,
      order,
      peer.port,
      model,
      false,
      operation,
    );
    expect(lost, lost.stderr).toMatchObject({ code: 0, stdout: 'unknown' });
    const uncertain = snapshot(directory, order);
    expect(JSON.parse(uncertain.receipt_update!)).toMatchObject({
      status: 'unknown',
      receipt,
    });
    const stored = () =>
      new ThumbnailStore(directory, TENANT).transaction((db) => ({
        order: db
          .prepare(
            'SELECT CAST(generation AS TEXT) AS generation FROM orders WHERE tenant=? AND order_id=?',
          )
          .get(TENANT, order),
        mutation: db
          .prepare(
            'SELECT operation,state,generation,receipt FROM mutations WHERE tenant=? AND order_id=?',
          )
          .get(TENANT, order),
      }));
    const atLoss = stored();
    expect(atLoss.mutation).toMatchObject({
      operation,
      state: 'spent',
      receipt,
      generation: atLoss.order!.generation,
    });
    const method = operation === 'respond' ? 'tasks/update' : 'tasks/cancel';
    expect(peer.frames.filter((frame) => frame.method === method)).toHaveLength(
      1,
    );
    const recovered = await run(
      directory,
      order,
      peer.port,
      model,
      false,
      'observe',
    );
    expect(recovered, recovered.stderr).toMatchObject({
      code: 0,
      stdout: operation === 'respond' ? 'inputRequired' : 'pending',
    });
    const truth = snapshot(directory, order);
    expect(JSON.parse(truth.receipt_update!)).toMatchObject({
      status: operation === 'respond' ? 'inputRequired' : 'pending',
      receipt,
    });
    const beforeRetry = peer.frames.length;
    const denied = await run(
      directory,
      order,
      peer.port,
      model,
      false,
      operation,
    );
    expect(denied, denied.stderr).toMatchObject({ code: 0, stdout: 'unknown' });
    expect(peer.frames).toHaveLength(beforeRetry);
    expect(peer.frames.filter((frame) => frame.method === method)).toHaveLength(
      1,
    );
    expect(peer.effects).toHaveLength(1);
    expect(model.requests).toHaveLength(1);
    expect(snapshot(directory, order).result).toBeNull();
    expect(stored().mutation).toEqual(atLoss.mutation);
    expect(BigInt(stored().order!.generation as string)).toBeGreaterThan(
      BigInt(atLoss.order!.generation as string),
    );
    model.assertExhausted();
  }, 120_000);
}
