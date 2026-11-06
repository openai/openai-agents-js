import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

const proxyNames = [
  'ALL_PROXY',
  'all_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
];
function supportedEnvironment() {
  if (
    process.platform !== 'linux' ||
    proxyNames.some((key) => key in process.env) ||
    'SSL_CERT_DIR' in process.env ||
    process.env.CODEX_CA_CERTIFICATE ||
    !process.env.SSL_CERT_FILE
  )
    return false;
  try {
    return !readFileSync(process.env.SSL_CERT_FILE).includes(
      'TRUSTED CERTIFICATE',
    );
  } catch {
    return false;
  }
}

function observeConnections(server: ModelServer) {
  const sockets: Socket[] = [];
  const closed: Promise<void>[] = [];
  const endpoint = (server as unknown as { server: Server }).server;
  // Prevent fixture expiry during bounded worker startup.
  endpoint.keepAliveTimeout = 30000;
  endpoint.on('connection', (socket) => {
    sockets.push(socket);
    closed.push(
      new Promise<void>((resolve) => socket.once('close', () => resolve())),
    );
  });
  return { sockets, closed };
}

async function waitForClose(closed: Promise<void>[]) {
  const timer = new AbortController();
  try {
    await Promise.race([
      Promise.all(closed),
      delay(2000, undefined, { signal: timer.signal }).then(() => {
        throw new Error('Provider close did not release its idle connection');
      }),
    ]);
  } finally {
    timer.abort();
  }
}

async function providerFor(server: ModelServer, key = 'fixture') {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: key,
    supportsWebsockets: false,
  });
}

afterEach(async () => {
  try {
    await ModelServer.closeAll();
  } finally {
    vi.restoreAllMocks();
  }
});

