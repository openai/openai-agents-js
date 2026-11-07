import { afterEach, expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { Manifest } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { Agent, Environment, NativeProvider } from '../../src';
import { sandboxEnvironment } from '@openai/agents/sandbox';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

// This qualifies native Session acquisition and provider retirement, not native
// shell sandbox enforcement or cloud mounts (which require their own runtime).
it('opens a public native Session against the exact materialized local provider workspace', async () => {
  const server = new ModelServer([[message('provider session joined')]]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-provider',
    supportsWebsockets: false,
  });
  const events: string[] = [];
  let workspace = '';
  const client = new UnixLocalSandboxClient();
  const source = sandboxEnvironment({
    client,
    manifest: new Manifest({
      entries: {
        'marker.txt': { type: 'file', content: 'real-provider-workspace' },
      },
    }),
    connect: async (sandbox, { signal }) => {
      workspace = sandbox.state.workspaceRootPath;
      expect(await readFile(`${workspace}/marker.txt`, 'utf8')).toBe(
        'real-provider-workspace',
      );
      const peer = await startPublicExecutor();
      const close = sandbox.close!.bind(sandbox);
      sandbox.close = async () => {
        events.push('provider-close');
        await close();
      };
      try {
        signal.throwIfAborted();
        return Environment.lease(
          new Environment({
            url: peer.url,
            headers: peer.headers,
            cwd: workspace,
            tools: [],
          }),
          async () => {
            events.push('gateway-close');
            await peer.close();
          },
        );
      } catch (error) {
        await peer.close();
        throw error;
      }
    },
  });
  const agent = new Agent({
    provider,
    model: 'gpt-5',
    instructions: 'Reply briefly.',
  });
  const session = await agent.session({ environment: source });
  try {
    expect(
      (
        await (
          await session.submit('Use the configured provider Session.')
        ).wait()
      ).finalOutput,
    ).toBe('provider session joined');
    expect(await readFile(`${workspace}/marker.txt`, 'utf8')).toBe(
      'real-provider-workspace',
    );
    expect(events).toEqual([]);
  } finally {
    await session.close();
  }
  expect(events[0]).toBe('gateway-close');
  await expect(stat(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  server.assertExhausted();
});
