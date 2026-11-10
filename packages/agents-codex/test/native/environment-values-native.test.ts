import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  Environment,
  NativeProvider,
  type SessionState,
} from '@openai/agents';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(async () => {
  await ModelServer.closeAll();
});

it.each(['replace', 'omit', 'empty', 'resolved'] as const)(
  'uses captured current environment values on native executor requests after restore: %s',
  async (destination) => {
    const sourceSecret = 'source-private-environment-value';
    const destinationSecret = 'destination-private-environment-value';
    const executor = await startPublicExecutor();
    try {
      const model = new ModelServer(
        ['source', 'destination'].flatMap((phase) => [
          [
            call(
              'exec_command',
              { cmd: 'printf ready', login: false },
              { callId: phase },
            ),
          ],
          [message('completed')],
        ]),
      );
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-environment-provider',
        supportsWebsockets: false,
      });
      const values = {
        SDK_ENV_VALUE: sourceSecret,
        EMPTY: '',
        PATH: '/opt/app:/usr/bin:/bin',
      };
      const connection = {
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command'] as const,
      };
      const original = new Environment({ ...connection, env: values });
      values.SDK_ENV_VALUE = 'mutated-after-capture';
      const replacement: Record<string, string> | undefined =
        destination === 'replace' || destination === 'resolved'
          ? {
              SDK_ENV_VALUE: destinationSecret,
              EMPTY: '',
              PATH: '/opt/current:/usr/bin:/bin',
            }
          : destination === 'empty'
            ? {}
            : undefined;
      const resolutionEvents: string[] = [];
      const current =
        destination === 'resolved'
          ? async () => {
              const env = await Promise.resolve(replacement);
              resolutionEvents.push('resolved');
              return Environment.lease(
                new Environment({ ...connection, env }),
                () => {
                  resolutionEvents.push('released');
                },
              );
            }
          : new Environment({ ...connection, env: replacement });
      const agent = new Agent({
        instructions: 'Run the selected command.',
        provider,
        model: 'gpt-5',
      });
      let state: SessionState | undefined;
      for (const [phase, environment] of [
        ['source', original],
        ['destination', current],
      ] as const) {
        await using session = await agent.session({ state, environment });
        const turn = await session.submit('Run the command');
        expect((await turn.wait()).finalOutput).toBe('completed');
        state = await session.saveState();
        const observations = [];
        for await (const event of turn.events()) observations.push(event);
        for (const secret of [sourceSecret, destinationSecret]) {
          expect(JSON.stringify(state)).not.toContain(secret);
          expect(JSON.stringify(observations)).not.toContain(secret);
        }
        const starts = executor.requests.filter(
          (request) =>
            request.method === 'process/start' &&
            ((request.params as JsonObject)?.metadata as JsonObject)
              ?.toolCallId === phase,
        );
        expect(starts).toHaveLength(1);
        const params = starts[0].params as JsonObject;
        const policy = params.envPolicy as JsonObject;
        const actual = {
          ...(policy.set as JsonObject),
          ...(params.env as JsonObject),
        };
        const expected =
          phase === 'source'
            ? sourceSecret
            : destination === 'replace' || destination === 'resolved'
              ? destinationSecret
              : undefined;
        expect(actual.SDK_ENV_VALUE).toBe(expected);
        if (expected !== undefined) {
          expect(actual.EMPTY).toBe('');
          expect(actual.PATH).toBe(
            phase === 'source'
              ? '/opt/app:/usr/bin:/bin'
              : '/opt/current:/usr/bin:/bin',
          );
        }
      }
      expect(resolutionEvents).toEqual(
        destination === 'resolved' ? ['resolved', 'released'] : [],
      );
      // Execution availability depends on the peer's OS sandbox. These assertions
      // cover native request values and private state, not successful OS isolation.
      const wire = JSON.stringify(model.requests);
      expect(wire).not.toContain(sourceSecret);
      expect(wire).not.toContain(destinationSecret);
      model.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  40_000,
);

it.each([
  ['$serde_json::private::Number', '7301592846'],
  ['$serde_json::private::RawValue', '{"APP_MODE":"injected-env-marker"}'],
  ['__proto__', 'literal-environment-value'],
])(
  'preserves literal native environment name %s',
  async (name, value) => {
    const executor = await startPublicExecutor();
    try {
      const model = new ModelServer([
        [
          call(
            'exec_command',
            { cmd: 'printf ready', login: false },
            { callId: 'literal-env' },
          ),
        ],
        [message('completed')],
      ]);
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-environment-provider',
        supportsWebsockets: false,
      });
      await using session = await new Agent({
        instructions: 'Run the command.',
        provider,
        model: 'gpt-5',
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command'],
          env: Object.fromEntries([[name, value]]),
        }),
      });
      expect((await (await session.submit('Run')).wait()).finalOutput).toBe(
        'completed',
      );
      expect(JSON.stringify(await session.saveState())).not.toContain(name);
      const starts = executor.requests.filter(
        (request) =>
          request.method === 'process/start' &&
          ((request.params as JsonObject)?.metadata as JsonObject)
            ?.toolCallId === 'literal-env',
      );
      expect(starts).toHaveLength(1);
      const params = starts[0].params as JsonObject;
      const actual = {
        ...((params.envPolicy as JsonObject).set as JsonObject),
        ...(params.env as JsonObject),
      };
      expect(Object.hasOwn(actual, name)).toBe(true);
      expect(actual[name]).toBe(value);
      expect(actual).not.toHaveProperty('APP_MODE');
      expect(JSON.stringify(model.requests)).not.toContain(name);
      model.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  40_000,
);
