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

it.each(['replace', 'omit', 'empty'] as const)(
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
        destination === 'replace'
          ? {
              SDK_ENV_VALUE: destinationSecret,
              EMPTY: '',
              PATH: '/opt/current:/usr/bin:/bin',
            }
          : destination === 'empty'
            ? {}
            : undefined;
      const current = new Environment({ ...connection, env: replacement });
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
            : destination === 'replace'
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
