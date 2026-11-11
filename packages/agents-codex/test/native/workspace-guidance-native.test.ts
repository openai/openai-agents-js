import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Manifest,
  sandboxEnvironment,
  s3Mount,
  normalizeSandboxClientCreateArgs,
  type SandboxClient,
} from '@openai/agents/sandbox';
import { Agent, Environment, NativeProvider } from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(async () => {
  vi.unstubAllEnvs();
  await ModelServer.closeAll();
});

function latestUserInstructions(request: JsonObject): string {
  const input = request.input as JsonObject[];
  for (const item of [...input].reverse()) {
    if (item.role !== 'user' || !Array.isArray(item.content)) continue;
    for (const block of item.content as JsonObject[]) {
      if (
        block.type === 'input_text' &&
        typeof block.text === 'string' &&
        block.text.includes('# AGENTS.md instructions')
      ) {
        return block.text;
      }
    }
  }
  throw new Error('Native user instruction snapshot missing');
}

it('retains original providers and replaces or clears only current workspace guidance', async () => {
  const base = await mkdtemp(join(tmpdir(), 'workspace-guidance-native-'));
  const home = join(base, 'codex-home');
  const workspace = join(base, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  const globalFile = join(home, 'AGENTS.md');
  await writeFile(globalFile, 'SYNTHETIC_GLOBAL_A');
  await writeFile(join(workspace, 'AGENTS.md'), 'SYNTHETIC_PROJECT_RULE');
  vi.stubEnv('CODEX_HOME', home);
  const peer = await startPublicExecutor();
  const server = new ModelServer(
    Array.from({ length: 4 }, () => [message('done')]),
  );
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-provider',
    supportsWebsockets: false,
  });
  const environment = () =>
    new Environment({
      url: peer.url,
      headers: peer.headers,
      cwd: workspace,
      tools: [],
    });
  const source = (marker: string) => {
    const manifest = new Manifest({
      root: workspace,
      entries: {
        data: s3Mount({
          bucket: 'synthetic-bucket',
          description: marker,
          secretAccessKey: 'SYNTHETIC_MOUNT_SECRET',
          accessKeyId: 'synthetic-id',
          mountStrategy: { type: 'modal_cloud_bucket' },
        }),
      },
      environment: { PRIVATE: 'SYNTHETIC_ENV_SECRET' },
    });
    const client: SandboxClient = {
      backendId: 'fixture',
      async create(args) {
        return {
          state: { manifest: normalizeSandboxClientCreateArgs(args).manifest },
          async close() {},
        };
      },
      async delete() {},
    };
    return sandboxEnvironment({
      client,
      manifest,
      connect: async () => Environment.lease(environment(), async () => {}),
    });
  };
  const agent = new Agent({
    provider,
    model: 'gpt-5',
    instructions: 'SYNTHETIC_APPLICATION',
  });
  const guidance = { projectGuidance: true, discoverAgentsMd: true };
  try {
    const first = await agent.session({
      ...guidance,
      environment: source('SYNTHETIC_GUIDE_A'),
    });
    let state: Awaited<ReturnType<typeof first.saveState>>;
    try {
      await (await first.submit('First capture')).wait();
      await writeFile(globalFile, 'SYNTHETIC_GLOBAL_B');
      await (await first.submit('Refresh original provider')).wait();
      state = await first.saveState();
    } finally {
      await first.close();
    }
    const firstText = latestUserInstructions(server.requests[0]!);
    expect(firstText).toContain('SYNTHETIC_GLOBAL_A');
    expect(firstText).toContain('SYNTHETIC_PROJECT_RULE');
    expect(firstText).toContain('SYNTHETIC_GUIDE_A');
    const refreshed = latestUserInstructions(server.requests[1]!);
    expect(refreshed).toContain('SYNTHETIC_GLOBAL_B');
    expect(refreshed).not.toContain('SYNTHETIC_GLOBAL_A');
    expect(refreshed.match(/# Current SDK workspace snapshot/g)).toHaveLength(
      1,
    );
    const second = await agent.session({
      ...guidance,
      state,
      environment: source('SYNTHETIC_GUIDE_B'),
    });
    try {
      await (await second.submit('Current capture B')).wait();
      state = await second.saveState();
    } finally {
      await second.close();
    }
    const current = latestUserInstructions(server.requests[2]!);
    expect(current).toContain('SYNTHETIC_GUIDE_B');
    expect(current).not.toContain('SYNTHETIC_GUIDE_A');
    expect(current).toContain('SYNTHETIC_GLOBAL_B');
    expect(current).toContain('SYNTHETIC_PROJECT_RULE');
    const cleared = await agent.session({
      ...guidance,
      state,
      environment: environment(),
    });
    try {
      await (await cleared.submit('Only current original instructions')).wait();
    } finally {
      await cleared.close();
    }
    const clearedText = latestUserInstructions(server.requests[3]!);
    expect(clearedText).not.toContain('# Current SDK workspace snapshot');
    expect(clearedText).not.toContain('SYNTHETIC_GUIDE_A');
    expect(clearedText).not.toContain('SYNTHETIC_GUIDE_B');
    for (const request of server.requests) {
      const body = JSON.stringify(request);
      expect(body).toContain('SYNTHETIC_APPLICATION');
      expect(body).not.toContain('SYNTHETIC_ENV_SECRET');
      expect(body).not.toContain('SYNTHETIC_MOUNT_SECRET');
      expect(body).not.toContain('user_instructions_appendix');
    }
  } finally {
    await peer.close();
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);
