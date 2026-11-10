import { afterEach, expect, it } from 'vitest';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent as HttpAgent, createServer, get, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, Environment, NativeProvider, NetworkPolicy } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';
import type { Session } from '../../src';

afterEach(() => ModelServer.closeAll());

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-network-policy',
    supportsWebsockets: false,
  });
}

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

async function refusesOpening(opening: Promise<Session>, message: string) {
  let opened: Session | undefined;
  try {
    await expect(
      opening.then((session) => {
        opened = session;
        return session;
      }),
    ).rejects.toThrow(message);
  } finally {
    await opened?.close();
  }
}

// Use the native proxy explicitly. The allowlist case also checks that direct
// connections fail when local binding is disabled.
const probe = `import errno, os, socket, sys
from contextlib import closing
from http.client import HTTPConnection
from urllib.parse import urlsplit
mode, allowed, overlap, unlisted = sys.argv[1:]
allow_all = mode == "allow-all"
proxy = urlsplit(os.environ["HTTP_PROXY"])
for url, expected in [(allowed, 200), (overlap, 403), (unlisted, 200 if allow_all else 403)]:
    with closing(HTTPConnection(proxy.hostname, proxy.port, timeout=3)) as connection:
        connection.request("GET", url)
        response = connection.getresponse()
        assert response.status == expected, (url, response.status)
        if expected == 200:
            assert response.read() == urlsplit(url).hostname.encode("ascii")
        if url == overlap:
            assert response.getheader("x-proxy-error") == "blocked-by-denylist", response.getheaders()
if not allow_all:
    target = urlsplit(allowed)
    try:
        with socket.create_connection((target.hostname, target.port), timeout=3):
            raise AssertionError("Direct connection to allowed destination succeeded")
    except OSError as error:
        assert error.errno in (errno.EPERM, errno.ECONNREFUSED, errno.ENETUNREACH, errno.EHOSTUNREACH), error
print("managed-network-probe-passed")
`;

it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'uses advertised remote platform and proxy capability rather than controller platform',
  async () => {
    // These two replies are deliberately changed fixture metadata. Actual
    // enforcement is exercised separately with the unmodified executor.
    for (const environmentInfoOverride of [
      { platformOs: 'windows' },
      { networkProxyLaunch: false },
    ]) {
      const executor = await startPublicExecutor({ environmentInfoOverride });
      const server = new ModelServer([]);
      const provider = await providerFor(server);
      try {
        const agent = new Agent({
          instructions: 'No work before admission.',
          provider,
        });
        await refusesOpening(
          agent.session({
            environment: new Environment({
              url: executor.url,
              cwd: executor.cwd,
              headers: executor.headers,
              // Isolate network admission from strict write-policy validation.
              writePolicy: 'legacy',
              tools: ['exec_command'],
              network: { allowAllUnixSockets: true },
            }),
          }),
          'managed proxy launch',
        );
        expect(server.requests).toHaveLength(0);
        expect(
          executor.requests.filter(
            (request) => request.method === 'process/start',
          ),
        ).toHaveLength(0);
      } finally {
        try {
          await provider.close();
        } finally {
          await executor.close();
        }
      }
    }
  },
  30_000,
);

it.skipIf(
  process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1' ||
    process.platform !== 'linux',
)(
  'refuses unsupported socket consent and workspace conventions before model or command effects',
  async () => {
    const executor = await startPublicExecutor();
    const server = new ModelServer([]);
    const provider = await providerFor(server);
    try {
      const agent = new Agent({
        instructions: 'No work before admission.',
        provider,
      });
      for (const option of [
        {
          cwd: executor.cwd,
          network: {},
          error: 'Linux requires explicit access to all Unix sockets',
        },
        {
          cwd: 'C:\\job',
          network: { allowAllUnixSockets: true },
          error: 'POSIX executor workspace',
        },
      ]) {
        await refusesOpening(
          agent.session({
            environment: new Environment({
              url: executor.url,
              headers: executor.headers,
              // Isolate network admission from strict write-policy validation.
              writePolicy: 'legacy',
              tools: ['exec_command'],
              cwd: option.cwd,
              network: option.network,
            }),
          }),
          option.error,
        );
        expect(server.requests).toHaveLength(0);
        expect(
          executor.requests.filter(
            (request) => request.method === 'process/start',
          ),
        ).toHaveLength(0);
      }
      server.assertExhausted();
    } finally {
      try {
        await provider.close();
      } finally {
        await executor.close();
      }
    }
  },
  30_000,
);

