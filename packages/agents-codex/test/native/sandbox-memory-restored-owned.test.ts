import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, Environment, NativeProvider } from '../../src';
import { binding } from '../../src/runtime/binding';
import {
  Manifest,
  sandboxEnvironment,
  normalizeSandboxClientCreateArgs,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents-core/sandbox/local';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';
afterEach(() => ModelServer.closeAll());

it
  .skipIf(process.platform === 'win32')
  .each(['prior', 'fresh', 'unadmitted'] as const)(
  'uses only a newly owned source turn after restore: %s',
  async (mode) => {
    const newTurn = mode === 'fresh';
    const base = await mkdtemp(join(tmpdir(), 'memory-new-owned-'));
    const workspace = join(base, 'workspace');
    await mkdir(workspace);
    const peer = await startPublicExecutor();
    const server = new ModelServer([
      [message('Original source turn.')],
      ...(newTurn ? [[message('Fresh source turn.')]] : []),
      ...[
        [
          message(
            JSON.stringify({
              rollout_summary: 'New owned source',
              rollout_slug: 'new-owned-source',
              raw_memory: 'A fresh source ran after restore.',
            }),
          ),
        ],
        [
          message(
            JSON.stringify({
              summary: 'Fresh source.',
              memory: 'A fresh source ran after restore.',
            }),
          ),
        ],
      ],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-provider',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      provider,
      model: 'gpt-5',
      instructions: 'Use the current source.',
    });
    const createClient = () => {
      const client = new UnixLocalSandboxClient({
        resumeAuthority: {
          workspaceRootPath: workspace,
          workspaceRootOwned: false,
        },
      });
      client.create = async (args) =>
        client.resume({
          manifest: normalizeSandboxClientCreateArgs(args).manifest,
          workspaceRootPath: workspace,
          workspaceRootOwned: false,
          environment: {},
        });
      return client;
    };
    const source = () =>
      sandboxEnvironment({
        client: createClient(),
        manifest: new Manifest({ root: workspace }),
        memory: {
          phaseOne: new Agent({
            provider,
            model: 'gpt-5',
            instructions: 'Extract memory.',
          }),
          phaseTwo: new Agent({
            provider,
            model: 'gpt-5',
            instructions: 'Consolidate memory.',
          }),
        },
        connect: async (resource) =>
          Environment.lease(
            new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: resource.state.workspaceRootPath,
              tools: [],
            }),
            async () => {},
          ),
      });
    try {
      let state;
      {
        await using original = await agent.session({ environment: source() });
        await (await original.submit('Original source.')).wait();
        if (mode === 'unadmitted') {
          const native = await binding();
          const refusal = Object.assign(
            new Error('Synthetic native admission guard'),
            { code: 'InvalidArg' },
          );
          // The NAPI pre-dispatch guard has been retaining an open SDK Session.
          const submit = vi
            .spyOn(native.NativeThread.prototype, '_submit')
            .mockRejectedValueOnce(refusal);
          try {
            expect(
              await original
                .submit('Must not enter history.')
                .catch((error: unknown) => error),
            ).toBe(refusal);
            await expect(original.flushMemory()).rejects.toBe(refusal);
            expect(server.requests).toHaveLength(1);
          } finally {
            submit.mockRestore();
          }
          return;
        }
        state = await original.saveState();
      }
      await using restored = await agent.session({
        state,
        environment: source(),
      });
      if (!newTurn) {
        await expect(restored.flushMemory()).rejects.toThrow(
          'newly admitted source turn after restore',
        );
        expect(server.requests).toHaveLength(1);
        return;
      }
      const current = await restored.submit('Fresh source after restore.');
      expect((await current.wait()).finalOutput).toBe('Fresh source turn.');
      await expect(restored.flushMemory()).resolves.toBeUndefined();
      await restored.flushMemory();
      const transcript = await readFile(
        join(workspace, 'sessions', `${restored.id}.jsonl`),
        'utf8',
      );
      expect(transcript.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(transcript).terminal_metadata).toMatchObject({
        terminal_state: 'completed',
        has_final_output: true,
      });
      expect(transcript).toContain('Fresh source after restore.');
      expect(server.requests).toHaveLength(4);
      server.assertExhausted();
    } finally {
      await peer.close();
      await rm(base, { recursive: true, force: true });
    }
  },
  30_000,
);
