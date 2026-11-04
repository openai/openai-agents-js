import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { test } from 'vitest';

const serverUrl = new URL('../scripts/token-server.mjs', import.meta.url).href;

async function startServer(host: string, configuredPort?: number) {
  const port = await new Promise<number>((resolve, reject) => {
    const reservation = createServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const selectedPort = (reservation.address() as AddressInfo).port;
      reservation.close(() => resolve(selectedPort));
    });
  });
  const script = `
    import { Server } from 'node:http';
    ${
      configuredPort === undefined
        ? ''
        : `
    // Exercise the configured authority without requiring a privileged listener.
    const listen = Server.prototype.listen;
    Server.prototype.listen = function (requestedPort, ...args) {
      return listen.call(this, ${port}, ...args);
    };`
    }
    globalThis.fetch = async () => {
      console.log('UPSTREAM_REQUEST');
      return new Response(JSON.stringify({ value: 'test-client-secret', expires_at: 123 }), { status: 200 });
    };
    await import(${JSON.stringify(serverUrl)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      HOST: host,
      PORT: String(configuredPort ?? port),
      OPENAI_API_KEY: 'test-api-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Token server startup timed out.')),
      5000,
    );
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('Realtime token server listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`Token server exited: ${code}`)),
    );
  });
  return {
    port,
    get output() {
      return output;
    },
    pairingToken: output.match(/Pairing token: ([A-Za-z0-9_-]+)/)?.[1],
    request: (headers?: Record<string, string>) =>
      new Promise<Response>((resolve, reject) => {
        const request = httpRequest(
          `http://${host === 'localhost' ? 'localhost' : '127.0.0.1'}:${port}/token`,
          { method: 'POST', headers },
          (response) => {
            let body = '';
            response.on('data', (chunk) => (body += chunk));
            response.on('end', () =>
              resolve(new Response(body, { status: response.statusCode })),
            );
          },
        );
        request.once('error', reject);
        request.end();
      }),
    stop: () => child.kill(),
  };
}

test('LAN token issuance requires pairing and limits each client', async () => {
  const server = await startServer('0.0.0.0');
  try {
    assert.equal((await server.request()).status, 401);
    assert.equal(
      (await server.request({ Authorization: 'Bearer wrong' })).status,
      401,
    );
    assert.equal(server.output.includes('UPSTREAM_REQUEST'), false);

    assert.ok(server.pairingToken);
    const headers = { Authorization: `Bearer ${server.pairingToken}` };
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await server.request(headers);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).value, 'test-client-secret');
    }
    assert.equal((await server.request(headers)).status, 429);
    assert.equal(server.output.match(/UPSTREAM_REQUEST/g)?.length, 6);
  } finally {
    server.stop();
  }
});

test('loopback bind aliases accept paired emulator and simulator requests', async () => {
  for (const host of ['localhost', '::']) {
    const server = await startServer(host);
    try {
      const headers = { Authorization: `Bearer ${server.pairingToken}` };
      assert.equal(
        (await server.request({ ...headers, Host: `127.0.0.1:${server.port}` }))
          .status,
        200,
      );
      assert.equal(
        (await server.request({ ...headers, Host: `10.0.2.2:${server.port}` }))
          .status,
        200,
      );
    } finally {
      server.stop();
    }
  }
});

test('loopback token issuance requires pairing and an expected origin', async () => {
  const server = await startServer('127.0.0.1');
  try {
    assert.ok(server.pairingToken);
    assert.equal((await server.request()).status, 401);
    assert.equal(server.output.includes('UPSTREAM_REQUEST'), false);

    const headers = { Authorization: `Bearer ${server.pairingToken}` };
    assert.equal(
      (await server.request({ ...headers, Host: '127.0.0.1' })).status,
      403,
    );
    assert.equal(
      (
        await server.request({
          ...headers,
          Host: `unexpected.example:${server.port}`,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await server.request({
          ...headers,
          Origin: 'https://unexpected.example',
        })
      ).status,
      403,
    );
    assert.equal(server.output.includes('UPSTREAM_REQUEST'), false);

    assert.equal((await server.request(headers)).status, 200);
    assert.equal(
      (await server.request({ ...headers, Host: `10.0.2.2:${server.port}` }))
        .status,
      200,
    );
    assert.equal(server.output.match(/UPSTREAM_REQUEST/g)?.length, 2);
  } finally {
    server.stop();
  }
});

test('HTTP port 80 accepts exact portless aliases and serialized origins while requiring pairing', async () => {
  const server = await startServer('127.0.0.1', 80);
  try {
    assert.ok(server.pairingToken);
    assert.equal((await server.request({ Host: '127.0.0.1' })).status, 401);
    assert.equal(
      (
        await server.request({
          Host: 'localhost',
          Authorization: 'Bearer wrong',
        })
      ).status,
      401,
    );
    const headers = { Authorization: `Bearer ${server.pairingToken}` };
    for (const Host of ['unexpected.example', '127.0.0.1:81']) {
      assert.equal((await server.request({ ...headers, Host })).status, 403);
    }
    assert.equal(
      (
        await server.request({
          ...headers,
          Host: 'localhost',
          Origin: 'http://unexpected.example',
        })
      ).status,
      403,
    );
    assert.equal(server.output.includes('UPSTREAM_REQUEST'), false);

    for (const alias of ['127.0.0.1', 'localhost', '10.0.2.2']) {
      for (const Host of [alias, `${alias}:80`]) {
        const response = await server.request({
          ...headers,
          Host,
          Origin: `http://${alias}`,
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).value, 'test-client-secret');
      }
    }
    assert.equal(
      (await server.request({ ...headers, Host: 'localhost' })).status,
      429,
    );
    assert.equal(server.output.match(/UPSTREAM_REQUEST/g)?.length, 6);
  } finally {
    server.stop();
  }
});