it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'refuses escalated commands before approval or executor effects under a managed policy',
  async () => {
    const executor = await startPublicExecutor();
    const target = join(executor.cwd, 'escalation-must-not-write');
    const server = new ModelServer([
      [
        call(
          'exec_command',
          {
            cmd: `printf escaped > ${shellQuote(target)}`,
            sandbox_permissions: 'require_escalated',
            justification: 'Fixture-owned forbidden escalation',
          },
          { callId: 'forbidden-escalation' },
        ),
      ],
      [message('refused')],
    ]);
    const provider = await providerFor(server);
    try {
      await using session = await new Agent({
        instructions: 'Try the requested command once, then finish.',
        provider,
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command'],
          network: { allowAllUnixSockets: true },
        }),
      });
      const outcome = await (
        await session.submit('Try.')
      ).wait({
        until: 'interaction',
        signal: AbortSignal.timeout(10_000),
      });
      expect(outcome).toHaveProperty('finalOutput', 'refused');
      expect(server.requests).toHaveLength(2);
      const input = server.requests[1].input as {
        type: string;
        call_id?: string;
        output?: unknown;
      }[];
      const refusal = input.find(
        (item) =>
          item.type === 'function_call_output' &&
          item.call_id === 'forbidden-escalation',
      );
      // Both current Core exec validation routes identify this policy refusal.
      expect(String(refusal?.output)).toMatch(
        /approval policy.*reject command/,
      );
      expect(
        executor.requests.filter(
          (request) => request.method === 'process/start',
        ),
      ).toHaveLength(0);
      await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
      server.assertExhausted();
    } finally {
      try {
        await provider.close();
      } finally {
        await executor.close();
      }
    }
  },
);

it.skipIf(
  process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1' ||
    process.platform !== 'linux',
)(
  'restores equivalent policy and refuses changed identity before reconnect or model work',
  async () => {
    const executor = await startPublicExecutor();
    const server = new ModelServer([[message('ready')]]);
    const provider = await providerFor(server);
    try {
      const agent = new Agent({
        instructions: 'Retain network policy.',
        provider,
      });
      const selected = {
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command'] as const,
        network: {
          allowedDomains: ['B.example.invalid.', 'a.example.invalid'],
          deniedDomains: ['blocked.invalid', '::ffff:192.0.2.1'],
          allowAllUnixSockets: true,
        },
      };
      const session = await agent.session({
        environment: new Environment(selected),
      });
      let state;
      try {
        expect(
          (await (await session.submit('Start.')).wait()).finalOutput,
        ).toBe('ready');
        state = await session.saveState();
      } finally {
        await session.close();
      }
      const encoded = JSON.stringify(state);
      for (const privateText of [
        'example.invalid',
        'blocked.invalid',
        '192.0.2.1',
        executor.headers.Authorization,
      ])
        expect(encoded).not.toContain(privateText);
      const equivalent = new Environment({
        ...selected,
        network: {
          allowedDomains: [
            'a.example.invalid',
            'b.example.invalid',
            'a.example.invalid',
          ],
          deniedDomains: ['::FFFF:c000:0201', 'blocked.invalid'],
          allowAllUnixSockets: true,
        },
      });
      const restored = await agent.session({ state, environment: equivalent });
      try {
        expect(restored.id).toBe(state.source_session_id);
      } finally {
        await restored.close();
      }
      const requests = executor.requests.length;
      const modelRequests = server.requests.length;
      for (const changed of [
        undefined,
        {},
        { ...selected.network, allowLocalBinding: true },
        { ...selected.network, deniedDomains: [] },
      ]) {
        await refusesOpening(
          agent.session({
            state,
            environment: new Environment({ ...selected, network: changed }),
          }),
          'Checkpoint and Environment must agree',
        );
        expect(executor.requests).toHaveLength(requests);
        expect(server.requests).toHaveLength(modelRequests);
      }
      server.assertExhausted();
    } finally {
      try {
        await provider.close();
      } finally {
        await executor.close();
      }
    }
  },
  30_000,
);

