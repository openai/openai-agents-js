import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { rootCertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  Environment,
  NativeError,
  NativeProvider,
} from '@openai/agents';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());
const starts = (executor: Awaited<ReturnType<typeof startPublicExecutor>>) =>
  executor.requests.filter((request) => request.method === 'process/start');

async function providerFor(model: ModelServer, apiKey: string) {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey,
    supportsWebsockets: false,
  });
}
function environmentFor(
  executor: Awaited<ReturnType<typeof startPublicExecutor>>,
) {
  return new Environment({
    url: executor.url,
    cwd: executor.cwd,
    headers: executor.headers,
    tools: ['exec_command'],
    approval: () => true,
    connectTimeout: 1,
  });
}
function expectNoSecrets(value: unknown, secrets: string[]) {
  const diagnostic = inspect(value, { depth: null });
  for (const secret of secrets) expect(diagnostic).not.toContain(secret);
}

it.each(['wrong-host', 'untrusted-ca', 'forbidden'] as const)(
  'rejects executor %s before remote RPCs without exposing credentials',
  async (failure) => {
    const executor = await startPublicExecutor({
      certificateNames:
        failure === 'wrong-host' ? 'DNS:wrong-host.invalid' : undefined,
      rejectAuthorization: failure === 'forbidden',
    });
    const model = new ModelServer([]);
    const config = await model.config();
    try {
      const untrustedRoots = join(executor.cwd, 'unrelated-public-roots.pem');
      if (failure === 'untrusted-ca')
        await writeFile(untrustedRoots, rootCertificates.join('\n'));
      const child = fork(
        fileURLToPath(
          new URL('./fixtures/executor-open-worker.ts', import.meta.url),
        ),
        [
          JSON.stringify({
            modelUrl: (
              config['model_providers.fixture'] as { base_url: string }
            ).base_url,
            executorUrl: executor.url,
            cwd: executor.cwd,
            authorization: executor.headers.Authorization,
          }),
        ],
        {
          execArgv: ['--stack-size=16384', '--import', 'tsx'],
          env: {
            ...process.env,
            ...(failure === 'untrusted-ca'
              ? {
                  SSL_CERT_FILE: untrustedRoots,
                  SSL_CERT_DIR: undefined,
                  CODEX_CA_CERTIFICATE: undefined,
                }
              : {}),
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      let result: { opened: boolean; diagnostic?: string } | undefined;
      let output = '';
      child.on('message', (value) => {
        result = value as typeof result;
      });
      child.stdout?.on('data', (chunk) => {
        output += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        output += String(chunk);
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
      try {
        const [code, signal] = await once(child, 'close');
        expect({ code, signal }, output).toEqual({ code: 0, signal: null });
      } finally {
        clearTimeout(timeout);
      }
      expect(result?.opened).toBe(false);
      expect(result?.diagnostic).toContain(
        {
          'wrong-host': 'TLS certificate does not match the executor host',
          'untrusted-ca': 'TLS certificate issuer is not trusted',
          forbidden: 'executor authentication denied (HTTP 401)',
        }[failure],
      );
      expectNoSecrets(
        [result, output],
        [
          executor.url,
          executor.headers.Authorization,
          'synthetic-executor-token',
        ],
      );
      expect(executor.requests).toHaveLength(0);
      expect(model.requests).toHaveLength(0);
      if (failure === 'forbidden')
        expect(executor.rejectedUpgrades.length).toBeGreaterThan(0);
      else {
        expect(executor.rejectedUpgrades).toHaveLength(0);
        expect(executor.tlsFailures.length).toBeGreaterThan(0);
      }
    } finally {
      await executor.close();
    }
  },
  20_000,
);

// Strict process effects require a working native sandbox.
it.skipIf(
  process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1' &&
    process.env.GITHUB_ACTIONS !== 'true' &&
    process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1',
)(
  'retains a real remote effect after losing its start acknowledgement without replay',
  async () => {
    const executor = await startPublicExecutor({
      dropStartReplyAfter: { path: 'started.txt', contents: 'started' },
    });
    const releaseModel = Promise.withResolvers<void>();
    const model = new ModelServer([
      [
        call(
          'exec_command',
          {
            cmd: 'printf started >> started.txt; sleep 1',
            yield_time_ms: 1000,
          },
          { callId: 'lost-start' },
        ),
      ],
      async () => {
        // Keep a transport-error continuation from completing before explicit cancellation.
        await releaseModel.promise;
        return [message('unused after cancellation')];
      },
    ]);
    const provider = await providerFor(model, 'synthetic-lost-ack-model');
    let session: Awaited<ReturnType<Agent['session']>> | undefined;
    try {
      session = await new Agent({
        instructions: 'Use the selected executor.',
        provider,
        model: 'gpt-5',
      }).session({ environment: environmentFor(executor) });
      const turn = await session.submit('Start once.');
      const outcome = turn.wait().catch((error: unknown) => error);
      const deadline = Date.now() + 10_000;
      while (!executor.droppedStartReply && Date.now() < deadline)
        await delay(10);
      expect(
        executor.droppedStartReply,
        JSON.stringify(executor.requests),
      ).toBe(true);
      await turn.cancel();
      const failure = await outcome;
      // Cancellation settles this admitted operation; it does not undo the remote write.
      expect(turn.turnId).toEqual(expect.any(String));
      expect(failure).toBeInstanceOf(NativeError);
      expect(failure).toMatchObject({ name: 'TurnAborted', retryable: null });
      const history = [];
      for await (const recorded of session.turns()) history.push(recorded);
      expect(
        history.find((recorded) => recorded.id === turn.turnId),
      ).toMatchObject({
        status: 'cancelled',
      });
      expectNoSecrets(failure, [
        executor.headers.Authorization,
        'synthetic-lost-ack-model',
      ]);
      expect(await readFile(join(executor.cwd, 'started.txt'), 'utf8')).toBe(
        'started',
      );
      expect(starts(executor), JSON.stringify(executor.requests)).toHaveLength(
        1,
      );
      // No receipt claims that transport loss rolled back the observed remote effect.
      expectNoSecrets(await session.saveState(), [
        executor.headers.Authorization,
        'synthetic-lost-ack-model',
      ]);
    } finally {
      releaseModel.resolve();
      try {
        await session?.close();
      } finally {
        try {
          await provider.close();
        } finally {
          await executor.close();
        }
      }
    }
  },
  25_000,
);

// Strict process effects require a working native sandbox.
it.skipIf(
  process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1' &&
    process.env.GITHUB_ACTIONS !== 'true' &&
    process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1',
)(
  'isolates colliding executor calls, credentials and roots while a sibling closes',
  async () => {
    const left = await startPublicExecutor({
      authorization: 'Bearer synthetic-left-executor',
    });
    const right = await startPublicExecutor({
      authorization: 'Bearer synthetic-right-executor',
    });
    // Both peers must be trusted together before native transport loads its roots.
    const bundle = join(right.cwd, 'combined-ca.pem');
    await writeFile(
      bundle,
      Buffer.concat(
        await Promise.all([
          readFile(left.caCertificate),
          readFile(right.caCertificate),
        ]),
      ),
    );
    process.env.SSL_CERT_FILE = bundle;
    process.env.CODEX_CA_CERTIFICATE = bundle;
    const secrets = [
      'synthetic-left-executor',
      'synthetic-right-executor',
      'synthetic-left-model',
      'synthetic-right-model',
    ];
    const models = [left, right].map(
      (_, index) =>
        new ModelServer(
          [
            [
              call(
                'exec_command',
                { cmd: 'cat marker.txt' },
                { callId: 'same-native-call' },
              ),
            ],
            [message(index === 0 ? 'left complete' : 'right complete')],
            [
              call(
                'exec_command',
                { cmd: 'cat marker.txt' },
                { callId: 'same-native-call' },
              ),
            ],
            [message('right survives')],
          ].slice(0, index === 0 ? 2 : 4),
        ),
    );
    const providers = await Promise.all(
      models.map((model, index) =>
        providerFor(model, `synthetic-${index === 0 ? 'left' : 'right'}-model`),
      ),
    );
    const sessions: Awaited<ReturnType<Agent['session']>>[] = [];
    try {
      await Promise.all([
        writeFile(join(left.cwd, 'marker.txt'), 'left-root-value'),
        writeFile(join(right.cwd, 'marker.txt'), 'right-root-value'),
      ]);
      sessions.push(
        ...(await Promise.all(
          providers.map((provider, index) =>
            new Agent({
              instructions: 'Use the selected executor.',
              provider,
              model: 'gpt-5',
            }).session({
              environment: environmentFor(index === 0 ? left : right),
            }),
          ),
        )),
      );
      const results = await Promise.all(
        sessions.map(
          async (session) =>
            (await (await session.submit('Read marker.')).wait()).finalOutput,
        ),
      );
      expect(results).toEqual(['left complete', 'right complete']);
      expectNoSecrets(
        await Promise.all(sessions.map((session) => session.saveState())),
        secrets,
      );
      await sessions[0].close();
      await providers[0].close();
      await writeFile(
        join(right.cwd, 'marker.txt'),
        'right-root-after-sibling-close',
      );
      expect(
        (await (await sessions[1].submit('Read again.')).wait()).finalOutput,
      ).toBe('right survives');
      for (const [index, executor] of [left, right].entries()) {
        const own = index === 0 ? 'left' : 'right';
        const sibling = index === 0 ? 'right' : 'left';
        expect(starts(executor)).toHaveLength(index === 0 ? 1 : 2);
        for (const start of starts(executor)) {
          const params = start.params as Record<string, unknown>;
          expect(params.cwd).toBe(`file://${executor.cwd}`);
          expect(params.metadata).toMatchObject({
            toolCallId: 'same-native-call',
          });
        }
        expect(JSON.stringify(executor.requests)).not.toContain(
          `${sibling}-root-value`,
        );
        expectNoSecrets(executor.requests, secrets);
        const model = models[index];
        const postToolRequests = index === 0 ? [1] : [1, 3];
        for (const [round, requestIndex] of postToolRequests.entries()) {
          const outputs = (
            model.requests[requestIndex].input as Record<string, unknown>[]
          ).filter(
            (item) =>
              item.type === 'function_call_output' &&
              item.call_id === 'same-native-call',
          );
          expect(outputs).toHaveLength(round + 1);
          // The new output follows retained history; an earlier marker cannot prove this read.
          const output = outputs[round].output;
          const expected =
            round === 0
              ? `${own}-root-value`
              : 'right-root-after-sibling-close';
          expect(output).toEqual(expect.stringContaining(expected));
          expect(output).not.toContain(`${sibling}-root-value`);
          if (round === 1) expect(output).not.toContain('right-root-value');
        }
        expect(
          model.requestHeaders.every(
            (headers) =>
              headers.authorization === `Bearer synthetic-${own}-model`,
          ),
        ).toBe(true);
        expectNoSecrets(model.requests, secrets);
        model.assertExhausted();
      }
      expectNoSecrets(await sessions[1].saveState(), secrets);
    } finally {
      try {
        await Promise.all(sessions.map((session) => session.close()));
      } finally {
        try {
          await Promise.all(providers.map((provider) => provider.close()));
        } finally {
          await right.close();
          await left.close();
        }
      }
    }
  },
  30_000,
);
