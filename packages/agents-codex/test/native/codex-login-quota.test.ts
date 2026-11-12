import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { message } from './fixtures/model-server';
import {
  modelHost,
  openSavedLoginLoopback,
} from './fixtures/saved-codex-login-loopback';

const nativeIt = it.runIf(process.env.OPENAI_AGENTS_NATIVE_TESTS === '1');
// The proxy environment is authoritative for native TLS on Linux.
const savedIt = it.runIf(
  process.env.OPENAI_AGENTS_NATIVE_TESTS === '1' &&
    process.platform === 'linux',
);
const accountId = 'synthetic-workspace';
const accessToken = 'synthetic-quota-access';
const expiredAdvice = 'Wed, 01 Jan 2020 00:00:00 GMT';

type Rejection = {
  status?: 429 | 503;
  error: Record<string, string | number>;
  retryAfter: string;
};

function frame(value: object): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function reject(
  response: ServerResponse,
  rejection: Rejection,
  holdOpen: boolean,
): void {
  const error = {
    message: 'Synthetic provider rejection.',
    ...rejection.error,
  };
  if (rejection.status !== undefined) {
    response.writeHead(rejection.status, {
      'content-type': 'application/json',
      'retry-after': rejection.retryAfter,
    });
    response.end(JSON.stringify({ error }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    frame({
      type: 'response.failed',
      response: {
        id: 'rejected',
        status: 'failed',
        error: { ...error, headers: { 'Retry-After': rejection.retryAfter } },
      },
    }),
  );
  // Keep saved-login SSE failures open to exercise settlement before EOF.
  if (!holdOpen) response.end();
}

function recover(response: ServerResponse, usage?: object): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(
    frame({ type: 'response.created', response: { id: 'recovered' } }) +
      frame({
        type: 'response.output_item.done',
        output_index: 0,
        item: message('Recovered.'),
      }) +
      frame({
        type: 'response.completed',
        response: { id: 'recovered', usage },
      }),
  );
}

const savedLoginCases: (Omit<Rejection, 'retryAfter'> & {
  name: string;
  reason?: 'quota_blocked' | 'rate_limited';
  compaction?: boolean;
  useRetryPolicy?: boolean;
})[] = [
  {
    name: 'HTTP plan quota',
    status: 429,
    error: {
      type: 'usage_limit_reached',
      plan_type: 'pro',
      resets_at: 2_000_000_000,
    },
    reason: 'quota_blocked',
  },
  {
    name: 'HTTP request throttle',
    status: 429,
    error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' },
    reason: 'rate_limited',
  },
  {
    name: 'HTTP slow_down',
    status: 503,
    error: { type: 'rate_limit_error', code: 'slow_down' },
    reason: 'rate_limited',
  },
  {
    name: 'held-open SSE quota',
    error: { code: 'insufficient_quota' },
    reason: 'quota_blocked',
  },
  {
    name: 'held-open SSE quota with an accepting policy',
    error: { code: 'insufficient_quota' },
    reason: 'quota_blocked',
    useRetryPolicy: true,
  },
  {
    name: 'held-open SSE throttle',
    error: { code: 'rate_limit_exceeded' },
    reason: 'rate_limited',
  },
  {
    name: 'autocompact-quota',
    error: { code: 'insufficient_quota' },
    reason: 'quota_blocked',
    compaction: true,
  },
  {
    name: 'ordinary HTTP overload',
    status: 503,
    error: { code: 'server_is_overloaded' },
  },
];

savedIt.each(savedLoginCases)(
  'settles saved-login $name with its expected retry policy',
  async ({ status, error, reason, compaction, useRetryPolicy }) => {
    const directory = await mkdtemp(join(tmpdir(), 'agents-quota-login-'));
    const codexHome = join(directory, 'login');
    const home = join(directory, 'home');
    const failures: string[] = [];
    const threads: string[] = [];
    let compactionRequests = 0;
    try {
      await Promise.all([mkdir(codexHome), mkdir(home)]);
      const claims = Buffer.from(
        JSON.stringify({
          'https://api.openai.com/auth': {
            chatgpt_user_id: 'synthetic-quota-user',
            chatgpt_account_id: accountId,
            chatgpt_plan_type: 'pro',
          },
        }),
      ).toString('base64url');
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: null,
          tokens: {
            id_token: `e30.${claims}.synthetic`,
            access_token: accessToken,
            refresh_token: 'synthetic-quota-refresh',
            account_id: accountId,
          },
          last_refresh: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      const rejection = {
        status,
        error,
        retryAfter:
          status === undefined ? expiredAdvice : reason ? '3600' : '0',
      };
      await using peer = await openSavedLoginLoopback({
        directory,
        home,
        failures,
        onRequest(request, response) {
          request.resume();
          const fail = (reason: string) => {
            failures.push(reason);
            response.writeHead(400).end();
          };
          if (request.headers.host?.split(':')[0] !== modelHost)
            return fail('Unexpected provider host');
          if (
            request.headers.authorization !== `Bearer ${accessToken}` ||
            request.headers['chatgpt-account-id'] !== accountId
          )
            return fail('Unexpected saved-login identity');
          const path = request.url?.split('?')[0];
          if (
            request.method === 'GET' &&
            path === '/backend-api/codex/models'
          ) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ models: [] }));
            return;
          }
          if (
            request.method !== 'POST' ||
            path !== '/backend-api/codex/responses'
          )
            return fail('Unexpected provider route');
          const thread = request.headers['thread-id'];
          if (typeof thread !== 'string' || !thread)
            return fail('Missing inference thread ID');
          threads.push(thread);
          if (compaction) {
            const header = request.headers['x-codex-turn-metadata'];
            if (typeof header !== 'string')
              return fail('Missing turn metadata');
            let metadata;
            try {
              metadata = JSON.parse(header);
            } catch {
              return fail('Invalid turn metadata');
            }
            if (threads.length === 1 && metadata?.request_kind === 'turn') {
              return recover(response, {
                input_tokens: 260_000,
                output_tokens: 1_000,
                total_tokens: 261_000,
              });
            }
            if (
              metadata?.request_kind !== 'compaction' ||
              metadata.compaction?.trigger !== 'auto' ||
              metadata.compaction?.phase !== 'pre_turn' ||
              metadata.compaction?.implementation !== 'responses'
            )
              return fail('Expected local automatic pre-turn compaction');
            compactionRequests++;
            return reject(response, rejection, true);
          }
          // A replay would make the first Turn succeed instead of returning
          // attention. The child checks which Turn observes the success.
          if (threads.length === 1) reject(response, rejection, true);
          else recover(response);
        },
      });
      const child = fileURLToPath(
        new URL('./fixtures/codex-login-quota-child.mjs', import.meta.url),
      );
      const expected = reason
        ? {
            reason,
            compaction,
            useRetryPolicy,
            rateLimits:
              status === undefined
                ? { retryAt: '2020-01-01T00:00:00.000Z' }
                : { retryAfterSeconds: 3600 },
          }
        : null;
      try {
        await peer.runChild(child, [
          codexHome,
          accountId,
          JSON.stringify(expected),
        ]);
      } catch (error) {
        const { stdout: stage, killed } = error as {
          stdout?: string;
          killed?: boolean;
        };
        const detail =
          stage && /^[a-zA-Z ]+$/.test(stage) ? ` at ${stage}` : '';
        throw new Error(
          `Saved-login child ${killed ? 'timed out' : 'failed'}${detail}. ` +
            `CONNECTs=${peer.tunnels.length}, inference requests=${threads.length}. ` +
            (compaction
              ? `Automatic compaction requests=${compactionRequests}. `
              : '') +
            failures.join('. '),
        );
      }
      expect(failures).toEqual([]);
      expect(peer.tunnels).toContain(`${modelHost}:443`);
      if (compaction) expect(compactionRequests).toBe(1);
      expect(threads).toHaveLength(useRetryPolicy ? 1 : 2);
      if (!useRetryPolicy) expect(threads[1]).toBe(threads[0]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  25_000,
);

