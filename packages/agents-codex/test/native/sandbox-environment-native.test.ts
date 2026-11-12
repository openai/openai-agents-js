import { afterEach, expect, it, vi } from 'vitest';
import { readFile, stat, writeFile } from 'node:fs/promises';
import {
  addSandboxEventSink,
  Manifest,
  sandboxEnvironment,
  type SandboxEvent,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { Agent, Environment, NativeProvider } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
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

it.skipIf(process.platform === 'win32')(
  'delivers native shell and image operation headers from the provider lease',
  async () => {
    const privateInput = 'synthetic-observer-private-input';
    const server = new ModelServer([
      [
        call(
          'exec_command',
          { cmd: `printf %s ${privateInput}; exit 7` },
          { callId: 'failed-command' },
        ),
      ],
      [
        call(
          'write_stdin',
          { session_id: 700000001, chars: privateInput },
          { callId: 'missing-terminal' },
        ),
      ],
      [
        call(
          'view_image',
          { path: privateInput + '.png' },
          { callId: 'read-image' },
        ),
      ],
      (request) => {
        expect(JSON.stringify(request.input)).toContain(
          'data:image/png;base64,',
        );
        return [message('native operations complete')];
      },
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-provider',
      supportsWebsockets: false,
    });
    const client = new UnixLocalSandboxClient();
    const source = sandboxEnvironment({
      client,
      manifest: new Manifest(),
      connect: async (sandbox) => {
        await writeFile(
          `${sandbox.state.workspaceRootPath}/${privateInput}.png`,
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
            'base64',
          ),
        );
        const peer = await startPublicExecutor();
        try {
          return Environment.lease(
            new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: sandbox.state.workspaceRootPath,
              tools: ['exec_command', 'write_stdin'],
            }),
            () => peer.close(),
          );
        } catch (error) {
          await peer.close();
          throw error;
        }
      },
    });
    const names = ['sandbox.exec', 'sandbox.write_stdin', 'sandbox.view_image'];
    const observed: SandboxEvent[] = [];
    const removeSink = addSandboxEventSink((event) => {
      if (names.includes(event.name)) observed.push(event);
    });
    try {
      await using session = await new Agent({
        instructions: 'Use the requested sandbox tools.',
        provider,
      }).session({ environment: source, projectGuidance: true });
      const submission = await session.submit('Use the native sandbox.');
      expect((await submission.wait()).finalOutput).toBe(
        'native operations complete',
      );
      await vi.waitFor(() =>
        expect(observed.map(({ name, phase }) => [name, phase])).toEqual([
          ['sandbox.exec', 'start'],
          ['sandbox.exec', 'error'],
          ['sandbox.write_stdin', 'start'],
          ['sandbox.write_stdin', 'error'],
          ['sandbox.view_image', 'start'],
          ['sandbox.view_image', 'end'],
        ]),
      );
      expect(observed.map((event) => event.data)).toEqual(
        names.flatMap(() => [
          { backend_id: client.backendId },
          { backend_id: client.backendId },
        ]),
      );
      for (const event of observed.filter(({ phase }) => phase !== 'start')) {
        expect(event.durationMs).toBeGreaterThanOrEqual(0);
        if (event.phase === 'error') {
          expect(event.error).toEqual({
            name: 'SandboxOperationError',
            message: 'Sandbox operation failed',
          });
        }
      }
      expect(JSON.stringify(observed)).not.toContain(privateInput);
      server.assertExhausted();
    } finally {
      removeSink();
    }
  },
);
