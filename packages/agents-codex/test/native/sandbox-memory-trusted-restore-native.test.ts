import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, Environment, NativeProvider, type Session } from '../../src';
import {
  Manifest,
  sandboxEnvironment,
  ManagedWorkspaceCheckpoint,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents-core/sandbox/local';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

it
  .skipIf(process.platform === 'win32')
  .each(['captured', 'authenticated-import'] as const)(
  'retains admitted memory history through trusted %s restore',
  async (route) => {
    const base = await mkdtemp(join(tmpdir(), 'memory-trusted-'));
    const phaseOne = () => [
      message(
        JSON.stringify({
          rollout_summary: 'Approved project',
          rollout_slug: 'approved-project',
          raw_memory: 'Approved project choices.',
        }),
      ),
    ];
    const phaseTwo = () => [
      message(
        JSON.stringify({
          summary: 'Approved project',
          memory: 'Approved project choices.',
        }),
      ),
    ];
    const server = new ModelServer([
      [message('Prior admitted answer.')],
      phaseOne(),
      phaseTwo(),
      [message('Fresh admitted answer.')],
      phaseOne(),
      phaseTwo(),
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
      instructions: 'Use admitted input.',
    });
    let workspace = '';
    const source = (
      pair?: ManagedWorkspaceCheckpoint,
      trustedExpected?: ManagedWorkspaceCheckpoint,
    ) => {
      const payload = pair?.workspace.providerState;
      const client = new UnixLocalSandboxClient({
        workspaceBaseDir: base,
        snapshot: { type: 'local', baseDir: join(base, 'archives') },
        ...(payload
          ? {
              resumeAuthority: {
                localSnapshotPath: (payload.snapshot as { path: string }).path,
              },
            }
          : {}),
      });
      return sandboxEnvironment({
        client,
        managedWorkspace: true,
        ...(!payload
          ? {
              snapshot: {
                type: 'local' as const,
                baseDir: join(base, 'archives'),
              },
            }
          : {}),
        manifest: new Manifest(),
        ...(payload
          ? {
              authorizedResumeState: {
                backendId: client.backendId,
                serializedState: payload,
              },
              ...(trustedExpected
                ? { authorizedResumeCheckpoint: trustedExpected }
                : {}),
            }
          : {}),
        memory: {
          phaseOne: new Agent({
            provider,
            model: 'gpt-5',
            instructions: 'Extract admitted memory.',
          }),
          phaseTwo: new Agent({
            provider,
            model: 'gpt-5',
            instructions: 'Consolidate admitted memory.',
          }),
        },
        connect: async (sandbox) => {
          workspace = sandbox.state.workspaceRootPath;
          const peer = await startPublicExecutor();
          return Environment.lease(
            new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: workspace,
              tools: [],
            }),
            peer.close,
          );
        },
      });
    };
    let original: Session | undefined;
    let restored: Session | undefined;
    try {
      original = await agent.session({ environment: source() });
      await (await original.submit('Prior genuinely admitted input.')).wait();
      const captured = await original.suspendWorkspace();
      await original.close();
      expect(server.requests).toHaveLength(3);
      const imported = ManagedWorkspaceCheckpoint.fromJSON(
        JSON.stringify(captured),
      );
      if (route === 'authenticated-import') {
        await expect(
          agent.session({ state: imported, environment: source(captured) }),
        ).rejects.toThrow(/trusted.*checkpoint/);
        expect(server.requests).toHaveLength(3);
      }
      restored = await agent.session({
        state: route === 'captured' ? captured : imported,
        environment: source(
          captured,
          route === 'authenticated-import' ? captured : undefined,
        ),
      });
      await (await restored.submit('Fresh genuinely admitted input.')).wait();
      await restored.flushMemory();
      await restored.flushMemory();
      const transcript = await readFile(
        join(workspace, 'sessions', `${restored.id}.jsonl`),
        'utf8',
      );
      expect(transcript).toContain('Prior genuinely admitted input.');
      expect(transcript).toContain('Fresh genuinely admitted input.');
      expect(JSON.stringify(server.requests.slice(4))).toContain(
        'Prior genuinely admitted input.',
      );
      expect(server.requests).toHaveLength(6);
      server.assertExhausted();
    } finally {
      await restored?.close();
      await original?.close();
      await rm(base, { recursive: true, force: true });
    }
  },
  30_000,
);
