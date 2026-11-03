import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  Agent,
  Environment,
  tool,
  type EnvironmentSource,
  type SessionState,
} from '@openai/agents';
import { call, message, ModelServer } from './fixtures/model-server';
import {
  functionOutput,
  modelInput,
  pathRule,
  providerFor,
  seedProject,
  startProjectExecutor,
  writeRule,
} from './fixtures/project-guidance/project';

afterEach(() => ModelServer.closeAll());

/** Latest native contribution; prior blocks remain explicitly superseded history. */
function currentCanonicalGuidance(request: ModelServer['requests'][number]) {
  let latest: string | undefined;
  for (const item of Array.isArray(request.input) ? request.input : []) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      item.role !== 'user' ||
      !Array.isArray(item.content)
    )
      continue;
    for (const part of item.content) {
      if (
        !part ||
        typeof part !== 'object' ||
        Array.isArray(part) ||
        part.type !== 'input_text' ||
        typeof part.text !== 'string'
      )
        continue;
      const text = part.text.trim();
      if (
        text.startsWith('<canonical_rules>') &&
        text.endsWith('</canonical_rules>')
      )
        latest = text;
    }
  }
  if (latest === undefined)
    throw new Error('Missing current native canonical guidance fragment');
  expect(latest).toMatch(
    /^<canonical_rules>(?:Current canonical project guidance; replaces all earlier canonical rules\.\n|Canonical rules cleared\. No earlier canonical rules apply\.)/,
  );
  return latest;
}

it.each(['session', 'one-shot'] as const)(
  'requires an explicit Environment before %s work when guidance is enabled',
  async (route) => {
    await using executor = await startProjectExecutor();
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const agent = new Agent({ provider, instructions: 'Answer.' });
    if (route === 'session') {
      await expect(agent.session({ projectGuidance: true })).rejects.toThrow(
        /environment/i,
      );
    } else {
      await expect(agent.run('Go.', { projectGuidance: true })).rejects.toThrow(
        /environment/i,
      );
    }
    expect(server.requests).toHaveLength(0);
    expect(executor.requests).toHaveLength(0);
    server.assertExhausted();
  },
  30_000,
);

it.each([undefined, false])(
  'leaves project guidance disabled with projectGuidance=%s',
  async (projectGuidance) => {
    await using executor = await startProjectExecutor();
    const root = join(executor.cwd, 'project');
    await seedProject(root, 'DISABLED_ORCHID');
    const server = new ModelServer([[message('done')]]);
    await using provider = await providerFor(server);
    const agent = new Agent({ provider, instructions: 'Answer.' });
    await using session = await agent.session({
      environment: executor.environment(root),
      projectGuidance,
    });
    expect((await (await session.submit('Go.')).wait()).finalOutput).toBe(
      'done',
    );
    expect(modelInput(server.requests[0]!)).not.toContain('DISABLED_ORCHID');
    expect(JSON.stringify(server.requests[0]!.tools ?? [])).not.toContain(
      'read_text_file',
    );
    expect(
      executor.requests.some((request) =>
        JSON.stringify(request.params).includes('.claude'),
      ),
    ).toBe(false);
    server.assertExhausted();
  },
  30_000,
);

