import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  openCodexAppServer,
  type CodexAppServer,
} from '../../../src/experimental/codex/appServer';

const servers: CodexAppServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// Real child processes exercise JSONL framing, pipe backpressure and termination.
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-app-server-'));
  directories.push(cwd);
  // The Node executable treats the transport's app-server argument as this script.
  await writeFile(
    join(cwd, 'app-server'),
    `const {createInterface} = require('node:readline');
const {basename} = require('node:path');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let delayed;
createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 const {id, method, params} = request;
 if (method === 'inspect') send({id,result:{cwd:process.cwd(),args:[basename(process.argv[1]),...process.argv.slice(2)],env:process.env,pid:process.pid}});
 if (method === 'delay') delayed = id;
 if (method === 'ordered') {
  send({method:'item/delta',params:{text:'first'}});
  send({id,result:'second'});
  send({id:delayed,result:'first'});
  send({method:'turn/completed',params:{status:'completed'}});
 }
 if (method === 'notify') send({method:'notified',params});
 if (method === 'rpc-error') send({id,error:{code:-1,message:'private-rpc-secret'}});
 if (method === 'malformed') { process.stderr.write('private-stderr-secret'); process.stdout.write('private-invalid-secret\\n'); }
 if (method === 'exit') process.exit(7);
 if (method === 'stderr') { process.stderr.write('x'.repeat(300000)); send({id,result:'drained'}); }
 if (method === 'resist') { process.on('SIGTERM', () => {}); send({id,result:process.pid}); }
});
`,
  );
  return {
    cwd,
    codexOptions: {
      codexPathOverride: relative(process.cwd(), process.execPath),
    },
  };
}

async function open(options: Parameters<typeof openCodexAppServer>[0] = {}) {
  const server = await openCodexAppServer(options);
  servers.push(server);
  return server;
}

test('preserves Codex option precedence, replacement env, working directory and notifications', async () => {
  const { cwd, codexOptions } = await fixture();
  const server = await open({
    cwd,
    codexOptions: {
      ...codexOptions,
      env: { FIXTURE_ENV: 'isolated', CODEX_API_KEY: 'old' },
      apiKey: 'fixture-key',
      config: {
        model: 'example',
        features: { apps: true },
        providers: [{ name: 'test provider' }],
        empty: {},
      },
      configOverrides: [
        'cli_auth_credentials_store="file"',
        'model="raw"',
        'web_search="cached"',
        'openai_base_url="raw-url"',
      ],
      baseUrl: 'http://fixture.invalid',
    },
  });
  const result = (await server.request('inspect')) as {
    cwd: string;
    args: string[];
    env: Record<string, string>;
  };
  expect(result.cwd).toBe(cwd);
  expect(result.args).toEqual([
    'app-server',
    '--config',
    'features.apps=false',
    '--config',
    'web_search="disabled"',
    '--config',
    'model="example"',
    '--config',
    'features.apps=true',
    '--config',
    'providers=[{name = "test provider"}]',
    '--config',
    'empty={}',
    '--config',
    'cli_auth_credentials_store="file"',
    '--config',
    'model="raw"',
    '--config',
    'web_search="cached"',
    '--config',
    'openai_base_url="raw-url"',
    '--config',
    'openai_base_url="http://fixture.invalid"',
    '--config',
    'cli_auth_credentials_store="ephemeral"',
  ]);
  expect(result.env).toMatchObject({
    FIXTURE_ENV: 'isolated',
    CODEX_API_KEY: 'old',
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_sdk_ts',
  });
  expect(result.env.HOME).toBeUndefined();
  server.notify('notify', { ready: true });
  expect(await server.events[Symbol.asyncIterator]().next()).toEqual({
    done: false,
    value: { method: 'notified', params: { ready: true } },
  });
});

test('matches out-of-order responses while preserving interleaved notifications', async () => {
  const server = await open(await fixture());
  const first = server.request('delay');
  const second = server.request('ordered');
  expect(await Promise.all([first, second])).toEqual(['first', 'second']);
  const iterator = server.events[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual({
    method: 'item/delta',
    params: { text: 'first' },
  });
  expect((await iterator.next()).value).toEqual({
    method: 'turn/completed',
    params: { status: 'completed' },
  });
  await server.close();
  expect((await iterator.next()).done).toBe(true);
});

test('drains stderr without exposing RPC or malformed protocol contents', async () => {
  const server = await open(await fixture());
  expect(await server.request('stderr')).toBe('drained');
  await expect(server.request('rpc-error')).rejects.toThrow(
    /^Codex App Server request failed\.$/,
  );
  const event = server.events[Symbol.asyncIterator]().next();
  const response = server.request('malformed');
  await expect(response).rejects.toThrow(
    /^Invalid Codex App Server protocol message\.$/,
  );
  await expect(event).rejects.toThrow(
    /^Invalid Codex App Server protocol message\.$/,
  );
});

test('rejects pending requests and event reads on unexpected exit', async () => {
  const server = await open(await fixture());
  const event = server.events[Symbol.asyncIterator]().next();
  await expect(server.request('exit')).rejects.toThrow(
    'Codex App Server exited.',
  );
  await expect(server.request('after-exit')).rejects.toMatchObject({
    code: 'CODEX_APP_SERVER_EXITED',
  });
  await expect(event).rejects.toThrow('Codex App Server exited.');
});

test('aborts pending requests promptly and awaits actual process termination', async () => {
  const options = await fixture();
  const controller = new AbortController();
  const server = await open({
    ...options,
    signal: controller.signal,
  });
  const pid = ((await server.request('inspect')) as { pid: number }).pid;
  const response = server.request('delay');
  const event = server.events[Symbol.asyncIterator]().next();
  controller.abort();
  await expect(response).rejects.toMatchObject({ name: 'AbortError' });
  await expect(event).rejects.toMatchObject({ name: 'AbortError' });
  await server.close();
  expect(() => process.kill(pid, 0)).toThrow();
  await expect(server.request('inspect')).rejects.toMatchObject({
    name: 'AbortError',
  });
});

test('idempotently closes and force-terminates an uncooperative child', async () => {
  const server = await open(await fixture());
  const pid = (await server.request('resist')) as number;
  const pending = server.request('delay');
  const rejected = expect(pending).rejects.toThrow('Codex App Server closed.');
  await Promise.all([server.close(), server.close(), rejected]);
  expect(() => process.kill(pid, 0)).toThrow();
});

test('reports spawn failures without an unhandled process error', async () => {
  await expect(
    open({ codexOptions: { codexPathOverride: '/nonexistent-codex-fixture' } }),
  ).rejects.toThrow('Unable to run Codex App Server.');
});

test('does not launch for an already-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(open({ signal: controller.signal })).rejects.toMatchObject({
    name: 'AbortError',
  });
});
