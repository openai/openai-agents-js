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

it.each([
  ['create', ['fixture-mount', 'fixture-unmount']],
  ['borrow', []],
  ['read-only boundary', undefined],
  [
    'oversized command allowlist',
    Array.from({ length: 2500 }, (_, index) => `fixture-mount-${index}`),
  ],
] as const)(
  'opens with oversized mount guidance and discovery off (%s)',
  async (opening, commands) => {
    const readOnly = opening === 'read-only boundary';
    const base = await mkdtemp(join(tmpdir(), 'bounded-workspace-guidance-'));
    const home = join(base, 'codex-home');
    const workspace = join(base, 'workspace');
    await mkdir(home);
    await mkdir(workspace);
    await writeFile(join(home, 'AGENTS.md'), 'UNDISCOVERED_GLOBAL_RULE');
    await writeFile(join(workspace, 'AGENTS.md'), 'UNDISCOVERED_PROJECT_RULE');
    vi.stubEnv('CODEX_HOME', home);
    const peer = await startPublicExecutor();
    try {
      const server = new ModelServer([[message('done')]]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-provider',
        supportsWebsockets: false,
      });
      // This path and description filled the previous compact rendering to
      // exactly 40,000 UTF-8 bytes, leaving no room for the executor warning.
      const mountRoot = readOnly
        ? '/workspace/fixtures/workspace-guidance-boundary'
        : workspace;
      const manifest = new Manifest({
        root: mountRoot,
        remoteMountCommandAllowlist:
          commands === undefined ? undefined : [...commands],
        entries: {
          ...(!readOnly && {
            data: s3Mount({
              bucket: 'synthetic-data',
              description: '📚'.repeat(11_000),
              mountStrategy: { type: 'modal_cloud_bucket' },
            }),
          }),
          output: s3Mount({
            bucket: 'synthetic-output',
            readOnly: false,
            description: readOnly
              ? 'x'.repeat(39_213)
              : 'Keep this short description.',
            mountStrategy: { type: 'modal_cloud_bucket' },
          }),
          ...(!readOnly && {
            src: {
              type: 'dir',
              children: {
                'café.ts': { type: 'file', content: 'export {};\n' },
              },
            },
          }),
        },
      });
      const sandbox = { state: { manifest }, async close() {} };
      const client: SandboxClient = {
        backendId: 'fixture',
        async create(args) {
          return {
            ...sandbox,
            state: {
              manifest: normalizeSandboxClientCreateArgs(args).manifest,
            },
          };
        },
      };
      const environment = sandboxEnvironment({
        client,
        manifest,
        ...(opening === 'borrow' ? { session: sandbox } : {}),
        connect: async () =>
          Environment.lease(
            new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: workspace,
              readOnly,
              tools: [],
            }),
            async () => {},
          ),
      });
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'SYNTHETIC_APPLICATION',
      });
      const session = await agent.session({
        environment,
        discoverAgentsMd: false,
      });
      try {
        await (await session.submit('Read current workspace guidance')).wait();
      } finally {
        await session.close();
      }
      const request = server.requests[0]!;
      const text = latestUserInstructions(request);
      expect(text).toContain('# Current SDK workspace snapshot');
      expect(text.includes(`Executor read-only: ${readOnly}`)).toBe(true);
      if (!readOnly) {
        const layout = text.split('Filesystem layout:\n')[1]?.split('\n\n')[0];
        expect(layout).toBe(
          JSON.stringify([
            `${join(mountRoot, 'src')}/`,
            join(mountRoot, 'src/café.ts'),
          ]),
        );
      }
      if (opening === 'borrow' || opening === 'oversized command allowlist') {
        expect(
          text.includes('Do not use remote mount management commands.'),
        ).toBe(true);
        expect(text).not.toContain('Allowed remote mount commands:');
        expect(text).not.toContain('fixture-mount-0');
      } else {
        const allowlist = JSON.stringify(manifest.remoteMountCommandAllowlist);
        expect(
          text.includes(`Allowed remote mount commands: ${allowlist}.`),
        ).toBe(true);
      }
      const storage = text
        .split('Declared storage access:\n')[1]
        ?.split('\n\n')[0];
      expect(JSON.parse(storage ?? 'null')).toEqual([
        ...(!readOnly
          ? [{ path: join(mountRoot, 'data'), access: 'read_only' }]
          : []),
        {
          path: join(mountRoot, 'output'),
          access: 'read_write',
          ...(!readOnly && { description: 'Keep this short description.' }),
        },
      ]);
      const body = JSON.stringify(request);
      expect(body).toContain('SYNTHETIC_APPLICATION');
      expect(body).not.toContain('UNDISCOVERED_GLOBAL_RULE');
      expect(body).not.toContain('UNDISCOVERED_PROJECT_RULE');
    } finally {
      await peer.close();
      await rm(base, { recursive: true, force: true });
    }
  },
  30_000,
);