it('uses the captured acquired Environment for guidance through an async source', async () => {
  await using executor = await startProjectExecutor();
  const rootA = join(executor.cwd, 'source-a');
  const rootB = join(executor.cwd, 'source-b');
  await seedProject(rootA, 'SOURCE_AZURITE');
  await seedProject(rootB, 'OTHER_JADE');
  const target = join(rootA, 'src', 'source.txt');
  const server = new ModelServer([
    (request) => {
      const guidance = currentCanonicalGuidance(request);
      expect(guidance).toContain('SOURCE_AZURITE_GENERAL');
      expect(guidance).not.toContain('SOURCE_AZURITE_SCOPED');
      expect(guidance).not.toContain('OTHER_JADE');
      expect(executor.readRequested(target)).toBe(false);
      return [
        call(
          'read_text_file',
          { path: 'src/source.txt' },
          { callId: 'source-read' },
        ),
      ];
    },
    (request) => {
      expect(JSON.stringify(functionOutput(request, 'source-read'))).toContain(
        'executor text content',
      );
      const guidance = currentCanonicalGuidance(request);
      expect(guidance).toContain('SOURCE_AZURITE_GENERAL');
      expect(guidance).toContain('SOURCE_AZURITE_SCOPED');
      expect(guidance).not.toContain('SOURCE_AZURITE_UNRELATED');
      expect(guidance).not.toContain('OTHER_JADE');
      expect(executor.readRequested(target)).toBe(true);
      return [message('source guidance succeeded')];
    },
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    provider,
    instructions: 'Read the requested file.',
  });
  const acquired = executor.environment(rootA);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const dispose = vi.fn(async () => {});
  const source = vi.fn<EnvironmentSource<undefined>>(async ({ signal }) => {
    entered.resolve();
    await release.promise;
    signal.throwIfAborted();
    return Environment.lease(acquired, dispose);
  });
  const foreignSource = vi.fn<EnvironmentSource<undefined>>(async () =>
    Environment.lease(executor.environment(rootB), () => {}),
  );
  const options = { environment: source, projectGuidance: true };
  const running = agent.run('Go.', options);
  const outcome = running.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  try {
    await Promise.race([
      entered.promise,
      outcome.then((result) => {
        if ('error' in result) throw result.error;
        throw new Error('Run completed before Environment acquisition');
      }),
    ]);
    options.environment = foreignSource;
    options.projectGuidance = false;
    release.resolve();
    expect((await running).finalOutput).toBe('source guidance succeeded');
    expect(source).toHaveBeenCalledOnce();
    expect(foreignSource).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(
      executor.readRequested(join(rootB, '.claude', 'rules', 'general.md')),
    ).toBe(false);
    expect(executor.readRequested(join(rootB, 'src', 'source.txt'))).toBe(
      false,
    );
    expect(
      executor.requests.filter((rpc) => rpc.method === 'process/start'),
    ).toHaveLength(0);
    server.assertExhausted();
  } finally {
    release.resolve();
    await outcome;
  }
}, 30_000);

it.each(['session', 'one-shot', 'intercepted-session'] as const)(
  'publishes general guidance before the first read and path guidance after a real read: %s',
  async (route) => {
    await using executor = await startProjectExecutor();
    const root = join(executor.cwd, 'project');
    await seedProject(root, 'CHOSEN_AMBER');
    await writeRule(executor.cwd, 'ancestor', 'ANCESTOR_RUBY');
    await mkdir(join(executor.cwd, '.git'));
    const target = join(root, 'src', 'source.txt');
    const server = new ModelServer([
      (request) => {
        expect(modelInput(request)).toContain('CHOSEN_AMBER_GENERAL');
        expect(modelInput(request)).not.toContain('CHOSEN_AMBER_SCOPED');
        expect(modelInput(request)).not.toContain('ANCESTOR_RUBY');
        expect(executor.readRequested(target)).toBe(false);
        return [
          call(
            'read_text_file',
            { path: 'src/source.txt' },
            { callId: 'read' },
          ),
        ];
      },
      (request) => {
        expect(JSON.stringify(functionOutput(request, 'read'))).toContain(
          'executor text content',
        );
        expect(executor.readRequested(target)).toBe(true);
        expect(modelInput(request)).toContain('CHOSEN_AMBER_SCOPED');
        expect(modelInput(request)).not.toContain('CHOSEN_AMBER_UNRELATED');
        expect(modelInput(request)).not.toContain('ANCESTOR_RUBY');
        return [message('read succeeded')];
      },
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      instructions: 'Read the requested file.',
    });
    if (route === 'one-shot') {
      expect(
        (
          await agent.run('Go.', {
            environment: executor.environment(root),
            projectGuidance: true,
          })
        ).finalOutput,
      ).toBe('read succeeded');
    } else {
      await using session = await agent.session({
        environment:
          route === 'intercepted-session'
            ? new Environment({
                url: executor.url,
                cwd: root,
                headers: executor.headers,
                tools: [],
                approval: () => true,
              })
            : executor.environment(root),
        projectGuidance: true,
      });
      expect((await (await session.submit('Go.')).wait()).finalOutput).toBe(
        'read succeeded',
      );
    }
    expect(
      executor.requests.filter((rpc) => rpc.method === 'process/start'),
    ).toHaveLength(0);
    server.assertExhausted();
  },
  30_000,
);