nativeIt.each([
  { name: 'HTTP slow_down', status: 503, code: 'slow_down' },
  { name: 'streamed throttle', status: undefined, code: 'rate_limit_exceeded' },
] as const)(
  'preserves API-key retry and recovery for $name',
  async ({ status, code }) => {
    const requests: {
      authorization?: string;
      account?: string | string[];
      path?: string;
    }[] = [];
    const server = createServer((request, response) => {
      request.once('end', () => {
        requests.push({
          authorization: request.headers.authorization,
          account: request.headers['chatgpt-account-id'],
          path: request.url,
        });
        if (requests.length === 1)
          reject(response, { status, error: { code }, retryAfter: '0' }, false);
        else recover(response);
      });
      request.resume();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Provider fixture did not bind');
      await using provider = new NativeProvider({
        apiKey: 'synthetic-quota-api-key',
        baseUrl: `http://127.0.0.1:${address.port}`,
        supportsWebsockets: false,
        requestMaxRetries: status === 503 ? 1 : 0,
        streamMaxRetries: status === undefined ? 1 : 0,
      });
      await using session = await new Agent({
        instructions: 'Reply.',
        model: 'gpt-5.1-codex',
        provider,
      }).session();

      const turn = await session.submit('Reply.');
      expect((await turn.wait()).finalOutput).toBe('Recovered.');
      const request = {
        authorization: 'Bearer synthetic-quota-api-key',
        account: undefined,
        path: '/responses',
      };
      expect(requests).toEqual([request, request]);
    } finally {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
  },
  15_000,
);
