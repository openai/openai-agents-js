import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  AppError,
  approvalSchema,
  ownerSchema,
  taskSchema,
  terminal,
} from './protocol';
import { startReportPeer } from './mcp-peer';
import { TaskStore } from './store';
import { TaskWorker, type WorkerOptions } from './worker';

async function body(request: IncomingMessage): Promise<unknown> {
  if (
    request.headers['content-type']?.split(';')[0].trim() !== 'application/json'
  )
    throw new AppError(400, 'Use application/json.');
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => request.destroy(), 5000);
  try {
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 8192) throw new AppError(400, 'Request body too large.');
      chunks.push(bytes);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new AppError(400, 'Invalid JSON.');
    }
  } finally {
    clearTimeout(timer);
  }
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response
    .writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    })
    .end(JSON.stringify(value));
}

export async function startWebStarter(
  options: { directory: string; port?: number } & WorkerOptions,
) {
  const store = new TaskStore(options.directory);
  let peer: Awaited<ReturnType<typeof startReportPeer>>;
  try {
    peer = await startReportPeer({
      storeReport: (report) => store.storeReport(report),
    });
  } catch (error) {
    store.close();
    throw error;
  }
  const worker = new TaskWorker(store, peer, options);
  const streams = new Set<ServerResponse>();
  const handlers = new Set<Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let origin = '';
  const server = createServer((request, response) => {
    const operation = handle(request, response).catch((error: unknown) => {
      if (!response.headersSent && !response.destroyed)
        json(response, error instanceof AppError ? error.status : 500, {
          error:
            error instanceof AppError
              ? error.message
              : 'Application operation failed.',
        });
      else response.destroy();
    });
    handlers.add(operation);
    void operation.finally(() => handlers.delete(operation));
  });
  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader(
      'content-security-policy',
      "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'",
    );
    if (closing) throw new AppError(503, 'Application is closing.');
    if (
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin !== undefined &&
        request.headers.origin !== origin)
    )
      throw new AppError(400, 'Use the local application origin.');
    if (handlers.size >= 32) throw new AppError(429, 'Too many HTTP requests.');
    const url = new URL(request.url ?? '/', origin);
    if (
      request.method === 'GET' &&
      ['/', '/client.js'].includes(url.pathname)
    ) {
      const name = url.pathname === '/' ? 'index.html' : 'client.js';
      response
        .writeHead(200, {
          'content-type': name.endsWith('.html')
            ? 'text/html; charset=utf-8'
            : 'text/javascript; charset=utf-8',
        })
        .end(await readFile(join(__dirname, name)));
      return;
    }
    const parsedOwner = ownerSchema.safeParse(url.searchParams.get('owner'));
    if (!parsedOwner.success)
      throw new AppError(400, 'Choose synthetic user alice or bob.');
    const owner = parsedOwner.data;
    const parts = url.pathname.split('/').filter(Boolean);
    if (request.method === 'POST' && url.pathname === '/tasks') {
      const parsed = taskSchema.safeParse(await body(request));
      if (!parsed.success)
        throw new AppError(400, 'Invalid task or request key.');
      const admitted = worker.admit(
        owner,
        parsed.data.requestKey,
        parsed.data.task,
      );
      json(response, admitted.recovered ? 200 : 202, admitted.snapshot);
      return;
    }
    if (
      parts[0] === 'artifacts' &&
      parts.length === 2 &&
      request.method === 'GET'
    ) {
      const bytes = store.artifact(owner, parts[1]);
      response
        .writeHead(200, {
          'content-type': 'application/json',
          'content-disposition': 'attachment; filename="presentation.json"',
        })
        .end(bytes);
      return;
    }
    if (parts[0] !== 'tasks' || !parts[1] || parts.length > 3)
      throw new AppError(404, 'Route unavailable.');
    const receipt = parts[1];
    const snapshot = worker.snapshot(owner, receipt);
    if (parts.length === 2 && request.method === 'GET') {
      json(response, 200, snapshot);
      return;
    }
    if (parts[2] === 'events' && request.method === 'GET') {
      if (streams.size >= 16)
        throw new AppError(429, 'Too many snapshot readers.');
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        connection: 'keep-alive',
      });
      streams.add(response);
      let revision = 0;
      const send = () => {
        try {
          const state = worker.snapshot(owner, receipt);
          if (state.revision <= revision) return;
          revision = state.revision;
          if (
            !response.write(
              `event: snapshot\nid: ${state.revision}\ndata: ${JSON.stringify(state)}\n\n`,
            )
          )
            response.destroy();
          else if (terminal(state.phase)) response.end();
        } catch {
          response.end();
        }
      };
      const unsubscribe = worker.subscribe((changed) => {
        if (changed === receipt) send();
      });
      // Expiry denies subsequent access, including a long-lived reader.
      const timer = setTimeout(
        () => response.end(),
        Math.min(3_600_000, store.get(owner, receipt).expiresAt - Date.now()),
      );
      response.once('close', () => {
        clearTimeout(timer);
        unsubscribe();
        streams.delete(response);
      });
      send();
      return;
    }
    if (parts[2] === 'approval' && request.method === 'POST') {
      const parsed = approvalSchema.safeParse(await body(request));
      if (!parsed.success) throw new AppError(400, 'Invalid approval.');
      json(
        response,
        202,
        worker.approve(owner, receipt, parsed.data.token, parsed.data.approve),
      );
      return;
    }
    if (parts[2] === 'stop' && request.method === 'POST') {
      const value = await body(request);
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length
      )
        throw new AppError(400, 'Stop accepts an empty object.');
      json(response, 202, worker.stop(owner, receipt));
      return;
    }
    throw new AppError(404, 'Route unavailable.');
  }
  server.maxConnections = 32;
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.setTimeout(10_000, (socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await peer.close();
    store.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Application did not receive a TCP port.');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: origin,
    worker,
    store,
    close(): Promise<void> {
      if (!closePromise)
        closePromise = (async () => {
          closing = true;
          const errors: unknown[] = [];
          const closed = new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
          try {
            await worker.close();
          } catch (error) {
            errors.push(error);
          }
          for (const response of streams) response.end();
          server.closeAllConnections();
          try {
            await closed;
          } catch (error) {
            errors.push(error);
          }
          await Promise.all(handlers);
          try {
            await peer.close();
          } catch (error) {
            errors.push(error);
          }
          try {
            store.close();
          } catch (error) {
            errors.push(error);
          }
          if (errors.length)
            throw new AggregateError(errors, 'Application cleanup failed');
        })();
      return closePromise;
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string', default: 'scripted' },
      directory: { type: 'string' },
      port: { type: 'string', default: '0' },
    },
  });
  const port = Number(values.port);
  if (
    values.mode !== 'scripted' ||
    !values.directory ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  )
    throw new Error(
      'Use --mode scripted --directory <private-directory> --port <0..65535>.',
    );
  const app = await startWebStarter({ directory: values.directory, port });
  console.log(`Web starter: ${app.url}`);
  const shutdown = () => {
    void app.close().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
