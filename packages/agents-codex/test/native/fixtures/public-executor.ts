import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import type { JsonObject } from '../../../src/runtime/binding';

/** A trusted WSS relay in front of the real native executor. Owns process CA settings. */
export async function startPublicExecutor(
  options: {
    captureFileSystemDiagnostics?: boolean;
    captureProcessDiagnostics?: boolean;
    certificateNames?: string;
    authorization?: string;
    rejectAuthorization?: boolean;
    dropStartReplyAfter?: { path: string; contents: string };
    /** Test only advertised admission failures, not executor enforcement. */
    environmentInfoOverride?: {
      platformOs?: string;
      networkProxyLaunch?: boolean;
    };
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'agents-public-executor-'));
  const cwd = join(directory, 'remote');
  const config = join(directory, 'config');
  const ca = join(directory, 'ca.pem');
  const key = join(directory, 'server.key');
  const cert = join(directory, 'server.pem');
  const requests: JsonObject[] = [];
  const processDiagnostics: JsonObject[] = [];
  let connectionCount = 0;
  const retainProcess = (value: JsonObject) => {
    if (processDiagnostics.length < 128) processDiagnostics.push(value);
  };

  // Opt-in synthetic-fixture evidence excludes file bytes, headers and other RPCs.
  const fileSystemDiagnostics: JsonObject[] = [];
  const pendingFileSystem = new Set<string>();
  const retainDiagnostic = (value: JsonObject) => {
    if (fileSystemDiagnostics.length >= 32) return;
    const encoded = JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === 'string'
        ? entry
            .replace(/Bearer\s+[^\s"\\]+|sk-[A-Za-z0-9_-]+/gi, '[REDACTED]')
            .slice(0, 4096)
        : entry,
    );
    fileSystemDiagnostics.push(
      encoded.length <= 16_384
        ? (JSON.parse(encoded) as JsonObject)
        : { truncated: true, reason: 'Diagnostic exceeded 16384 characters' },
    );
  };
  const rejectedUpgrades: number[] = [];
  const headers = {
    Authorization: options.authorization ?? 'Bearer synthetic-executor-token',
  };
  const caCertificate = ca;
  const tlsFailures: string[] = [];
  let droppedStartReply = false;
  const environment = {
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    SSL_CERT_DIR: process.env.SSL_CERT_DIR,
    CODEX_CA_CERTIFICATE: process.env.CODEX_CA_CERTIFICATE,
  };
  let child: ChildProcess | undefined;
  let server: Server | undefined;
  let restored = false;
  const sockets = new Set<WebSocket>();
  const close = async () => {
    if (restored) return;
    restored = true;
    for (const socket of sockets) socket.terminate();
    if (server?.listening) {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await Promise.all([mkdir(cwd), mkdir(config)]);
    const openssl = (...args: string[]) =>
      execFileSync('openssl', args, { stdio: 'ignore' });
    openssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(directory, 'ca.key'),
      '-out',
      ca,
      '-days',
      '1',
      '-subj',
      '/CN=Executor fixture CA',
    );
    openssl(
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      join(directory, 'server.csr'),
      '-subj',
      '/CN=localhost',
    );
    await writeFile(
      join(directory, 'extensions.cnf'),
      `subjectAltName=${options.certificateNames ?? 'DNS:localhost,IP:127.0.0.1'}\nextendedKeyUsage=serverAuth\n`,
    );
    openssl(
      'x509',
      '-req',
      '-in',
      join(directory, 'server.csr'),
      '-CA',
      ca,
      '-CAkey',
      join(directory, 'ca.key'),
      '-CAcreateserial',
      '-out',
      cert,
      '-days',
      '1',
      '-extfile',
      join(directory, 'extensions.cnf'),
    );
    process.env.SSL_CERT_FILE = ca;
    process.env.SSL_CERT_DIR = config;
    process.env.CODEX_CA_CERTIFICATE = ca;
    let upstreamUrl = '';
    child = spawn(
      process.env.CODEX_EXEC_SERVER_TEST_BINARY ??
        resolve(
          import.meta.dirname,
          '../../../native/test-bin/exec-server-fixture',
        ),
      ['ws://127.0.0.1:0'],
      {
        cwd,
        env: {
          ...process.env,
          CODEX_HOME: config,
          PATH: `${resolve(import.meta.dirname, '../../../bin')}${delimiter}${process.env.PATH ?? ''}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let startupError: Error | undefined;
    child.on('error', (error) => {
      startupError = error;
    });
    let log = '';
    let addressOutput = '';
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      log += text;
      if (!upstreamUrl) {
        addressOutput += text;
        const address = /^(ws:\/\/127\.0\.0\.1:\d+)\r?\n/m.exec(addressOutput);
        if (address) upstreamUrl = address[1];
      }
    });
    child.stderr?.on('data', (data: Buffer) => {
      log += data.toString();
    });
    const deadline = Date.now() + 15_000;
    while (true) {
      if (startupError) throw startupError;
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error(`Executor failed to start: ${log}`);
      try {
        if (
          upstreamUrl &&
          (
            await fetch(`${upstreamUrl.replace('ws:', 'http:')}/readyz`, {
              signal: AbortSignal.timeout(1000),
            })
          ).ok
        )
          break;
      } catch {
        /* The child has not bound its port yet. */
      }
      await delay(20);
    }
    server = createServer(
      { key: await readFile(key), cert: await readFile(cert) },
      (_request, response) => response.writeHead(404).end(),
    );
    server.on('tlsClientError', (error) => tlsFailures.push(error.message));
    const websocket = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      if (
        options.rejectAuthorization ||
        request.url !== '/executor' ||
        request.headers.authorization !== headers.Authorization
      ) {
        rejectedUpgrades.push(401);
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      websocket.handleUpgrade(request, socket, head, (downstream) => {
        const upstream = new WebSocket(upstreamUrl);
        const connection = ++connectionCount;
        const pendingProcess = new Map<string, JsonObject>();
        const readStates = new Map<string, string>();
        sockets.add(downstream);
        sockets.add(upstream);
        const queued: string[] = [];
        const starts = new Set<string>();
        const infoRequests = new Set<string>();
        downstream.on('message', (data) => {
          const text = data.toString();
          const request = JSON.parse(text) as JsonObject;
          requests.push(request);
          if (options.dropStartReplyAfter && request.method === 'process/start')
            starts.add(JSON.stringify(request.id));
          if (
            options.captureProcessDiagnostics &&
            pendingProcess.size < 128 &&
            ['process/start', 'process/read', 'process/terminate'].includes(
              String(request.method),
            )
          ) {
            const params = request.params as JsonObject;
            const entry: JsonObject = {
              connection,
              requestSequence: requests.length,
              id: request.id,
              method: request.method,
              processId: params.processId ?? null,
            };
            pendingProcess.set(JSON.stringify(request.id), entry);
            if (request.method !== 'process/read')
              retainProcess({ direction: 'request', ...entry });
          }
          if (
            options.environmentInfoOverride &&
            ['initialize', 'environment/info'].includes(String(request.method))
          )
            infoRequests.add(JSON.stringify(request.id));
          if (
            options.captureFileSystemDiagnostics &&
            pendingFileSystem.size < 16 &&
            ['fs/writeFile', 'fs/open'].includes(String(request.method))
          ) {
            const params = request.params as JsonObject;
            pendingFileSystem.add(JSON.stringify(request.id));
            retainDiagnostic({
              direction: 'request',
              id: request.id,
              method: request.method,
              path: params.path,
              mode: params.mode,
              followSymlinks: params.followSymlinks,
              sandbox: params.sandbox,
            });
          }
          if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
          else queued.push(text);
        });
        upstream.on('open', () => {
          for (const message of queued) upstream.send(message);
        });
        upstream.on('message', async (data, binary) => {
          if (options.captureProcessDiagnostics && !binary) {
            const response = JSON.parse(data.toString()) as JsonObject;
            const entry = pendingProcess.get(JSON.stringify(response.id));
            if (entry) {
              pendingProcess.delete(JSON.stringify(response.id));
              const result = response.result as JsonObject | undefined;
              const error = response.error as JsonObject | undefined;
              const state: JsonObject = {
                ...(result?.processId === undefined
                  ? {}
                  : { processId: result.processId }),
                ...(result?.running === undefined
                  ? {}
                  : { running: result.running }),
                ...(result?.exited === undefined
                  ? {}
                  : { exited: result.exited }),
                ...(result?.closed === undefined
                  ? {}
                  : { closed: result.closed }),
                ...(result?.exitCode === undefined
                  ? {}
                  : { exitCode: result.exitCode }),
                ...(error
                  ? {
                      errorCode: error.code,
                      errorMessage: String(error.message)
                        .replace(
                          /Bearer\s+[^\s"\\]+|sk-[A-Za-z0-9_-]+/gi,
                          '[REDACTED]',
                        )
                        .slice(0, 512),
                    }
                  : {}),
              };
              const key = String(entry.processId);
              const serialized = JSON.stringify(state);
              if (
                entry.method !== 'process/read' ||
                readStates.get(key) !== serialized
              ) {
                retainProcess({ direction: 'response', ...entry, ...state });
                readStates.set(key, serialized);
              }
            }
          }
          if (options.dropStartReplyAfter && !binary) {
            const response = JSON.parse(data.toString()) as JsonObject;
            if (starts.delete(JSON.stringify(response.id))) {
              const deadline = Date.now() + 5000;
              while (Date.now() < deadline) {
                try {
                  const contents = await readFile(
                    join(cwd, options.dropStartReplyAfter.path),
                    'utf8',
                  );
                  if (contents !== options.dropStartReplyAfter.contents) {
                    await delay(10);
                    continue;
                  }
                  droppedStartReply = true;
                  downstream.terminate();
                  upstream.terminate();
                  return;
                } catch {
                  await delay(10);
                }
              }
              // The test must distinguish missing marker evidence from a dropped ACK.
              downstream.terminate();
              upstream.terminate();
              return;
            }
          }
          if (options.environmentInfoOverride && !binary) {
            const response = JSON.parse(data.toString()) as JsonObject;
            if (
              infoRequests.delete(JSON.stringify(response.id)) &&
              response.result
            ) {
              const result = response.result as JsonObject;
              const info = (result.environmentInfo ?? result) as JsonObject;
              if (options.environmentInfoOverride.platformOs !== undefined)
                info.platformOs = options.environmentInfoOverride.platformOs;
              if (
                options.environmentInfoOverride.networkProxyLaunch !== undefined
              ) {
                const capabilities = { ...(info.capabilities as JsonObject) };
                capabilities.networkProxyLaunch =
                  options.environmentInfoOverride.networkProxyLaunch;
                info.capabilities = capabilities;
              }
              if (downstream.readyState === WebSocket.OPEN)
                downstream.send(JSON.stringify(response));
              return;
            }
          }
          if (options.captureFileSystemDiagnostics && !binary) {
            const response = JSON.parse(data.toString()) as JsonObject;
            if (pendingFileSystem.delete(JSON.stringify(response.id))) {
              const error = response.error as JsonObject | undefined;
              retainDiagnostic({
                direction: 'response',
                id: response.id,
                ...(error
                  ? { error: { code: error.code, message: error.message } }
                  : { success: true }),
              });
            }
          }
          if (downstream.readyState === WebSocket.OPEN)
            downstream.send(data, { binary });
        });
        for (const [source, destination] of [
          [downstream, upstream],
          [upstream, downstream],
        ]) {
          source.on('error', () => {
            destination.terminate();
          });
          source.on('close', () => {
            sockets.delete(source);
            destination.terminate();
          });
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const tlsAddress = server.address();
    if (!tlsAddress || typeof tlsAddress === 'string')
      throw new Error('No TLS executor port');
    return {
      url: `wss://127.0.0.1:${tlsAddress.port}/executor`,
      cwd,
      caCertificate,
      tlsFailures,
      get droppedStartReply() {
        return droppedStartReply;
      },
      headers,
      requests,
      processDiagnostics,
      fileSystemDiagnostics,
      rejectedUpgrades,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
