import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { call, message } from './fixtures/model-server';

const execute = promisify(execFile);
const modelHost = 'chatgpt.com';
const authHost = 'auth.openai.com';
const apiHost = 'api.openai.com';
const realtimeKey = 'synthetic-realtime-key';
const accountId = 'synthetic-workspace';
const sessionCount = 3;
const hostGuidance = 'SYNTHETIC_SAVED_LOGIN_HOST_GUIDANCE';
const expiredAccess = 'synthetic-expired-access';
const savedRefresh = 'synthetic-saved-refresh';
const rotatedAccess = 'synthetic-rotated-access';
const rotatedRefresh = 'synthetic-rotated-refresh';
type Mode =
  | 'mismatch'
  | 'cancel-refresh'
  | 'cancel-all-refresh'
  | 'stalled-refresh'
  | 'restart'
  | 'repair'
  | 'realtime'
  | 'overlap'
  | 'hosted-media'
  | 'code'
  | 'local';

async function certificates(directory: string) {
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
    `subjectAltName=DNS:${modelHost},DNS:${authHost},DNS:${apiHost}\nextendedKeyUsage=serverAuth\n`,
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

function json(response: ServerResponse, status: number, body: object) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

// On Linux native proxy resolution uses the child environment. System proxy
// settings can take precedence on macOS and Windows.
it.runIf(
  process.env.OPENAI_AGENTS_NATIVE_TESTS === '1' &&
    process.platform === 'linux',
)(
  'finishes saved login rotation after Turn cancellation, isolates Realtime auth, and restores configured execution',
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'agents-saved-codex-login-')),
    );
    const sockets = new Set<Socket>();
    const servers: Server[] = [];
    const failures: string[] = [];
    const tunnels: string[] = [];
    const expired = new Map<string, number>();
    let rounds = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const rotated: string[] = [];
    let grantConsumed = Promise.withResolvers<void>();
    const realtimeRoutes: string[] = [];
    let grantCount = 0;
    let restarting = false;
    let execution:
      | 'repair'
      | 'overlap'
      | 'code'
      | 'local'
      | 'stalled-refresh'
      | 'hosted-media'
      | undefined;
    let cancelAll = false;
    let stalledGrantClosed = false;
    let hostedMediaRequests = 0;
    let executionRequests = 0;
    try {
      const codexHome = join(directory, 'copied-login');
      const sourceHome = join(directory, 'source-login');
      const home = join(directory, 'isolated-home');
      const grantDirectories = ['workspace', 'extra', 'mount'].map((name) =>
        join(directory, name),
      );
      await Promise.all(
        [codexHome, sourceHome, home, ...grantDirectories].map((path) =>
          mkdir(path),
        ),
      );
      const hostCodexHome = join(home, '.codex');
      await mkdir(hostCodexHome);
      await writeFile(join(hostCodexHome, 'AGENTS.md'), hostGuidance);
      const loginAlias = join(directory, 'login-alias');
      await symlink(codexHome, loginAlias);
      const source = join(sourceHome, 'auth.json');
      const cache = join(codexHome, 'auth.json');
      const claims = Buffer.from(
        JSON.stringify({
          'https://api.openai.com/auth': {
            chatgpt_account_id: accountId,
            chatgpt_user_id: 'synthetic-user',
            chatgpt_plan_type: 'pro',
          },
        }),
      ).toString('base64url');
      const original = {
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          id_token: `e30.${claims}.synthetic`,
          access_token: expiredAccess,
          refresh_token: savedRefresh,
          account_id: accountId,
        },
        last_refresh: new Date(Date.now() - 60_000).toISOString(),
      };
      const credentialMarkers = [
        original.tokens.id_token,
        expiredAccess,
        savedRefresh,
        rotatedAccess,
        rotatedRefresh,
      ];
      const privateLoginPaths = [
        codexHome,
        sourceHome,
        loginAlias,
        join(directory, 'relocated-login'),
      ];
      const sourceBytes = JSON.stringify(original);
      await writeFile(source, sourceBytes, { mode: 0o600 });
      await copyFile(source, cache);

      const tls = createTlsServer(await certificates(directory));
      const voice = new WebSocketServer({ noServer: true });
      tls.on('upgrade', (request, socket, head) => {
        const url = new URL(
          request.url ?? '/',
          `https://${request.headers.host}`,
        );
        if (
          url.hostname !== apiHost ||
          url.pathname !== '/v1/realtime' ||
          request.headers.authorization !== `Bearer ${realtimeKey}` ||
          request.headers['chatgpt-account-id'] !== undefined
        ) {
          failures.push(
            'Unexpected Realtime upgrade origin, route or credential',
          );
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          return;
        }
        realtimeRoutes.push(url.origin + url.pathname);
        voice.handleUpgrade(request, socket, head, (connection) => {
          connection.on('message', (raw) => {
            const event = JSON.parse(raw.toString());
            if (event.type === 'session.update') {
              connection.send(
                JSON.stringify({
                  type: 'session.updated',
                  session: {
                    model: url.searchParams.get('model'),
                    ...event.session,
                    id: 'synthetic-saved-login-voice',
                  },
                }),
              );
            }
          });
        });
      });
      servers.push(tls);
      tls.on('request', async (request, response) => {
        const fail = (reason: string) => {
          request.resume();
          failures.push(reason);
          json(response, 400, { error: { message: reason } });
        };
        const host = request.headers.host?.split(':')[0];
        const path = request.url?.split('?')[0];
        if (request.headers.authorization === `Bearer ${realtimeKey}`) {
          request.resume();
          return fail('Realtime key used on a non-Realtime HTTP route');
        }
        if (
          host === authHost &&
          request.method === 'POST' &&
          path === '/oauth/token'
        ) {
          ++grantCount;
          if (grantCount !== 1 || restarting) {
            request.resume();
            return fail('Unexpected additional refresh grant');
          }
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const grant = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (
              grant.grant_type !== 'refresh_token' ||
              grant.refresh_token !== savedRefresh
            ) {
              return fail('Unexpected refresh grant payload');
            }
          } catch {
            return fail('Invalid refresh grant payload');
          }
          const tokenResponse = {
            access_token: rotatedAccess,
            refresh_token: rotatedRefresh,
          };
          if (execution === 'stalled-refresh') {
            response.once('close', () => {
              stalledGrantClosed = true;
            });
            response.writeHead(200, { 'content-type': 'application/json' });
            // Send valid JSON without ending the chunked response body.
            response.write(JSON.stringify(tokenResponse));
            await writeFile(join(directory, 'grant-consumed'), '');
            return;
          }
          await writeFile(join(directory, 'grant-consumed'), '');
          grantConsumed.resolve();
          const deadline = Date.now() + 10_000;
          while (
            !(await readFile(join(directory, 'turn-cancelled'), 'utf8').catch(
              () => undefined,
            ))
          ) {
            if (Date.now() >= deadline)
              return fail('Waiting Turns did not cancel');
            await delay(10);
          }
          if (cancelAll) {
            while (
              !(await readFile(join(directory, 'owner-closing')).catch(
                () => undefined,
              ))
            ) {
              if (Date.now() >= deadline)
                return fail('The refresh owner did not start closing');
              await delay(10);
            }
            await delay(250);
            if (
              await readFile(join(directory, 'owner-closed')).catch(
                () => undefined,
              )
            )
              return fail('The refresh owner closed before OAuth responded');
            if ((await readFile(cache, 'utf8')) !== sourceBytes)
              return fail('The cache changed before OAuth responded');
          }
          if (response.socket?.destroyed) {
            failures.push(
              'Canceling the winning Turn dropped its OAuth request',
            );
            return;
          }
          return json(response, 200, tokenResponse);
        }

        if (host !== modelHost) return fail('Unexpected TLS request host');
        if (request.headers['chatgpt-account-id'] !== accountId) {
          return fail('Incorrect ChatGPT account header');
        }
        if (execution === 'overlap')
          return fail('Overlapping grant dispatched');
        const authorization = request.headers.authorization;
        if (
          authorization !== `Bearer ${expiredAccess}` &&
          authorization !== `Bearer ${rotatedAccess}`
        ) {
          return fail('Unexpected model authorization');
        }
        if (request.method === 'GET' && path === '/backend-api/codex/models') {
          request.resume();
          return json(response, 200, { models: [] });
        }
        if (
          request.method !== 'POST' ||
          path !== '/backend-api/codex/responses'
        ) {
          const route = path?.match(/^\/(backend-api|oauth)\/[a-z/_-]+$/)?.[0];
          return fail(`Unexpected ChatGPT route ${route ?? '(unknown)'}`);
        }
        if (execution === 'repair')
          return fail('Unsupported repair configuration dispatched a request');
        if (execution === 'hosted-media' || execution === 'local') {
          // The saved-login provider sends plain JSON on this route.
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = Buffer.concat(chunks).toString('utf8');
            const { input, tools } = JSON.parse(body) as {
              input: {
                role?: string;
                content?: { type: string; text?: string }[];
              }[];
              tools: { type: string; name?: string }[];
            };
            if (credentialMarkers.some((marker) => body.includes(marker))) {
              return fail('Saved-login request contained credential material');
            }
            if (execution === 'local') {
              if (privateLoginPaths.some((path) => body.includes(path))) {
                return fail('Configured local request contained a login path');
              }
              const hasContext = (role: string, tag: string) =>
                input.some(
                  (item) =>
                    item.role === role &&
                    item.content?.some(
                      (content) =>
                        content.type === 'input_text' &&
                        content.text?.includes(tag),
                    ),
                );
              if (
                executionRequests === 0 &&
                (!hasContext('developer', '<permissions instructions>') ||
                  !hasContext('user', '<environment_context>'))
              ) {
                return fail(
                  'Configured local request omitted world-state context',
                );
              }
            } else {
              if (!JSON.stringify(input)?.includes(hostGuidance)) {
                return fail(
                  'Saved-login request omitted opted-in AGENTS.md guidance',
                );
              }
              if (
                !tools.some((tool) => tool.type === 'web_search') ||
                !tools.some((tool) => tool.type === 'image_generation') ||
                tools.some(
                  (tool) => tool.name === 'web' || tool.name === 'image_gen',
                )
              ) {
                return fail('Unexpected saved-login media tools');
              }
              ++hostedMediaRequests;
            }
          } catch {
            return fail('Invalid saved-login Responses payload');
          }
        } else {
          request.resume();
        }
        const thread = request.headers['thread-id'];
        if (typeof thread !== 'string' || !thread)
          return fail('Missing Responses thread ID');
        if (authorization === `Bearer ${expiredAccess}`) {
          if (execution === 'stalled-refresh') {
            return json(response, 401, { error: { message: 'Expired' } });
          }
          const attempt = (expired.get(thread) ?? 0) + 1;
          const round = rounds[attempt - 1];
          if (
            restarting ||
            !round ||
            (!expired.has(thread) && expired.size === sessionCount)
          ) {
            return fail('Unexpected request with the expired login');
          }
          expired.set(thread, attempt);
          // Native recovery reloads after the first 401 and refreshes after the second.
          if (
            [...expired.values()].filter((count) => count >= attempt).length ===
            sessionCount
          ) {
            round.resolve();
          }
          await round.promise;
          if (
            attempt === 2 &&
            thread !==
              (await readFile(join(directory, 'refresh-winner'), 'utf8'))
          ) {
            await grantConsumed.promise;
          }
          return json(response, 401, { error: { message: 'Expired' } });
        }
        rotated.push(thread);
        let item = message('Accepted rotated login.');
        if (execution === 'code') {
          if (++executionRequests > 2)
            return fail('Unexpected Code Mode request');
          item =
            executionRequests === 1
              ? {
                  type: 'custom_tool_call',
                  name: 'exec',
                  call_id: 'saved-login-cell',
                  input:
                    "store('savedLoginFixture', 'ran'); text('cell completed');",
                }
              : message('Accepted Code Mode.');
        } else if (execution === 'local') {
          if (++executionRequests > 4) return fail('Unexpected local request');
          item =
            executionRequests === 1
              ? call(
                  'exec_command',
                  { cmd: 'printf local-effect >> effect.txt' },
                  { callId: 'saved-login-command' },
                )
              : message('Accepted configured local execution.');
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of [
          {
            type: 'response.output_item.done',
            output_index: 0,
            item,
          },
          {
            type: 'response.completed',
            response: { id: `rotated-${rotated.length}` },
          },
        ]) {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        response.end();
      });
      const tlsPort = await listen(tls, sockets);

      const allowed = new Set([
        `${modelHost}:443`,
        `${authHost}:443`,
        `${apiHost}:443`,
      ]);
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
        target.on('error', () => socket.destroy());
        target.once('close', () => socket.destroy());
        socket.once('close', () => target.destroy());
      });
      const proxyUrl = `http://127.0.0.1:${await listen(proxy, sockets)}`;
      const ca = join(directory, 'ca.pem');
      const child = fileURLToPath(
        new URL('./fixtures/saved-codex-login-child.mjs', import.meta.url),
      );
      const optionalLocalSandbox =
        process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1' &&
        process.env.GITHUB_ACTIONS !== 'true' &&
        process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1';
      const run = async (mode: Mode) => {
        let stdout: string;
        try {
          const loginHome =
            mode === 'stalled-refresh'
              ? sourceHome
              : mode === 'overlap' || mode === 'local'
                ? loginAlias
                : codexHome;
          ({ stdout } = await execute(
            process.execPath,
            [
              child,
              loginHome,
              accountId,
              mode,
              ...(mode === 'local' && optionalLocalSandbox
                ? ['optional-sandbox']
                : []),
            ],
            {
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
              timeout:
                mode === 'local' || mode === 'stalled-refresh'
                  ? 25_000
                  : 15_000,
              killSignal: 'SIGKILL',
            },
          ));
        } catch (error) {
          const { stdout: stage, killed } = error as {
            stdout?: string;
            killed?: boolean;
          };
          const detail =
            stage && /^[a-zA-Z ]+$/.test(stage) ? ` at ${stage}` : '';
          throw new Error(
            `Saved login ${mode} child ${killed ? 'timed out' : 'failed'}${detail}. ` +
              `CONNECTs=${tunnels.length}, expired attempts=[${[...expired.values()]}], ` +
              `grants=${grantCount}, rotated requests=${rotated.length}. ${failures.join('. ')}`,
          );
        }
        expect(failures).toEqual([]);
        return stdout;
      };

      await run('mismatch');
      expect(tunnels).toHaveLength(0);
      execution = 'repair';
      await run('repair');
      execution = undefined;

      for (const mode of ['cancel-refresh', 'cancel-all-refresh'] as const) {
        cancelAll = mode === 'cancel-all-refresh';
        if (cancelAll) {
          restarting = false;
          grantCount = 0;
          expired.clear();
          rotated.length = 0;
          rounds = rounds.map(() => Promise.withResolvers<void>());
          grantConsumed = Promise.withResolvers<void>();
          await Promise.all([
            copyFile(source, cache),
            ...['refresh-winner', 'grant-consumed', 'turn-cancelled'].map(
              (file) => rm(join(directory, file)),
            ),
          ]);
        }

        await run(mode);
        expect([...expired.values()]).toEqual([2, 2, 2]);
        if (cancelAll) {
          expect(rotated).toHaveLength(0);
          expect(await readFile(join(directory, 'owner-closed'), 'utf8')).toBe(
            'yes',
          );
        } else {
          const cancelled = await readFile(
            join(directory, 'refresh-winner'),
            'utf8',
          );
          expect(rotated).toHaveLength(sessionCount - 1);
          expect(new Set(rotated)).toEqual(
            new Set(
              [...expired.keys()].filter((thread) => thread !== cancelled),
            ),
          );
        }
        expect(grantCount).toBe(1);
        expect(tunnels).toContain(`${authHost}:443`);
        expect(tunnels).toContain(`${modelHost}:443`);
        const persisted = await readFile(cache, 'utf8')
          .then((bytes) => JSON.parse(bytes))
          .catch(() => {
            throw new Error('Unable to read the copied login cache as JSON');
          });
        expect(
          persisted.tokens?.access_token === rotatedAccess,
          'access token should rotate',
        ).toBe(true);
        expect(
          persisted.tokens?.refresh_token === rotatedRefresh,
          'refresh token should rotate',
        ).toBe(true);
        expect(
          persisted.tokens?.id_token === original.tokens.id_token,
          'login owner should persist',
        ).toBe(true);
        expect(
          persisted.tokens?.account_id === accountId,
          'login account should persist',
        ).toBe(true);
        expect(Date.parse(persisted.last_refresh)).toBeGreaterThan(
          Date.parse(original.last_refresh),
        );

        restarting = true;
        const beforeRestart = rotated.length;
        await run('restart');
        expect(rotated).toHaveLength(beforeRestart + 1);
        expect(grantCount).toBe(1);
      }

      execution = 'stalled-refresh';
      restarting = false;
      grantCount = 0;
      await rm(join(directory, 'grant-consumed'));
      const beforeStall = rotated.length;
      await run('stalled-refresh');
      expect(stalledGrantClosed).toBe(true);
      expect(grantCount).toBe(1);
      expect(rotated).toHaveLength(beforeStall + 1);
      restarting = true;

      execution = 'hosted-media';
      await symlink(cache, join(hostCodexHome, 'AGENTS.override.md'));
      await run('hosted-media');
      expect(hostedMediaRequests).toBe(1);
      execution = undefined;

      const tunnelsBeforeRealtime = tunnels.length;
      await run('realtime');
      expect(realtimeRoutes).toEqual([`https://${apiHost}/v1/realtime`]);
      expect(tunnels.slice(tunnelsBeforeRealtime)).toContain(`${apiHost}:443`);

      execution = 'overlap';
      const tunnelsBeforeOverlap = tunnels.length;
      await run('overlap');
      expect(tunnels).toHaveLength(tunnelsBeforeOverlap);

      execution = 'code';
      await run('code');
      expect(executionRequests).toBe(2);

      execution = 'local';
      executionRequests = 0;
      const localResult = await run('local');
      expect(executionRequests).toBe(
        optionalLocalSandbox && localResult === 'local sandbox unavailable'
          ? 0
          : 4,
      );
      expect(grantCount).toBe(1);
      expect(
        (await readFile(source, 'utf8')) === sourceBytes,
        'source login should stay intact',
      ).toBe(true);
    } finally {
      for (const round of rounds) round.resolve();
      grantConsumed.resolve();
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        servers
          .filter((server) => server.listening)
          .map(
            (server) =>
              new Promise<void>((resolve) => server.close(() => resolve())),
          ),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
  110_000,
);
