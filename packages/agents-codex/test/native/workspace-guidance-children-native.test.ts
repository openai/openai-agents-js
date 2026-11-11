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
import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  NativeRole,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(async () => {
  vi.unstubAllEnvs();
  await ModelServer.closeAll();
});

function latestUserInstructions(request: JsonObject): string {
  for (const item of [...(request.input as JsonObject[])].reverse()) {
    if (item.role !== 'user' || !Array.isArray(item.content)) continue;
    for (const block of item.content as JsonObject[]) {
      if (
        block.type === 'input_text' &&
        typeof block.text === 'string' &&
        block.text.includes('# AGENTS.md instructions')
      )
        return block.text;
    }
  }
  throw new Error('Native user instruction snapshot missing');
}

it('uses the current root for cold descendants and excludes a concurrent foreign resource', async () => {
  const base = await mkdtemp(join(tmpdir(), 'workspace-guidance-children-'));
  const home = join(base, 'home');
  await mkdir(home);
  await writeFile(join(home, 'AGENTS.md'), 'SYNTHETIC_ORIGINAL_GLOBAL');
  vi.stubEnv('CODEX_HOME', home);
  const executor = await startPublicExecutor();
  let phase = 'initial';
  const captures = new Map<string, Map<string, JsonObject[]>>();
  const reply = (request: JsonObject) => {
    const meta = JSON.parse(
      (request.client_metadata as Record<string, string>)[
        'x-codex-turn-metadata'
      ],
    ) as { agent_name: string };
    let group = captures.get(phase);
    if (!group) captures.set(phase, (group = new Map()));
    let records = group.get(meta.agent_name);
    if (!records) group.set(meta.agent_name, (records = []));
    records.push(request);
    if (meta.agent_name === '/root') {
      if (records.length > 1) return [message('root complete')];
      if (phase === 'replacement' || phase === 'clear') {
        return [
          call(
            'followup_task',
            {
              target: '/root/alpha/grandchild',
              message: 'Read the current description.',
            },
            { namespace: 'collaboration', callId: 'wake-' + phase },
          ),
        ];
      }
      return [
        call(
          'spawn_agent',
          {
            task_name: 'alpha',
            message: 'Create a grandchild without executing other tools.',
            agent_type: 'research',
            fork_turns: 'none',
          },
          { namespace: 'collaboration', callId: 'spawn-alpha' },
        ),
      ];
    }
    if (meta.agent_name === '/root/alpha' && records.length === 1) {
      return [
        call(
          'spawn_agent',
          {
            task_name: 'grandchild',
            message: 'Read the current description without executing tools.',
            agent_type: 'research',
            fork_turns: 'none',
          },
          { namespace: 'collaboration', callId: 'spawn-grandchild' },
        ),
      ];
    }
    return [message('descendant complete')];
  };
  const server = new ModelServer(Array.from({ length: 30 }, () => reply));
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-provider',
    supportsWebsockets: false,
  });
  const environment = (cwd = executor.cwd) =>
    new Environment({
      url: executor.url,
      headers: executor.headers,
      cwd,
      tools: ['exec_command', 'write_stdin', 'apply_patch'],
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
  const source = (marker: string) =>
    sandboxEnvironment({
      client,
      manifest: new Manifest({
        root: executor.cwd,
        entries: {
          data: s3Mount({
            bucket: 'synthetic-bucket',
            description: marker,
            mountStrategy: { type: 'modal_cloud_bucket' },
          }),
        },
      }),
      connect: async () => Environment.lease(environment(), async () => {}),
    });
  const agent = new Agent({
    provider,
    model: 'gpt-6.1-sol',
    instructions: 'SYNTHETIC_APPLICATION',
    tools: [
      new NativeAgents({
        maxDepth: 2,
        maxChildren: 2,
        additionalRoles: [
          new NativeRole({
            name: 'research',
            description: 'Read current descriptions.',
            instructions:
              'Read the current description without executing tools.',
          }),
        ],
      }),
    ],
  });
  type LiveSession = Awaited<ReturnType<typeof agent.session>>;
  async function settledChildren(session: LiveSession) {
    for (;;) {
      const rows = [];
      for await (const child of session.subagents()) rows.push(child);
      if (rows.length === 2 && rows.every((child) => child.turn != null)) {
        for (const child of rows) {
          expect((await child.turn!.wait()).finalOutput).toBe(
            'descendant complete',
          );
        }
        return rows;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  const guidance = { projectGuidance: true, discoverAgentsMd: true };
  try {
    const first = await agent.session({
      ...guidance,
      environment: source('SYNTHETIC_GUIDE_A'),
    });
    let state: Awaited<ReturnType<typeof first.saveState>>;
    try {
      await (await first.submit('Create alpha and grandchild.')).wait();
      await settledChildren(first);
      state = await first.saveState();
      for (const path of ['/root/alpha', '/root/alpha/grandchild']) {
        const text = latestUserInstructions(
          captures.get('initial')!.get(path)![0]!,
        );
        expect(text).toContain('SYNTHETIC_GUIDE_A');
        expect(text).toContain('SYNTHETIC_ORIGINAL_GLOBAL');
        expect(text.match(/# Current SDK workspace snapshot/g)).toHaveLength(1);
      }
      const foreignCwd = join(executor.cwd, 'foreign');
      await mkdir(foreignCwd);
      phase = 'foreign';
      const separate = await agent.session({
        ...guidance,
        environment: environment(foreignCwd),
      });
      try {
        await (
          await separate.submit('Create a separate resource family.')
        ).wait();
        await settledChildren(separate);
        for (const path of ['/root', '/root/alpha', '/root/alpha/grandchild']) {
          const text = latestUserInstructions(
            captures.get(phase)!.get(path)![0]!,
          );
          expect(text).not.toContain('SYNTHETIC_GUIDE_A');
          expect(text).not.toContain('# Current SDK workspace snapshot');
        }
      } finally {
        await separate.close();
      }
    } finally {
      await first.close();
    }
    for (const name of ['replacement', 'clear']) {
      phase = name;
      const restored = await agent.session({
        ...guidance,
        state,
        environment:
          phase === 'replacement' ? source('SYNTHETIC_GUIDE_B') : environment(),
      });
      try {
        const before = [];
        for await (const child of restored.subagents()) before.push(child);
        expect(before).toHaveLength(2);
        expect(before.every((child) => !child.isLive)).toBe(true);
        const childIds = new Set(before.map((child) => child.id));
        const grandchildId = before.find((child) =>
          childIds.has(child.parentAgentId),
        )!.id;
        await (await restored.submit('Resume the grandchild directly.')).wait();
        for (;;) {
          const rows = [];
          for await (const child of restored.subagents()) rows.push(child);
          const grandchild = rows.find((child) => child.id === grandchildId);
          if (grandchild?.turn) {
            expect((await grandchild.turn.wait()).finalOutput).toBe(
              'descendant complete',
            );
            expect(
              rows
                .filter((child) => child.id !== grandchildId)
                .every((child) => !child.isLive && child.turn == null),
            ).toBe(true);
            break;
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(captures.get(phase)!.has('/root/alpha')).toBe(false);
        const text = latestUserInstructions(
          captures.get(phase)!.get('/root/alpha/grandchild')![0]!,
        );
        expect(text).not.toContain('SYNTHETIC_GUIDE_A');
        expect(text).toContain('SYNTHETIC_ORIGINAL_GLOBAL');
        if (phase === 'replacement') {
          expect(text).toContain('SYNTHETIC_GUIDE_B');
          expect(text.match(/# Current SDK workspace snapshot/g)).toHaveLength(
            1,
          );
        } else {
          expect(text).not.toContain('SYNTHETIC_GUIDE_B');
          expect(text).not.toContain('# Current SDK workspace snapshot');
        }
        state = await restored.saveState();
      } finally {
        await restored.close();
      }
    }
  } finally {
    await executor.close();
    await rm(base, { recursive: true, force: true });
  }
}, 45_000);
