import { afterEach, expect, it } from 'vitest';
import { Agent, Environment, NativeProvider } from '@openai/agents';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(async () => {
  await ModelServer.closeAll();
});

it('preserves explicit values in the native post-filter environment channel', async () => {
  const selected = {
    SDK_NORMAL: 'private-explicit-value',
    'LIT*': 'star',
    'LIT?': 'question',
    TERM: 'xterm',
    LANG: 'fr_FR',
    PATH: '/upper',
    ...(process.platform === 'win32' ? {} : { Path: '/mixed' }),
  };
  const executor = await startPublicExecutor();
  try {
    const model = new ModelServer([
      [
        call(
          'exec_command',
          { cmd: 'printf ready', login: false },
          { callId: 'post-filter' },
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
    }).session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command'],
        env: selected,
      }),
    });
    expect((await (await session.submit('Run')).result()).finalOutput).toBe(
      'completed',
    );
    expect(JSON.stringify(await session.saveState())).not.toContain(
      'private-explicit-value',
    );
    const starts = executor.requests.filter(
      (item) => item.method === 'process/start',
    );
    expect(starts).toHaveLength(1);
    const params = starts[0].params as JsonObject;
    for (const [name, value] of Object.entries(selected)) {
      expect((params.env as JsonObject)[name]).toBe(value);
      expect(
        ((params.envPolicy as JsonObject).set as JsonObject)[name],
      ).toBeUndefined();
    }
    expect(JSON.stringify(model.requests)).not.toContain(
      'private-explicit-value',
    );
    model.assertExhausted();
  } finally {
    await executor.close();
  }
}, 40_000);
