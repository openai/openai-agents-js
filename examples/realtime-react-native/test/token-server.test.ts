import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { test } from 'vitest';

const serverUrl = new URL('../scripts/token-server.mjs', import.meta.url).href;

async function startServer(host: string) {
  const port = await new Promise<number>((resolve, reject) => {
    const reservation = createServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const selectedPort = (reservation.address() as AddressInfo).port;
      reservation.close(() => resolve(selectedPort));
    });
  });
  const script = `
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
      PORT: String(port),
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
    get output() {
      return output;
    },
    pairingToken: output.match(/Pairing token: ([A-Za-z0-9_-]+)/)?.[1],
    request: (headers?: Record<string, string>) =>
      fetch(`http://127.0.0.1:${port}/token`, { method: 'POST', headers }),
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

test('loopback emulator requests still work without pairing', async () => {
  const server = await startServer('127.0.0.1');
  try {
    assert.equal((await server.request()).status, 200);
  } finally {
    server.stop();
  }
});