it('uses successful native image reads, not image arguments, as path-access evidence', async () => {
  await using executor = await startProjectExecutor();
  const root = join(executor.cwd, 'project');
  await seedProject(root, 'IMAGE_JADE');
  const target = join(root, 'src', 'pixel.png');
  const server = new ModelServer([
    (request) => {
      expect(modelInput(request)).not.toContain('IMAGE_JADE_SCOPED');
      return [call('view_image', { path: target }, { callId: 'image' })];
    },
    (request) => {
      expect(executor.readRequested(target)).toBe(true);
      expect(modelInput(request)).toContain('data:image/png;base64,');
      expect(modelInput(request)).toContain('IMAGE_JADE_SCOPED');
      expect(modelInput(request)).not.toContain('IMAGE_JADE_UNRELATED');
      return [message('image read')];
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    provider,
    instructions: 'Answer.',
  }).session({
    environment: executor.environment(root),
    projectGuidance: true,
  });
  expect((await (await session.submit('Go.')).wait()).finalOutput).toBe(
    'image read',
  );
  server.assertExhausted();
}, 30_000);

it.each([
  ['read_text_file', 'src/missing', false],
  ['view_image', 'src/missing', false],
  ['view_image', 'src/invalid.png', true],
] as const)(
  'does not activate scoped guidance for a failed %s at %s',
  async (name, path, read) => {
    await using executor = await startProjectExecutor();
    const root = join(executor.cwd, 'project');
    await seedProject(root, 'FAILED_TOPAZ');
    const server = new ModelServer([
      [call(name, { path: join(root, path) }, { callId: 'missing' })],
      (request) => {
        expect(functionOutput(request, 'missing')).toBeDefined();
        expect(modelInput(request)).toContain('FAILED_TOPAZ_GENERAL');
        expect(modelInput(request)).not.toContain('FAILED_TOPAZ_SCOPED');
        if (read) expect(executor.readRequested(join(root, path))).toBe(true);
        return [message('failure observed')];
      },
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      instructions: 'Answer.',
    }).session({
      environment: executor.environment(root),
      projectGuidance: true,
    });
    expect((await (await session.submit('Go.')).wait()).finalOutput).toBe(
      'failure observed',
    );
    server.assertExhausted();
  },
  30_000,
);

it.skipIf(process.platform === 'win32')(
  'does not activate guidance when the executor is denied a direct file read',
  async () => {
    await using executor = await startProjectExecutor();
    const root = join(executor.cwd, 'project');
    await seedProject(root, 'DENIED_BERYL');
    const target = join(root, 'src', 'private.txt');
    await writeFile(target, 'must not reach the model', { mode: 0o000 });
    const server = new ModelServer([
      [call('read_text_file', { path: target }, { callId: 'denied' })],
      (request) => {
        expect(functionOutput(request, 'denied')).toBeDefined();
        expect(modelInput(request)).not.toContain('must not reach the model');
        expect(modelInput(request)).not.toContain('DENIED_BERYL_SCOPED');
        return [message('read denied')];
      },
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      instructions: 'Answer.',
    }).session({
      environment: executor.environment(root),
      projectGuidance: true,
    });
    await (await session.submit('Go.')).wait();
    server.assertExhausted();
  },
  30_000,
);

it('does not turn foreign-root access into selected-root path guidance', async () => {
  await using executor = await startProjectExecutor();
  const root = join(executor.cwd, 'project');
  const foreign = join(executor.cwd, 'foreign');
  await seedProject(root, 'LOCAL_SAPPHIRE');
  await seedProject(foreign, 'FOREIGN_SCARLET');
  const target = join(foreign, 'src', 'source.txt');
  const server = new ModelServer([
    [call('read_text_file', { path: target }, { callId: 'foreign' })],
    (request) => {
      expect(functionOutput(request, 'foreign')).toBeDefined();
      expect(modelInput(request)).toContain('LOCAL_SAPPHIRE_GENERAL');
      expect(modelInput(request)).not.toContain('LOCAL_SAPPHIRE_SCOPED');
      expect(modelInput(request)).not.toContain('FOREIGN_SCARLET');
      return [message('foreign read did not select rules')];
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    provider,
    instructions: 'Answer.',
  }).session({
    environment: executor.environment(root),
    projectGuidance: true,
  });
  await (await session.submit('Go.')).wait();
  server.assertExhausted();
}, 30_000);

it('does not infer access from successful shell reads, listings, or application metadata', async () => {
  await using executor = await startProjectExecutor();
  const root = join(executor.cwd, 'project');
  await seedProject(root, 'NO_INFERENCE_GARNET');
  const metadata = tool({
    name: 'metadata',
    parameters: z.object({ path: z.string() }),
    execute: ({ path }) => ({
      path,
      resource_link: `file://${path}`,
      type: 'image',
    }),
  });
  const server = new ModelServer([
    [
      call(
        'exec_command',
        { cmd: 'cat src/source.txt; ls src', max_output_tokens: 1024 },
        { callId: 'shell' },
      ),
    ],
    (request) => {
      expect(JSON.stringify(functionOutput(request, 'shell'))).toContain(
        'executor text content',
      );
      expect(modelInput(request)).not.toContain('NO_INFERENCE_GARNET_SCOPED');
      return [
        call(
          'metadata',
          { path: join(root, 'src', 'pixel.png') },
          { callId: 'metadata' },
        ),
      ];
    },
    (request) => {
      expect(JSON.stringify(functionOutput(request, 'metadata'))).toContain(
        'resource_link',
      );
      expect(modelInput(request)).not.toContain('NO_INFERENCE_GARNET_SCOPED');
      return [message('no access inferred')];
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    provider,
    instructions: 'Answer.',
    tools: [metadata],
  }).session({
    environment: new Environment({
      url: executor.url,
      cwd: root,
      headers: executor.headers,
      tools: ['exec_command'],
      approval: () => true,
    }),
    projectGuidance: true,
  });
  await (await session.submit('Go.')).wait();
  expect(
    executor.requests.filter((rpc) => rpc.method === 'process/start'),
  ).toHaveLength(1);
  server.assertExhausted();
}, 30_000);

it('keeps explicit empty operation selection effective with project guidance enabled', async () => {
  await using executor = await startProjectExecutor();
  const root = join(executor.cwd, 'project');
  await seedProject(root, 'CEILING_EMERALD');
  const target = join(root, 'src', 'source.txt');
  const server = new ModelServer([
    [call('read_text_file', { path: target }, { callId: 'unselected' })],
    (request) => {
      expect(functionOutput(request, 'unselected')).toBeDefined();
      expect(
        JSON.stringify(functionOutput(request, 'unselected')),
      ).not.toContain('executor text content');
      expect(modelInput(request)).not.toContain('CEILING_EMERALD_SCOPED');
      return [message('unselected tool did not read')];
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    provider,
    instructions: 'Answer.',
  }).session({
    environment: executor.environment(root),
    projectGuidance: true,
  });
  await (await session.submit('Go.', { tools: [] })).wait();
  for (const request of server.requests) {
    expect(JSON.stringify(request.tools ?? [])).not.toMatch(
      /"name":"(?:read_text_file|view_image)"/,
    );
  }
  expect(executor.readRequested(target)).toBe(false);
  server.assertExhausted();
}, 30_000);

it('refreshes edits, additions, removals and malformed snapshots on the next inference', async () => {
  await using executor = await startProjectExecutor();
  const root = join(executor.cwd, 'project');
  await seedProject(root, 'BEFORE_OPAL');
  const tick = tool({
    name: 'tick',
    parameters: z.object({}),
    execute: () => 'next',
  });
  const server = new ModelServer([
    [call('read_text_file', { path: 'src/source.txt' }, { callId: 'read' })],
    async (request) => {
      expect(currentCanonicalGuidance(request)).toContain('BEFORE_OPAL_SCOPED');
      await writeRule(root, 'general', 'EDITED_QUARTZ_GENERAL');
      await writeRule(root, 'scoped', pathRule('EDITED_QUARTZ_SCOPED'));
      await writeRule(root, 'added', pathRule('ADDED_CITRINE'));
      return [call('tick', {}, { callId: 'edit' })];
    },
    async (request) => {
      expect(currentCanonicalGuidance(request)).toContain(
        'EDITED_QUARTZ_GENERAL',
      );
      expect(currentCanonicalGuidance(request)).toContain(
        'EDITED_QUARTZ_SCOPED',
      );
      expect(currentCanonicalGuidance(request)).toContain('ADDED_CITRINE');
      expect(currentCanonicalGuidance(request)).not.toContain('BEFORE_OPAL');
      await rm(join(root, '.claude', 'rules', 'added.md'));
      await writeRule(root, 'broken', '---\npaths: src/**\n---\nINVALID_AGATE');
      return [call('tick', {}, { callId: 'break' })];
    },
    async (request) => {
      expect(currentCanonicalGuidance(request)).not.toContain('EDITED_QUARTZ');
      expect(currentCanonicalGuidance(request)).not.toContain('ADDED_CITRINE');
      expect(currentCanonicalGuidance(request)).not.toContain('INVALID_AGATE');
      await rm(join(root, '.claude', 'rules', 'broken.md'));
      return [call('tick', {}, { callId: 'repair' })];
    },
    (request) => {
      expect(currentCanonicalGuidance(request)).toContain(
        'EDITED_QUARTZ_GENERAL',
      );
      expect(currentCanonicalGuidance(request)).not.toContain('ADDED_CITRINE');
      // Restoring identical host paths must not reuse access from the invalidated snapshot.
      expect(currentCanonicalGuidance(request)).not.toContain(
        'EDITED_QUARTZ_SCOPED',
      );
      return [message('refreshed')];
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    provider,
    instructions: 'Answer.',
    tools: [tick],
  }).session({
    environment: executor.environment(root),
    projectGuidance: true,
  });
  await (await session.submit('Go.')).wait();
  server.assertExhausted();
}, 45_000);

it('does not reuse a completed read from an earlier Turn as new access authority', async () => {
  await using executor = await startProjectExecutor();
  const root = join(executor.cwd, 'project');
  await seedProject(root, 'TURN_TOPAZ');
  const server = new ModelServer([
    [call('read_text_file', { path: 'src/source.txt' }, { callId: 'read' })],
    (request) => {
      expect(currentCanonicalGuidance(request)).toContain('TURN_TOPAZ_SCOPED');
      return [message('first done')];
    },
    (request) => {
      expect(currentCanonicalGuidance(request)).toContain('TURN_TOPAZ_GENERAL');
      expect(currentCanonicalGuidance(request)).not.toContain(
        'TURN_TOPAZ_SCOPED',
      );
      return [message('second done')];
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    provider,
    instructions: 'Answer.',
  }).session({
    environment: executor.environment(root),
    projectGuidance: true,
  });
  await (await session.submit('First.')).wait();
  await (await session.submit('Second.')).wait();
  server.assertExhausted();
}, 30_000);

it('isolates executor roots and access evidence between concurrent Sessions', async () => {
  await using executor = await startProjectExecutor();
  const rootA = join(executor.cwd, 'a');
  const rootB = join(executor.cwd, 'b');
  await seedProject(rootA, 'SESSION_A_LAPIS');
  await seedProject(rootB, 'SESSION_B_RUBY');
  const serverB = new ModelServer([
    [call('read_text_file', { path: 'src/source.txt' }, { callId: 'b-read' })],
    (request) => {
      expect(modelInput(request)).toContain('SESSION_B_RUBY_SCOPED');
      expect(modelInput(request)).not.toContain('SESSION_A_LAPIS');
      return [message('b done')];
    },
  ]);
  const serverA = new ModelServer([
    async (request) => {
      expect(modelInput(request)).toContain('SESSION_A_LAPIS_GENERAL');
      expect(modelInput(request)).not.toContain('SESSION_B_RUBY');
      await vi.waitFor(
        () => expect(serverB.requests.length).toBeGreaterThan(0),
        { timeout: 5000 },
      );
      return [
        call(
          'read_text_file',
          { path: 'src/source.txt' },
          { callId: 'a-read' },
        ),
      ];
    },
    (request) => {
      expect(modelInput(request)).toContain('SESSION_A_LAPIS_SCOPED');
      expect(modelInput(request)).not.toContain('SESSION_B_RUBY');
      return [message('a done')];
    },
  ]);
  await using providerA = await providerFor(serverA);
  await using providerB = await providerFor(serverB);
  await using sessionA = await new Agent({
    provider: providerA,
    instructions: 'Answer.',
  }).session({
    environment: executor.environment(rootA),
    projectGuidance: true,
  });
  await using sessionB = await new Agent({
    provider: providerB,
    instructions: 'Answer.',
  }).session({
    environment: executor.environment(rootB),
    projectGuidance: true,
  });
  const [a, b] = await Promise.all([
    sessionA.submit('Go.'),
    sessionB.submit('Go.'),
  ]);
  expect((await a.wait()).finalOutput).toBe('a done');
  expect((await b.wait()).finalOutput).toBe('b done');
  serverA.assertExhausted();
  serverB.assertExhausted();
}, 45_000);

it.each([
  'paths: src/**',
  'paths: []',
  'paths: [7]',
  'paths: ["../src/**"]',
  'paths: ["/src/**"]',
  'paths: ["!src/**"]',
  'paths: ["src/../**"]',
  'paths: ["src/@(a|b)"]',
])(
  'fails closed on malformed YAML-list/glob source: %s',
  async (header) => {
    await using executor = await startProjectExecutor();
    const root = join(executor.cwd, 'project');
    await seedProject(root, 'PARSER_ZIRCON');
    await writeRule(root, 'invalid', `---\n${header}\n---\nINVALID_JASPER`);
    const server = new ModelServer([
      (request) => {
        expect(modelInput(request)).not.toContain('PARSER_ZIRCON');
        expect(modelInput(request)).not.toContain('INVALID_JASPER');
        return [message('malformed snapshot refused')];
      },
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      instructions: 'Answer.',
    }).session({
      environment: executor.environment(root),
      projectGuidance: true,
    });
    await (await session.submit('Go.')).wait();
    server.assertExhausted();
  },
  30_000,
);

it.each(['rules-directory', 'parent-directory', 'rule-file'] as const)(
  'refuses linked-path rule escape through a %s',
  async (kind) => {
    await using executor = await startProjectExecutor();
    const root = join(executor.cwd, 'project');
    const foreign = join(executor.cwd, 'foreign');
    await mkdir(root, { recursive: true });
    await writeRule(foreign, 'escape', 'ESCAPED_MALACHITE');
    if (kind === 'parent-directory') {
      await symlink(join(foreign, '.claude'), join(root, '.claude'), 'dir');
    } else {
      await mkdir(join(root, '.claude'), { recursive: true });
      if (kind === 'rules-directory') {
        await symlink(
          join(foreign, '.claude', 'rules'),
          join(root, '.claude', 'rules'),
          'dir',
        );
      } else {
        await mkdir(join(root, '.claude', 'rules'));
        await symlink(
          join(foreign, '.claude', 'rules', 'escape.md'),
          join(root, '.claude', 'rules', 'escape.md'),
          'file',
        );
      }
    }
    const server = new ModelServer([
      (request) => {
        expect(modelInput(request)).not.toContain('ESCAPED_MALACHITE');
        return [message('link refused')];
      },
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      instructions: 'Answer.',
    }).session({
      environment: executor.environment(root),
      projectGuidance: true,
    });
    await (await session.submit('Go.')).wait();
    server.assertExhausted();
  },
  30_000,
);

it.each(['source', 'context', 'depth'] as const)(
  'fails closed at the pinned %s discovery limit',
  async (limit) => {
    await using executor = await startProjectExecutor();
    const root = join(executor.cwd, 'project');
    await seedProject(root, 'BOUNDED_HEMATITE');
    if (limit === 'source') {
      await writeRule(root, 'large', 'x'.repeat(32_769));
    } else if (limit === 'context') {
      await writeRule(root, 'large', 'x'.repeat(3001));
    } else {
      await mkdir(
        join(root, '.claude', 'rules', ...Array<string>(65).fill('d')),
        { recursive: true },
      );
    }
    const server = new ModelServer([
      (request) => {
        expect(modelInput(request)).not.toContain('BOUNDED_HEMATITE');
        return [message('discovery bounded')];
      },
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      instructions: 'Answer.',
    }).session({
      environment: executor.environment(root),
      projectGuidance: true,
    });
    await (await session.submit('Go.')).wait();
    server.assertExhausted();
  },
  45_000,
);

it.each(['omitted', 'false', 'fresh-root'] as const)(
  'requires fresh current opt-in and Environment after restore: %s',
  async (mode) => {
    await using executor = await startProjectExecutor();
    const sourceRoot = join(executor.cwd, 'source');
    const destination = join(executor.cwd, 'destination');
    await seedProject(sourceRoot, 'SAVED_EMERALD');
    await seedProject(destination, 'CURRENT_AQUAMARINE');
    const server = new ModelServer([
      [
        call(
          'read_text_file',
          { path: 'src/source.txt' },
          { callId: 'saved-read' },
        ),
      ],
      (request) => {
        expect(JSON.stringify(functionOutput(request, 'saved-read'))).toContain(
          'executor text content',
        );
        expect(modelInput(request)).toContain('SAVED_EMERALD_SCOPED');
        return [message('saved')];
      },
      [message('restored')],
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({ provider, instructions: 'Answer.' });
    let state: SessionState;
    {
      await using source = await agent.session({
        environment: executor.environment(sourceRoot),
        projectGuidance: true,
      });
      await (await source.submit('Go.')).wait();
      expect(modelInput(server.requests[0]!)).toContain(
        'SAVED_EMERALD_GENERAL',
      );
      state = await source.saveState();
    }
    await writeRule(sourceRoot, 'general', 'SOURCE_CHANGED_AFTER_SAVE');
    const beforeRestore = executor.requests.length;
    await using restored = await agent.session({
      state,
      ...(mode === 'omitted'
        ? {}
        : { environment: executor.environment(destination) }),
      ...(mode === 'fresh-root'
        ? { projectGuidance: true }
        : mode === 'false'
          ? { projectGuidance: false }
          : {}),
    });
    await (await restored.submit('Continue.', { tools: [] })).wait();
    const request = server.requests[2]!;
    expect(modelInput(request)).not.toContain('SOURCE_CHANGED_AFTER_SAVE');
    const guidance = currentCanonicalGuidance(request);
    if (mode !== 'fresh-root') {
      expect(guidance).toBe(
        '<canonical_rules>Canonical rules cleared. No earlier canonical rules apply.</canonical_rules>',
      );
    }
    expect(guidance.includes('CURRENT_AQUAMARINE_GENERAL')).toBe(
      mode === 'fresh-root',
    );
    expect(guidance).not.toContain('CURRENT_AQUAMARINE_SCOPED');
    expect(guidance).not.toContain('SAVED_EMERALD_SCOPED');
    expect(JSON.stringify(request.tools ?? [])).not.toMatch(
      /"name":"(?:read_text_file|view_image)"/,
    );
    const newDiscovery = executor.requests.slice(beforeRestore);
    expect(JSON.stringify(newDiscovery)).not.toContain(
      join(sourceRoot, '.claude'),
    );
    if (mode !== 'fresh-root') {
      expect(JSON.stringify(newDiscovery)).not.toContain('.claude');
    }
    server.assertExhausted();
  },
  45_000,
);

it('does not let a saved checkpoint supply the Environment for current opt-in', async () => {
  await using executor = await startProjectExecutor();
  const root = join(executor.cwd, 'project');
  await seedProject(root, 'CHECKPOINT_TURQUOISE');
  const server = new ModelServer([[message('saved')]]);
  await using provider = await providerFor(server);
  const agent = new Agent({ provider, instructions: 'Answer.' });
  let state: SessionState;
  {
    await using source = await agent.session({
      environment: executor.environment(root),
      projectGuidance: true,
    });
    await (await source.submit('Go.')).wait();
    state = await source.saveState();
  }
  const beforeRestore = executor.requests.length;
  await expect(agent.session({ state, projectGuidance: true })).rejects.toThrow(
    /environment/i,
  );
  expect(server.requests).toHaveLength(1);
  expect(executor.requests).toHaveLength(beforeRestore);
  server.assertExhausted();
}, 30_000);
