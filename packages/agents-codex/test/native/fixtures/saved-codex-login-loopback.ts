import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
} from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Duplex } from 'node:stream';

const execute = promisify(execFile);
export const modelHost = 'chatgpt.com';
export const authHost = 'auth.openai.com';
export const apiHost = 'api.openai.com';

async function certificates(directory: string, realtime: boolean) {
  const openssl = (...args: string[]) =>
    execute('openssl', args, { cwd: directory, timeout: 5_000 });
  await openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '1',
    '-subj',
    '/CN=Saved Codex login test CA',
  );
  await openssl(
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'server.key',
    '-out',
    'server.csr',
    '-subj',
    `/CN=${modelHost}`,
  );
  await writeFile(
    join(directory, 'server.ext'),
    `subjectAltName=DNS:${modelHost},DNS:${authHost}${realtime ? `,DNS:${apiHost}` : ''}\nextendedKeyUsage=serverAuth\n`,
  );
  await openssl(
    'x509',
    '-req',
    '-in',
    'server.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'server.pem',
    '-days',
    '1',
    '-extfile',
    'server.ext',
  );
  return {
    key: await readFile(join(directory, 'server.key')),
    cert: await readFile(join(directory, 'server.pem')),
  };
}

async function listen(server: Server, sockets: Set<Socket>) {
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  const address = server.address();
  assert(address && typeof address === 'object');
  return address.port;
}

export async function openSavedLoginLoopback({
  directory,
  home,
  failures,
  onRequest,
  allowAuth = true,
  onUpgrade,
}: {
  directory: string;
  home: string;
  failures: string[];
  onRequest: RequestListener;
  allowAuth?: boolean;
  onUpgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
}) {
  const sockets = new Set<Socket>();
  const servers: Server[] = [];
  const tunnels: string[] = [];
  const dispose = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      servers
        .filter((server) => server.listening)
        .map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    );
  };
  try {
    const tls = createTlsServer(
      await certificates(directory, !!onUpgrade),
      onRequest,
    );
    servers.push(tls);
    if (onUpgrade) tls.on('upgrade', onUpgrade);
    const tlsPort = await listen(tls, sockets);
    const allowed = new Set([`${modelHost}:443`]);
    if (allowAuth) allowed.add(`${authHost}:443`);
    if (onUpgrade) allowed.add(`${apiHost}:443`);
    const proxy = createServer((request, response) => {
      request.resume();
      failures.push('Unexpected non-CONNECT proxy request');
      response.writeHead(403).end();
    });
    servers.push(proxy);
    proxy.on('connect', (request, socket, head) => {
      const authority = request.url ?? '';
      socket.on('error', () => socket.destroy());
      if (!allowed.has(authority)) {
        failures.push('Unexpected CONNECT authority');
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      tunnels.push(authority);
      const target = connect(tlsPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        target.write(head);
        socket.pipe(target).pipe(socket);
      });
      sockets.add(target);
      target.on('error', () => socket.destroy());
      target.once('close', () => {
        sockets.delete(target);
        socket.destroy();
      });
      socket.once('close', () => target.destroy());
    });
    const proxyUrl = `http://127.0.0.1:${await listen(proxy, sockets)}`;
    const ca = join(directory, 'ca.pem');
    return {
      tunnels,
      runChild: (childPath: string, args: string[], timeout = 15_000) =>
        execute(process.execPath, [childPath, ...args], {
          cwd: home,
          // Start without inherited model auth, proxy bypasses, or Node preload hooks.
          env: {
            PATH: process.env.PATH,
            HOME: home,
            TMPDIR: directory,
            HTTP_PROXY: proxyUrl,
            HTTPS_PROXY: proxyUrl,
            ALL_PROXY: proxyUrl,
            CODEX_CA_CERTIFICATE: ca,
            SSL_CERT_FILE: ca,
            SSL_CERT_DIR: home,
          },
          timeout,
          killSignal: 'SIGKILL',
        }),
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