it
  .skipIf(
    process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1' ||
      process.platform !== 'linux' ||
      (process.env.GITHUB_ACTIONS !== 'true' &&
        process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1' &&
        process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'),
  )
  .each([
    [
      'enforces allowed, overlapping-denied and unlisted proxy requests without direct bypass',
      false,
    ],
    [
      'allows unlisted proxy requests and enforces explicit denials with allowAll',
      true,
    ],
  ] as const)(
  '%s',
  async (_name, allowAll) => {
    const received: string[] = [];
    const listeners: Server[] = [];
    const localAgent = new HttpAgent({ keepAlive: false });
    const executor = await startPublicExecutor();
    try {
      const urls: string[] = [];
      for (const host of ['127.0.0.1', '127.0.0.2', '127.0.0.3']) {
        const server = createServer((_request, response) => {
          received.push(host);
          response.end(host);
        });
        listeners.push(server);
        server.listen(0, host);
        await once(server, 'listening');
        const url = `http://${host}:${(server.address() as AddressInfo).port}/`;
        const body = await new Promise<string>((resolve, reject) => {
          // Probe this test's local servers independently of the host HTTP proxy.
          get(url, { agent: localAgent }, (response) => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
              text += chunk;
            });
            response.on('end', () => resolve(text));
            response.on('error', reject);
          }).on('error', reject);
        });
        expect(body).toBe(host);
        urls.push(url);
      }
      received.length = 0;
      const cmd = [
        'python3',
        '-I',
        '-c',
        probe,
        allowAll ? 'allow-all' : 'allowlist',
        ...urls,
      ]
        .map(shellQuote)
        .join(' ');
      const server = new ModelServer([
        [
          call(
            'exec_command',
            { cmd, yield_time_ms: 20_000 },
            { callId: 'network-probe' },
          ),
        ],
        [message('done')],
      ]);
      const provider = await providerFor(server);
      try {
        const agent = new Agent({
          instructions: 'Run the network probe.',
          provider,
        });
        const options = {
          deniedDomains: ['127.0.0.2', 'private-denial-marker.invalid'],
          allowAllUnixSockets: true,
        };
        const session = await agent.session({
          environment: new Environment({
            url: executor.url,
            cwd: executor.cwd,
            headers: executor.headers,
            tools: ['exec_command'],
            network: allowAll
              ? NetworkPolicy.allowAll({
                  ...options,
                  // The wildcard requires this opt-in for loopback origins.
                  allowLocalBinding: true,
                })
              : {
                  ...options,
                  allowedDomains: [
                    '127.0.0.1',
                    '127.0.0.2',
                    'private-policy-marker.invalid',
                  ],
                },
          }),
        });
        try {
          const result = await (await session.submit('Probe.')).wait();
          expect(result.finalOutput).toBe('done');
          const inputs = server.requests[1].input as {
            type: string;
            call_id?: string;
            output?: unknown;
          }[];
          const output = inputs.find(
            (item) =>
              item.type === 'function_call_output' &&
              item.call_id === 'network-probe',
          );
          expect(String(output?.output)).toContain(
            'Process exited with code 0',
          );
          expect(String(output?.output)).toContain(
            'managed-network-probe-passed',
          );
          expect(received).toEqual(
            allowAll ? ['127.0.0.1', '127.0.0.3'] : ['127.0.0.1'],
          );
          const saved = JSON.stringify(await session.saveState());
          if (!allowAll)
            expect(saved).not.toContain('private-policy-marker.invalid');
          expect(saved).not.toContain('private-denial-marker.invalid');
          server.assertExhausted();
        } finally {
          await session.close();
        }
      } finally {
        await provider.close();
      }
    } finally {
      localAgent.destroy();
      try {
        await Promise.all(
          listeners
            .filter((server) => server.listening)
            .map(
              (server) =>
                new Promise<void>((resolve, reject) => {
                  server.close((error) => (error ? reject(error) : resolve()));
                  server.closeAllConnections();
                }),
            ),
        );
      } finally {
        await executor.close();
      }
    }
  },
  45_000,
);
