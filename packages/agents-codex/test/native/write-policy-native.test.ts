import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Agent, Environment, NativeProvider } from '@openai/agents';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
  'fails clearly when a default-strict remote executor advertises an unsupported platform',
  async () => {
    // This changes advertised admission metadata, not real executor enforcement.
    const executor = await startPublicExecutor({
      environmentInfoOverride: { platformOs: 'windows' },
    });
    const server = new ModelServer([]);
    try {
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-local-worker',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      await expect(
        agent.session({
          environment: new Environment({
            url: executor.url,
            cwd: executor.cwd,
            headers: executor.headers,
          }),
        }),
      ).rejects.toThrow(
        /strict executor write policy requires a Linux or macOS executor/,
      );
      expect(server.requests).toHaveLength(0);
      expect(
        executor.requests.filter(
          (request) => request.method === 'process/start',
        ),
      ).toHaveLength(0);
    } finally {
      await executor.close();
      await ModelServer.closeAll();
    }
  },
  30_000,
);

// Strict file effects launch the real filesystem sandbox; outer Codex forbids nesting.
it.skipIf(
  (process.platform !== 'linux' && process.platform !== 'darwin') ||
    process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1',
)(
  'default strict allows workspace writes and denies writes outside the workspace',
  async () => {
    const executor = await startPublicExecutor();
    const inside = join(executor.cwd, 'allowed.txt');
    const outside = join(executor.cwd, '..', 'denied.txt');
    const patch = (path: string, callId: string) => ({
      type: 'custom_tool_call',
      name: 'apply_patch',
      call_id: callId,
      input: `*** Begin Patch\n*** Add File: ${path}\n+synthetic-policy-effect\n*** End Patch`,
    });
    const server = new ModelServer([
      [patch('allowed.txt', 'inside')],
      [patch(outside, 'outside')],
      [message('done')],
    ]);
    try {
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-local-worker',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      await using session = await agent.session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['apply_patch'],
        }),
      });
      expect(
        (await (await session.submit('Apply the requested patches.')).wait())
          .finalOutput,
      ).toBe('done');
      expect(await readFile(inside, 'utf8')).toBe('synthetic-policy-effect\n');
      await expect(stat(outside)).rejects.toMatchObject({ code: 'ENOENT' });
      server.assertExhausted();
    } finally {
      await executor.close();
      await ModelServer.closeAll();
    }
  },
  30_000,
);
