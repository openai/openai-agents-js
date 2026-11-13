import { afterEach, expect, it, vi } from 'vitest';
import { Agent, Environment, NativeProvider } from '../../src';
import {
  UnixLocalSandboxClient,
  type UnixLocalSandboxSessionState,
} from '@openai/agents-core/sandbox/local';
import {
  Manifest,
  sandboxEnvironment,
  type SandboxSessionLike,
} from '@openai/agents/sandbox';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

let peer: Awaited<ReturnType<typeof startPublicExecutor>> | undefined;
afterEach(async () => {
  await ModelServer.closeAll();
  await peer?.close();
});

it('rejects child-only sandbox memory before a handoff or any model request', async () => {
  const executor = (peer = await startPublicExecutor());
  const server = new ModelServer([
    [call('transfer_to_child', {}, { callId: 'memory-route' })],
    [message('Child finished.')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-child-memory',
    supportsWebsockets: false,
  });
  const phase = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Return memory artifacts.',
  });
  const connect = vi.fn(
    async ({ state }: SandboxSessionLike<UnixLocalSandboxSessionState>) =>
      Environment.lease(
        new Environment({
          url: executor.url,
          headers: executor.headers,
          cwd: state.workspaceRootPath,
          tools: [],
        }),
        async () => {},
      ),
  );
  const child = new Agent({
    name: 'child',
    instructions: 'Answer as the child.',
    environment: sandboxEnvironment({
      client: new UnixLocalSandboxClient(),
      manifest: new Manifest({ entries: {} }),
      memory: { phaseOne: phase, phaseTwo: phase },
      connect,
    }),
  });
  const root = new Agent({
    model: 'gpt-5.5',
    instructions: 'Transfer to the child.',
    provider,
    handoffs: [child],
  });
  await expect(root.run('Route.')).rejects.toThrow(
    'Sandbox memory requires the root Environment acquisition',
  );
  expect(connect).toHaveBeenCalledOnce();
  expect(server.requests).toEqual([]);
});
