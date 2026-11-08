import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from 'node:worker_threads';

const {
  Buffer,
  clearTimeout,
  console,
  process,
  setImmediate,
  setTimeout,
  URL,
} = globalThis;

// Same isolate-local source loader as telemetry-worker.mjs. The Worker-only
// parent below deliberately never imports the SDK or loads its native binding.
const { register } = await import('tsx/esm/api');
register();
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function deadline(work, label, ms = 10_000) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function chunksFrom(response) {
  const chunks = [];
  while (true) {
    const chunk = await response.next_chunk();
    if (chunk === null) return chunks;
    assert(Buffer.isBuffer(chunk));
    chunks.push(chunk);
  }
}
function verifyBytes(chunks, payload) {
  assert(Buffer.concat(chunks).equals(payload));
}

async function bufferCase(size) {
  const { Agent, NativeProvider } = await import('../../../src/index.ts');
  const { binding } = await import('../../../src/runtime/binding.ts');
  const { WebSocketServer } = await import('ws');
  const native = await binding();
  const engineProto = native.Engine.prototype;
  const threadProto = native.NativeThread.prototype;
  const originalOpen = engineProto._sentinel_open;
  const originalRestore = engineProto._sentinel_restore_schemas;
  const originalStop = threadProto._request_graph_stop;
  const opened = new WeakMap();
  const ready = Promise.withResolvers();
  const parked = Promise.withResolvers();
  // Cleanup rejects this continuation; it must never send its natural WS frame.
  void parked.promise.catch(() => {});
  const payload = Buffer.alloc(size);
  for (let i = 0; i < size; i++) payload[i] = i % 251;
  const marker = `allocator-buffer-${size}`;
  const failures = [];
  let expectedBody;
  let httpRequests = 0;
  let websocketGenerations = 0;
  let stopReserved = false;
  let captured;
  let provider;
  let session;
  let turn;
  let outcome;
  let cancellation;
  let request;
  let response;
  let chunks = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      httpRequests++;
      assert.equal(incoming.method, 'POST');
      assert.equal(incoming.url, '/v1/responses');
      assert.equal(
        incoming.headers.authorization,
        'Bearer synthetic-allocator-key',
      );
      assert(
        !Object.keys(incoming.headers).some((key) =>
          key.startsWith('sec-websocket-'),
        ),
      );
      assert(
        !String(incoming.headers.connection)
          .toLowerCase()
          .split(',')
          .map((x) => x.trim())
          .includes('upgrade'),
      );
      const body = [];
      for await (const part of incoming) body.push(Buffer.from(part));
      assert(expectedBody && Buffer.concat(body).equals(expectedBody));
      const parsed = JSON.parse(expectedBody.toString());
      assert.equal(parsed.stream, true);
      assert(JSON.stringify(parsed.input).includes(marker));
      outgoing.writeHead(200, {
        'content-type': 'application/octet-stream',
        connection: 'close',
      });
      outgoing.end(payload);
    } catch (error) {
      failures.push(error);
      outgoing.writeHead(500).end();
    }
  });
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const ws = new WebSocketServer({ noServer: true });
  server.on('upgrade', (incoming, socket, head) => {
    ws.handleUpgrade(incoming, socket, head, (connection) => {
      connection.on('message', (data) => {
        try {
          const frame = JSON.parse(data.toString());
          if (frame.generate === false) {
            connection.send(
              JSON.stringify({
                type: 'response.created',
                response: { id: 'allocator-warmup' },
              }),
            );
            connection.send(
              JSON.stringify({
                type: 'response.completed',
                response: { id: 'allocator-warmup' },
              }),
            );
          } else if (frame.type !== 'response.interrupt') {
            websocketGenerations++;
            throw new Error('The parked generation escaped to WebSocket send');
          }
        } catch (error) {
          failures.push(error);
          connection.close();
        }
      });
    });
  });
  engineProto._sentinel_open = function (...args) {
    const result = Reflect.apply(originalOpen, this, args);
    opened.set(this, { provider: args[0], headers: args[1], remote: result });
    return result;
  };
  engineProto._sentinel_restore_schemas = async function (...args) {
    const restored = await Reflect.apply(originalRestore, this, args);
    if (JSON.parse(args[2]).generate === false) return restored;
    assert.equal(captured, undefined);
    const route = opened.get(this);
    assert(route && route.provider === args[0]);
    captured = { ...route, engine: this, ticket: args[1], restored };
    ready.resolve(captured);
    return parked.promise;
  };
  threadProto._request_graph_stop = function (...args) {
    const result = Reflect.apply(originalStop, this, args);
    if (args[0] === 'root' && args[1] === 'force') stopReserved = true;
    return result;
  };
  let result;
  const cleanupErrors = [];
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    provider = new NativeProvider({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'synthetic-allocator-key',
      supportsWebsockets: true,
    });
    session = await new Agent({ instructions: 'Answer.', provider }).session();
    turn = await session.submit(marker + (size > 1024 ? 'p'.repeat(size) : ''));
    outcome = turn.wait().then(
      () => undefined,
      () => undefined,
    );
    const cap = await deadline(ready.promise, 'real restored generation');
    const body = JSON.parse(cap.restored);
    delete body.type;
    delete body.generate;
    body.stream = true;
    const headers = JSON.parse(cap.headers);
    assert(
      Array.isArray(headers) &&
        headers.every(
          (p) =>
            Array.isArray(p) &&
            p.length === 2 &&
            p.every((v) => typeof v === 'string'),
        ),
    );
    const httpHeaders = headers.filter(
      ([name]) => !name.toLowerCase().startsWith('sec-websocket-'),
    );
    if (!httpHeaders.some(([name]) => name.toLowerCase() === 'content-type'))
      httpHeaders.push(['content-type', 'application/json']);
    const input = Buffer.from(JSON.stringify(body));
    expectedBody = Buffer.from(input);
    request = new native._ModelHttpRequest();
    const pending = cap.engine._sentinel_stream(
      cap.provider,
      JSON.stringify(httpHeaders),
      input,
      cap.ticket,
      request,
    );
    // NativeBuffer copies on the JS thread, before Rust async dispatch.
    input.fill(0x21);
    response = await deadline(pending, 'real native byte stream');
    assert.equal(response.status, 200);
    chunks = await deadline(chunksFrom(response), 'native buffer EOF');
    verifyBytes(chunks, payload);
    if (size) assert(chunks.length > 0);
    else assert.equal(chunks.length, 0); // Empty response, not a fabricated empty external Buffer.
    await response.close();
    request.cancel();
    stopReserved = false;
    cancellation = turn.cancel({ mode: 'force' });
    void cancellation.catch(() => {});
    assert(
      stopReserved,
      'force stop must reserve its native fence before release',
    );
    parked.reject(
      new Error('Allocator fixture retires the parked continuation'),
    );
    await deadline(
      Promise.all([cancellation, outcome]),
      'cancelled carrier join',
    );
    await session.close();
    await provider.close();
    // Real native chunks must remain usable after every model/session/provider owner closes.
    verifyBytes(chunks, payload);
    const nativeBuffers = chunks.length;
    let collectedWrappers = 0;
    const registry = new FinalizationRegistry(() => collectedWrappers++);
    const tokens = chunks.map(() => ({}));
    chunks.forEach((chunk, index) =>
      registry.register(chunk, index, tokens[index]),
    );
    chunks.length = 0;
    assert.equal(typeof globalThis.gc, 'function');
    await deadline(
      (async () => {
        for (let i = 0; i < 100 && collectedWrappers !== nativeBuffers; i++) {
          await tick();
          globalThis.gc();
          await tick();
        }
        assert.equal(collectedWrappers, nativeBuffers);
      })(),
      'wrapper collection',
    );
    // Keep the registry itself live through collection and retire its tokens.
    for (const token of tokens) assert.equal(registry.unregister(token), false);
    assert.equal(httpRequests, 1);
    assert.equal(websocketGenerations, 0);
    assert.deepEqual(failures, []);
    result = {
      bytes: size,
      nativeBuffers,
      collectedWrappers,
      httpRequests,
      websocketGenerations,
      nativeDeallocationDirectlyObserved: false,
    };
  } catch (error) {
    cleanupErrors.push(error);
  } finally {
    try {
      try {
        request?.cancel();
        if (turn && !cancellation) {
          cancellation = turn.cancel({ mode: 'force' });
          void cancellation.catch(() => {});
        }
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        // Even a failed stop reservation must release the parked continuation.
        parked.reject(new Error('Allocator fixture cleanup'));
      }
      for (const close of [
        () => response?.close(),
        () => cancellation,
        () => outcome,
        () => captured?.remote.then((socket) => socket.close(1000, '')),
        () => session?.close(),
        () => provider?.close(),
      ]) {
        try {
          await deadline(Promise.resolve().then(close), 'fixture cleanup');
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      for (const connection of ws.clients) connection.terminate();
      for (const socket of sockets) socket.destroy();
      await deadline(
        new Promise((resolve) => ws.close(resolve)),
        'WebSocket peer close',
      );
      await deadline(
        new Promise((resolve) => server.close(resolve)),
        'HTTP peer close',
      );
      await deadline(
        (async () => {
          while (sockets.size) await tick();
        })(),
        'all fixture sockets closed',
      );
      assert.equal(httpRequests, 1);
      assert.equal(websocketGenerations, 0);
      assert.deepEqual(failures, []);
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      engineProto._sentinel_open = originalOpen;
      engineProto._sentinel_restore_schemas = originalRestore;
      threadProto._request_graph_stop = originalStop;
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      cleanupErrors,
      'Allocator fixture or cleanup failed',
    );
  return result;
}

async function workerTurn() {
  const { Agent, NativeProvider } = await import('../../../src/index.ts');
  const provider = new NativeProvider({
    baseUrl: workerData.baseUrl,
    apiKey: 'synthetic-allocator-worker',
    supportsWebsockets: false,
  });
  try {
    const result = await new Agent({ instructions: 'Answer.', provider }).run(
      'allocator worker',
    );
    assert.equal(result.finalOutput, 'worker-done');
    parentPort.postMessage({ done: true });
  } finally {
    await provider.close();
    parentPort.close();
  }
}

async function workersOnly() {
  assert(
    !process.report
      .getReport()
      .sharedObjects.some((path) => path.endsWith('/codex.node')),
    'Worker-only parent must not have loaded the addon',
  );
  const held = Promise.withResolvers();
  void held.promise.catch(() => {});
  const disconnected = Promise.withResolvers();
  let hold = false;
  let requests = 0;
  const failures = [];
  const sockets = new Set();
  const server = createServer(async (incoming, outgoing) => {
    try {
      for await (const _ of incoming) {
        /* Consume the actual request before signalling. */
      }
      assert.equal(
        incoming.headers.authorization,
        'Bearer synthetic-allocator-worker',
      );
      requests++;
      if (hold) {
        incoming.socket.once('close', disconnected.resolve);
        held.resolve();
        return;
      }
      outgoing.writeHead(200, {
        'content-type': 'text/event-stream',
        connection: 'close',
      });
      for (const event of [
        { type: 'response.created', response: { id: 'allocator-worker' } },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            id: 'allocator-worker-item',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'worker-done' }],
          },
        },
        {
          type: 'response.completed',
          response: {
            id: 'allocator-worker',
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ])
        outgoing.write(`data: ${JSON.stringify(event)}\n\n`);
      outgoing.end();
    } catch (error) {
      failures.push(error);
      held.reject(error);
      outgoing.writeHead(500).end();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const active = new Set();
  async function start() {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { baseUrl: `http://127.0.0.1:${address.port}/v1` },
      execArgv: [],
    });
    active.add(worker);
    let done = false;
    worker.on('message', (message) => {
      done ||= message.done === true;
    });
    const exit = new Promise((resolve, reject) => {
      worker.once('exit', resolve);
      worker.once('error', reject);
    });
    void exit.catch(() => {});
    return { worker, exit, done: () => done };
  }
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let naturalExits = 0;
    for (let i = 0; i < 3; i++) {
      const value = await start();
      assert.equal(await deadline(value.exit, 'Worker-only natural exit'), 0);
      assert(value.done());
      active.delete(value.worker);
      naturalExits++;
    }
    hold = true;
    const pending = await start();
    await deadline(held.promise, 'pending Worker transport');
    assert.equal(
      await deadline(pending.worker.terminate(), 'Worker termination'),
      1,
    );
    assert.equal(await deadline(pending.exit, 'terminated Worker join'), 1);
    active.delete(pending.worker);
    await deadline(disconnected.promise, 'terminated upstream socket close');
    hold = false;
    const fresh = await start();
    assert.equal(
      await deadline(fresh.exit, 'fresh Worker after termination'),
      0,
    );
    assert(fresh.done());
    active.delete(fresh.worker);
    naturalExits++;
    assert.equal(requests, 5);
    assert.deepEqual(failures, []);
    return { naturalExits, terminatedPending: 1 };
  } finally {
    await Promise.all([...active].map((worker) => worker.terminate()));
    for (const socket of sockets) socket.destroy();
    await deadline(
      new Promise((resolve) => server.close(resolve)),
      'Worker peer close',
    );
  }
}

if (!isMainThread) {
  await workerTurn();
} else {
  const mode = process.argv[2];
  const result = mode === 'buffers' ? { cases: [] } : undefined;
  // Buffer cases intentionally run serially: each temporarily forwards native prototypes.
  if (result) {
    for (const size of [0, 17, 256 * 1024])
      result.cases.push(await bufferCase(size));
  }
  assert(mode === 'buffers' || mode === 'workers');
  const details = result ?? (await workersOnly());
  console.log(
    JSON.stringify({
      fixture: 'allocator-ownership',
      mode,
      status: 'passed',
      ...details,
    }),
  );
}