// Run this case in a dedicated process with the plan's scrubbed proxy environment
// and SSL_CERT_FILE fixture. Other configurations deliberately use fresh clients.
it.runIf(supportedEnvironment())(
  'reuses only the HTTP connection across independent Agent.run openings and closes it with the provider',
  async () => {
    const server = new ModelServer([[message('one')], [message('two')]]);
    const connections = observeConnections(server);
    const provider = await providerFor(server);
    const homes: { codex_home: string; cwd: string }[] = [];
    const acquire = provider._acquire.bind(provider);
    vi.spyOn(provider, '_acquire').mockImplementation((captured) => {
      const lease = acquire(captured);
      const open = lease.open.bind(lease);
      lease.open = async () => {
        const home = await open();
        homes.push(home);
        return home;
      };
      return lease;
    });
    const agent = new Agent({
      model: 'gpt-5',
      instructions: 'Answer briefly.',
      provider,
    });
    const ids: string[] = [];
    const session = agent.session.bind(agent);
    vi.spyOn(agent, 'session').mockImplementation(async (...args) => {
      const opened = await session(...args);
      ids.push(opened.id);
      return opened;
    });
    try {
      expect((await agent.run('first independent input')).finalOutput).toBe(
        'one',
      );
      expect((await agent.run('second independent input')).finalOutput).toBe(
        'two',
      );
      expect(server.requests).toHaveLength(2);
      expect(JSON.stringify(server.requests[1].input)).not.toContain(
        'first independent input',
      );
      expect(new Set(ids).size).toBe(2);
      expect(homes).toHaveLength(2);
      expect(homes[0].codex_home).not.toBe(homes[1].codex_home);
      expect(homes[0].cwd).not.toBe(homes[1].cwd);
      for (const home of homes)
        await expect(access(home.codex_home)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      expect(connections.sockets).toHaveLength(1);
      expect(connections.sockets[0].destroyed).toBe(false);
      await provider.close();
      await waitForClose(connections.closed);
      expect(connections.sockets[0].destroyed).toBe(true);
    } finally {
      await provider.close();
    }
  },
  10000,
);

it('keeps physical pools and authorization separate for different providers', async () => {
  const server = new ModelServer([[message('a')], [message('b')]]);
  const connections = observeConnections(server);
  const a = await providerFor(server, 'fixture-a');
  const b = await providerFor(server, 'fixture-b');
  try {
    expect(
      (
        await new Agent({
          model: 'gpt-5',
          instructions: 'Answer.',
          provider: a,
        }).run('a')
      ).finalOutput,
    ).toBe('a');
    expect(
      (
        await new Agent({
          model: 'gpt-5',
          instructions: 'Answer.',
          provider: b,
        }).run('b')
      ).finalOutput,
    ).toBe('b');
    expect(connections.sockets).toHaveLength(2);
    expect(
      server.requestHeaders.map((headers) => headers.authorization),
    ).toEqual(['Bearer fixture-a', 'Bearer fixture-b']);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
}, 10000);

const execute = promisify(execFile);
const builtEntry = new URL('../../dist/index.js', import.meta.url).href;

it.runIf(supportedEnvironment())(
  'exits naturally with a retained provider and idle native connection',
  async () => {
    const server = new ModelServer([[message('exit')]]);
    const connections = observeConnections(server);
    const config = await server.config();
    const base = (config['model_providers.fixture'] as { base_url: string })
      .base_url;
    const script = `
    const { Agent, NativeProvider } = await import(process.argv[1]);
    const provider = new NativeProvider({ baseUrl: process.argv[2], apiKey: 'fixture', supportsWebsockets: false });
    globalThis.retainedProvider = provider;
    const result = await new Agent({ model: 'gpt-5', instructions: 'Answer.', provider }).run('exit');
    if (result.finalOutput !== 'exit') throw new Error('wrong output');
    console.log('done');
  `;
    const output = await execute(
      process.execPath,
      ['--input-type=module', '-e', script, builtEntry, base],
      { timeout: 7000, killSignal: 'SIGKILL', maxBuffer: 16384 },
    );
    expect(output.stdout).toContain('done');
    expect(server.requests).toHaveLength(1);
    expect(connections.sockets).toHaveLength(1);
    await waitForClose(connections.closed);
  },
  10000,
);

it.runIf(supportedEnvironment())(
  'unloads a worker provider while the main native environment remains usable',
  async () => {
    const server = new ModelServer([
      [message('main one')],
      [message('worker')],
      async () => {
        // The main native environment stays alive here. Worker resource cleanup
        // must release its socket without shutting down that shared runtime.
        await waitForClose([connections.closed[1]]);
        return [message('main two')];
      },
    ]);
    const connections = observeConnections(server);
    const config = await server.config();
    const base = (config['model_providers.fixture'] as { base_url: string })
      .base_url;
    const workerScript = `
    const { workerData, parentPort } = require('node:worker_threads');
    (async () => {
      const { Agent, NativeProvider } = await import(workerData.entry);
      const provider = new NativeProvider({ baseUrl: workerData.base, apiKey: 'fixture', supportsWebsockets: false });
      globalThis.retainedProvider = provider;
      const result = await new Agent({ model: 'gpt-5', instructions: 'Answer.', provider }).run('worker');
      parentPort.postMessage(result.finalOutput);
      parentPort.close();
    })().catch((error) => { throw error; });
  `;
    const script = `
    import { Worker } from 'node:worker_threads';
    import { once } from 'node:events';
    const { Agent, NativeProvider } = await import(process.argv[1]);
    const provider = new NativeProvider({ baseUrl: process.argv[2], apiKey: 'fixture', supportsWebsockets: false });
    const agent = new Agent({ model: 'gpt-5', instructions: 'Answer.', provider });
    if ((await agent.run('main one')).finalOutput !== 'main one') throw new Error('wrong first output');
    const worker = new Worker(${JSON.stringify(workerScript)}, { eval: true, execArgv: [], workerData: { entry: process.argv[1], base: process.argv[2] } });
    const exited = once(worker, 'exit');
    if ((await once(worker, 'message'))[0] !== 'worker') throw new Error('wrong worker output');
    if ((await exited)[0] !== 0) throw new Error('worker exit failed');
    if ((await agent.run('main two')).finalOutput !== 'main two') throw new Error('main environment retired');
    await provider.close();
    console.log('done');
  `;
    const output = await execute(
      process.execPath,
      ['--input-type=module', '-e', script, builtEntry, base],
      { timeout: 7000, killSignal: 'SIGKILL', maxBuffer: 16384 },
    );
    expect(output.stdout).toContain('done');
    expect(server.requests).toHaveLength(3);
    expect(connections.sockets).toHaveLength(2);
    await waitForClose(connections.closed);
  },
  10000,
);
