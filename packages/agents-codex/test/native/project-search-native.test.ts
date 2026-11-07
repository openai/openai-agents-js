import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeError,
  fileSessionStore,
  localStorage,
  tool,
  toolRef,
  type ExecutorContext,
  type SessionState,
} from '@openai/agents';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import {
  providerFor,
  functionOutput,
} from './fixtures/project-guidance/project';
import { startPublicExecutor } from './fixtures/public-executor';
import { nativeDescendantModel } from './fixtures/native-descendant-model';

const execute = promisify(execFile);

afterEach(async () => {
  await ModelServer.closeAll();
});

async function workspace(kind: 'local' | 'remote' = 'remote') {
  const executor = kind === 'remote' ? await startPublicExecutor() : undefined;
  const directory =
    executor?.cwd ?? (await mkdtemp(join(tmpdir(), 'agents-search-')));
  const root = await realpath(directory);
  await mkdir(join(root, 'src'));
  await mkdir(join(root, '.hidden'));
  await writeFile(
    join(root, 'src', 'alpha.ts'),
    'before\nneedle alpha\nafter\n',
  );
  await writeFile(join(root, 'src', 'beta.ts'), 'needle beta\n');
  await writeFile(join(root, '.hidden', 'secret.ts'), 'needle hidden\n');
  await writeFile(join(root, '.gitignore'), 'src/\n.hidden/\n');
  return {
    root,
    environment(
      tools: NonNullable<ConstructorParameters<typeof Environment>[0]['tools']>,
      cwd = root,
    ) {
      const options = { cwd, tools };
      return executor
        ? new Environment({
            ...options,
            url: executor.url,
            headers: executor.headers,
          })
        : Environment.local(options);
    },
    async [Symbol.asyncDispose]() {
      if (executor) await executor.close();
      else await rm(directory, { recursive: true, force: true });
    },
  };
}

function output(request: ModelServer['requests'][number], id: string): string {
  const item = functionOutput(request, id);
  if (!item || typeof item !== 'object' || Array.isArray(item))
    throw new Error(`Missing function output for ${id}`);
  return String(item.output);
}

function result(
  request: ModelServer['requests'][number],
  id: string,
): JsonObject {
  return JSON.parse(output(request, id)) as JsonObject;
}

function wireToolNames(request: JsonObject): string[] {
  const names: string[] = [];
  function add(value: unknown, namespace?: string): void {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (entry.type === 'namespace') add(entry.tools, entry.name);
      else if (entry.type === 'function' || entry.type === 'custom')
        names.push(
          namespace && namespace !== 'functions'
            ? `${namespace}.${entry.name}`
            : entry.name,
        );
    }
  }
  add(request.tools);
  if (Array.isArray(request.input))
    for (const item of request.input)
      if (
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        item.type === 'additional_tools'
      )
        add(item.tools);
  return names.sort();
}

it.each([false, true])(
  'allows application search names with native search disabled (Environment=%s)',
  async (withEnvironment) => {
    await using project = await workspace();
    const invoked: string[] = [];
    const names = ['project_glob', 'project_grep'];
    const tools = names.map((name) =>
      tool({
        name,
        parameters: z.object({}),
        execute: () => {
          invoked.push(name);
          return `application ${name}`;
        },
      }),
    );
    const server = new ModelServer([
      (request) => {
        expect(wireToolNames(request)).toEqual(names);
        return [call('project_glob', {}, { callId: 'application-glob' })];
      },
      (request) => {
        expect(output(request, 'application-glob')).toContain(
          'application project_glob',
        );
        return [call('project_grep', {}, { callId: 'application-grep' })];
      },
      (request) => {
        expect(output(request, 'application-grep')).toContain(
          'application project_grep',
        );
        return [message('application tools completed')];
      },
    ]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      provider,
      instructions: 'Use application tools.',
      tools,
    });
    await agent.validate();
    const answer = await agent.run(
      'Run both tools.',
      withEnvironment ? { environment: project.environment([]) } : {},
    );
    expect(answer.finalOutput).toBe('application tools completed');
    expect(invoked).toEqual(names);
    server.assertExhausted();
  },
  30_000,
);

it.each(['project_glob', 'project_grep'] as const)(
  'rejects an application collision with selected native %s before model access',
  async (name) => {
    await using project = await workspace();
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    let invoked = false;
    const agent = new Agent({
      provider,
      instructions: 'Do not open conflicting tools.',
      tools: [
        tool({
          name,
          parameters: z.object({}),
          execute: () => {
            invoked = true;
            return 'unexpected';
          },
        }),
      ],
    });
    await expect(
      agent.session({ environment: project.environment([name]) }),
    ).rejects.toThrow(`Duplicate selected tool functions.${name}`);
    expect(invoked).toBe(false);
    expect(server.requests).toHaveLength(0);
  },
);

it.each(['project_glob', 'project_grep'] as const)(
  'reserves only selected native %s and preserves the application update ceiling',
  async (nativeName) => {
    await using project = await workspace();
    const applicationName =
      nativeName === 'project_glob' ? 'project_grep' : 'project_glob';
    const invoked: string[] = [];
    const application = (value: string, name = applicationName) =>
      tool({
        name,
        parameters: z.object({}),
        execute: () => {
          invoked.push(value);
          return value;
        },
      });
    const server = new ModelServer([
      (request) => {
        expect(wireToolNames(request)).toEqual([
          'project_glob',
          'project_grep',
        ]);
        return [call(applicationName, {}, { callId: 'application-first' })];
      },
      (request) => {
        expect(output(request, 'application-first')).toContain(
          'original callback',
        );
        return [message('first completed')];
      },
      [call(applicationName, {}, { callId: 'application-updated' })],
      (request) => {
        expect(output(request, 'application-updated')).toContain(
          'updated callback',
        );
        return [
          call(
            nativeName,
            { pattern: nativeName === 'project_glob' ? '**/*.ts' : 'needle' },
            { callId: 'native-search' },
          ),
        ];
      },
      (request) => {
        const found = result(request, 'native-search');
        expect(found.errors).toEqual([]);
        expect(found.matches).toHaveLength(3);
        return [message('update completed')];
      },
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      instructions: 'Use the distinct application and native tools.',
      tools: [application('original callback')],
    }).session({ environment: project.environment([nativeName]) });
    expect(
      (await (await session.submit('Run application tool.')).wait())
        .finalOutput,
    ).toBe('first completed');
    await expect(
      session.update({
        tools: [application('unexpected native replacement', nativeName)],
      }),
    ).rejects.toThrow(
      'Updated tools must have been declared when the Session opened',
    );
    await session.update({ tools: [application('updated callback')] });
    expect(
      (
        await (
          await session.submit('Run updated tool and native search.')
        ).wait()
      ).finalOutput,
    ).toBe('update completed');
    expect(invoked).toEqual(['original callback', 'updated callback']);
    server.assertExhausted();
  },
  30_000,
);

it.for(['local', 'remote'] as const)(
  'searches the selected %s workspace without command grants or project guidance',
  { timeout: 30_000 },
  async (kind, context) => {
    await using project = await workspace(kind);
    const server = new ModelServer([
      (request) => {
        const names = wireToolNames(request);
        expect(names).toEqual(
          expect.arrayContaining(['project_glob', 'project_grep']),
        );
        for (const name of ['exec_command', 'write_stdin', 'apply_patch'])
          expect(names).not.toContain(name);
        return [
          call('project_glob', { pattern: '**/*.ts' }, { callId: 'glob' }),
        ];
      },
      (request) => {
        const found = result(request, 'glob');
        expect(found.matches).toHaveLength(3);
        expect(found.matches).toEqual(
          expect.arrayContaining([
            '.hidden/secret.ts',
            'src/alpha.ts',
            'src/beta.ts',
          ]),
        );
        expect(found).toMatchObject({
          truncated: false,
          truncation_reasons: [],
          errors: [],
        });
        return [
          call(
            'project_grep',
            {
              pattern: '^needle alpha$',
              path: 'src',
              glob: '*.ts',
              context_lines: 1,
            },
            { callId: 'grep' },
          ),
        ];
      },
      (request) => {
        expect(result(request, 'grep')).toMatchObject({
          matches: [
            {
              path: 'src/alpha.ts',
              line_number: 2,
              line: 'needle alpha',
              before: [{ line_number: 1, line: 'before' }],
              after: [{ line_number: 3, line: 'after' }],
            },
          ],
          truncated: false,
          truncation_reasons: [],
          errors: [],
        });
        return [message('searched')];
      },
    ]);
    await using provider = await providerFor(server);
    const answer = await new Agent({
      provider,
      instructions: 'Search the project.',
    })
      .run('Search.', {
        environment: project.environment(['project_glob', 'project_grep']),
      })
      .catch((error: unknown) => {
        if (
          kind === 'local' &&
          typeof error === 'object' &&
          error !== null &&
          'message' in error &&
          error.message ===
            'local executor could not establish the platform sandbox' &&
          process.env.GITHUB_ACTIONS !== 'true' &&
          process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1' &&
          process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
        ) {
          expect(server.requests).toHaveLength(0);
          context.skip('This host cannot launch a nested platform sandbox');
        }
        throw error;
      });
    expect(answer.finalOutput).toBe('searched');
    server.assertExhausted();
  },
);

it('bounds results and permits a narrower rerun after truncation', async () => {
  await using project = await workspace();
  const server = new ModelServer([
    [
      call(
        'project_glob',
        { pattern: '**/*.ts', max_results: 1 },
        { callId: 'limited' },
      ),
    ],
    (request) => {
      const limited = result(request, 'limited');
      expect(limited.matches).toHaveLength(1);
      expect(limited.truncated).toBe(true);
      expect(limited.truncation_reasons).not.toEqual([]);
      expect(limited).not.toHaveProperty('cursor');
      return [
        call(
          'project_glob',
          { pattern: 'alpha.ts', path: 'src' },
          { callId: 'narrow' },
        ),
      ];
    },
    (request) => {
      expect(result(request, 'narrow')).toMatchObject({
        matches: ['src/alpha.ts'],
        truncated: false,
      });
      return [message('narrowed')];
    },
  ]);
  await using provider = await providerFor(server);
  await new Agent({ provider, instructions: 'Search.' }).run('Go.', {
    environment: project.environment(['project_glob']),
  });
  server.assertExhausted();
}, 30_000);

it('defaults to at most 100 grep matches', async () => {
  await using project = await workspace();
  await writeFile(join(project.root, 'many.txt'), 'needle\n'.repeat(101));
  const server = new ModelServer([
    [
      call(
        'project_grep',
        { pattern: 'needle', glob: 'many.txt' },
        { callId: 'default-limit' },
      ),
    ],
    (request) => {
      const found = result(request, 'default-limit');
      expect(found.matches).toHaveLength(100);
      expect(found.truncated).toBe(true);
      expect(found.truncation_reasons).not.toEqual([]);
      return [message('bounded')];
    },
  ]);
  await using provider = await providerFor(server);
  await new Agent({ provider, instructions: 'Search.' }).run('Go.', {
    environment: project.environment(['project_grep']),
  });
  server.assertExhausted();
}, 30_000);

it('exposes structured search matches to generated code', async () => {
  await using project = await workspace();
  const server = new ModelServer([
    [
      {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'search-cell',
        input:
          'const found = await tools.project_grep({pattern:"needle alpha",path:"src"}); ' +
          'text({path:found.matches[0].path,line_number:found.matches[0].line_number,truncated:found.truncated});',
      },
    ],
    (request) => {
      const items = request.input as JsonObject[];
      const cell = items.find(
        (item) =>
          item.type === 'custom_tool_call_output' &&
          item.call_id === 'search-cell',
      );
      expect(cell).toBeDefined();
      const text = JSON.stringify(cell!.output);
      expect(text).toContain('src/alpha.ts');
      expect(text).toMatch(/line_number[^0-9]*2/);
      expect(text).toMatch(/truncated[^a-z]*false/);
      return [message('code searched')];
    },
  ]);
  await using provider = await providerFor(server);
  const answer = await new Agent({
    provider,
    model: nativeDescendantModel,
    instructions: 'Search through code.',
    programmaticToolCalling: true,
  }).run('Go.', { environment: project.environment(['project_grep']) });
  expect(answer.finalOutput).toBe('code searched');
  server.assertExhausted();
}, 30_000);

it.each([false, true])(
  'transforms search results exactly once with code=%s and no before policy',
  async (code) => {
    await using project = await workspace();
    const calls: ExecutorContext[] = [];
    const connection = project.environment(['project_grep']);
    const environment = new Environment({
      url: connection.url,
      cwd: connection.cwd,
      headers: connection.headers,
      tools: connection.tools,
      transformResult(context, value) {
        calls.push(context);
        expect(value).toMatchObject({
          matches: [expect.objectContaining({ line: 'needle alpha' })],
        });
        return {
          ...(value as JsonObject),
          matches: [
            {
              path: 'src/alpha.ts',
              line_number: 2,
              line: 'redacted search result',
              before: [],
              after: [],
            },
          ],
        };
      },
    });
    const server = new ModelServer([
      code
        ? [
            {
              type: 'custom_tool_call',
              name: 'exec',
              call_id: 'transformed-cell',
              input:
                'const found = await tools.project_grep({pattern:"needle alpha",path:"src"}); text(found.matches[0].line);',
            },
          ]
        : [
            call(
              'project_grep',
              { pattern: 'needle alpha', path: 'src' },
              { callId: 'transformed-search' },
            ),
          ],
      (request) => {
        const item = (request.input as JsonObject[]).find(
          (item) =>
            item.call_id ===
              (code ? 'transformed-cell' : 'transformed-search') &&
            item.type ===
              (code ? 'custom_tool_call_output' : 'function_call_output'),
        );
        expect(item).toBeDefined();
        expect(JSON.stringify(item!.output)).toContain(
          'redacted search result',
        );
        expect(JSON.stringify(item!.output)).not.toContain('needle alpha');
        return [message('transformed once')];
      },
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      model: nativeDescendantModel,
      instructions: 'Search.',
      programmaticToolCalling: code,
    }).session({ environment });
    const turn = await session.submit('Go.');
    expect((await turn.wait()).finalOutput).toBe('transformed once');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.submission).toBe(turn);
    expect(calls[0]?.call?.route).toBe(code ? 'code' : 'direct');
    server.assertExhausted();
  },
  30_000,
);

it.each(['direct-accept', 'code-accept', 'direct-reject', 'code-reject'])(
  'withholds search from the native log consumer until result policy accepts it: %s',
  async (mode) => {
    const child = fileURLToPath(
      new URL('./fixtures/project-search-logs-child.ts', import.meta.url),
    );
    const result = await execute(
      process.execPath,
      ['--import', 'tsx', child, mode],
      { timeout: 25_000, maxBuffer: 1024 * 1024 },
    );
    expect(result.stdout).toContain(`PASS ${mode}`);
  },
  30_000,
);

it('joins a pending search approval on cancellation and preserves the successor turn', async () => {
  await using project = await workspace();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let joined = false;
  const connection = project.environment(['project_grep']);
  const environment = new Environment({
    url: connection.url,
    cwd: connection.cwd,
    headers: connection.headers,
    tools: connection.tools,
    async approval(context) {
      expect(context.toolName).toBe('project_grep');
      entered.resolve();
      await release.promise;
      joined = true;
      return true;
    },
  });
  const server = new ModelServer([
    [
      call(
        'project_grep',
        { pattern: 'needle alpha' },
        { callId: 'pending-search' },
      ),
    ],
    (request) => {
      expect(
        JSON.stringify(functionOutput(request, 'pending-search') ?? ''),
      ).not.toContain('src/alpha.ts');
      return [message('successor survived')];
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    provider,
    instructions: 'Search.',
  }).session({ environment });
  let cancellation: Promise<void> | undefined;
  try {
    const turn = await session.submit('Go.');
    const outcome = turn.wait().catch((error: unknown) => error);
    await entered.promise;
    let cancelled = false;
    cancellation = turn.cancel().then(() => {
      cancelled = true;
    });
    await delay(30);
    expect(cancelled).toBe(false);
    expect(joined).toBe(false);
    release.resolve();
    await cancellation;
    expect(joined).toBe(true);
    expect(await outcome).toMatchObject({ name: 'TurnAborted' });
    const successor = await session.submit('Continue.');
    expect((await successor.wait()).finalOutput).toBe('successor survived');
    server.assertExhausted();
  } finally {
    release.resolve();
    await cancellation;
  }
}, 30_000);

it('rejects paths outside the root and unsupported search arguments', async () => {
  await using project = await workspace();
  const invalid: { arguments: JsonObject; code: string }[] = [
    ...['..', 'src/../src', '/tmp', 'file:///tmp', 'src\\alpha.ts'].map(
      (path) => ({
        arguments: { pattern: 'needle', path },
        code: 'invalid_path',
      }),
    ),
    {
      arguments: { pattern: 'needle', max_results: 1001 },
      code: 'invalid_argument',
    },
    {
      arguments: { pattern: 'needle', max_results: 0 },
      code: 'invalid_argument',
    },
    {
      arguments: { pattern: 'needle', context_lines: 6 },
      code: 'invalid_argument',
    },
    { arguments: { pattern: '[' }, code: 'invalid_pattern' },
    {
      arguments: { pattern: 'needle', cwd: project.root },
      code: 'invalid_argument',
    },
    {
      arguments: { pattern: 'needle', path: 'missing' },
      code: 'path_unavailable',
    },
  ];
  const server = new ModelServer([
    invalid.map((entry, index) =>
      call('project_grep', entry.arguments, { callId: `invalid-${index}` }),
    ),
    (request) => {
      for (let index = 0; index < invalid.length; index++) {
        const text = output(request, `invalid-${index}`);
        expect(text).not.toContain('needle alpha');
        expect(result(request, `invalid-${index}`)).toMatchObject({
          matches: [],
          errors: expect.arrayContaining([
            expect.objectContaining({ code: invalid[index]!.code }),
          ]),
        });
      }
      return [message('rejected')];
    },
  ]);
  await using provider = await providerFor(server);
  await new Agent({ provider, instructions: 'Search.' }).run('Go.', {
    environment: project.environment(['project_grep']),
  });
  server.assertExhausted();
}, 30_000);

it.each(
  (['project_glob', 'project_grep'] as const).flatMap((name) =>
    [
      ...[
        { label: 'TAB', control: '\t' },
        { label: 'LF', control: '\n' },
        { label: 'CR', control: '\r' },
      ].map(({ label, control }) => ({
        label,
        path: `sec${control}rets`,
        deniedPath: 'secrets',
      })),
      {
        label: 'leading dot segment',
        path: './secrets',
        deniedPath: 'secrets',
      },
      {
        label: 'embedded dot segment',
        path: 'public/./secrets',
        deniedPath: 'public/secrets',
      },
    ].map((entry) => ({ name, ...entry })),
  ),
)(
  '$name rejects $label in approved paths before filesystem access',
  async ({ name, path, deniedPath }) => {
    const executor = await startPublicExecutor();
    try {
      const root = await realpath(executor.cwd);
      await mkdir(join(root, deniedPath), { recursive: true });
      const privateContent = 'private control-path needle 927a';
      await writeFile(join(root, deniedPath, 'secret.txt'), privateContent);
      const approvedPaths: string[] = [];
      let requestIndex = 0;
      let found: JsonObject | undefined;
      const server = new ModelServer([
        [
          call(
            name,
            { pattern: name === 'project_glob' ? '*' : 'needle', path },
            { callId: 'control-path' },
          ),
        ],
        (request) => {
          found = result(request, 'control-path');
          return [message('searched')];
        },
      ]);
      await using provider = await providerFor(server);
      await new Agent({ provider, instructions: 'Search.' }).run('Go.', {
        environment: new Environment({
          url: executor.url,
          cwd: root,
          headers: executor.headers,
          tools: [name],
          approval(context, argumentsValue) {
            expect(context.toolName).toBe(name);
            const args = z.object({ path: z.string() }).parse(argumentsValue);
            approvedPaths.push(args.path);
            requestIndex = executor.requests.length;
            return (
              args.path !== deniedPath &&
              !args.path.startsWith(`${deniedPath}/`)
            );
          },
        }),
      });
      expect(approvedPaths).toEqual([path]);
      expect.soft(found).toMatchObject({
        matches: [],
        errors: [{ path, code: 'invalid_path' }],
        truncated: false,
      });
      expect
        .soft(
          executor.requests
            .slice(requestIndex)
            .filter((request) =>
              ['fs/walk', 'fs/readFile'].includes(String(request.method)),
            ),
        )
        .toEqual([]);
      expect
        .soft(JSON.stringify(server.requests))
        .not.toContain(privateContent);
      expect.soft(JSON.stringify(server.requests)).not.toContain('secret.txt');
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  30_000,
);

it
  .skipIf(process.platform === 'win32')
  .each(
    (['project_glob', 'project_grep'] as const).flatMap((name) =>
      ['.', 'narrow'].map((path) => ({ name, path })),
    ),
  )(
  '$name preserves literal filesystem names below path=$path',
  async ({ name, path }) => {
    const executor = await startPublicExecutor();
    try {
      const parent = await realpath(executor.cwd);
      const root = join(parent, 'project');
      const subtree = path === '.' ? root : join(root, path);
      await mkdir(join(subtree, 'nested'), { recursive: true });
      await mkdir(join(subtree, 'dir\nname'));
      const outsideCanary = 'entry-marker outside selected subtree 927a';
      await writeFile(
        join(path === '.' ? parent : root, 'outside.txt'),
        outsideCanary,
      );
      const files = [
        ['secrets', 'entry-marker ordinary'],
        ['sec\trets', 'entry-marker tab'],
        ['sec\nrets', 'entry-marker newline'],
        ['sec\rrets', 'entry-marker carriage return'],
        ['.\n.', 'entry-marker parent-like regular file'],
        ['.\n', 'entry-marker current-like regular file'],
        ['\n', 'entry-marker newline regular file'],
        ['%2e%2e', 'entry-marker literal percent'],
        ['%0A', 'entry-marker encoded newline'],
        ['%2F', 'entry-marker encoded slash'],
        ['%5C', 'entry-marker encoded backslash'],
        ['question?', 'entry-marker question mark'],
        ['hash#', 'entry-marker hash'],
        ['with space', 'entry-marker space'],
        ['back\\slash', 'entry-marker backslash'],
        ['raw\vname', 'entry-marker vertical tab'],
        ['dir\nname/child.txt', 'entry-marker control directory'],
        ['nested/plain.txt', 'entry-marker nested'],
      ] as const;
      for (const [file, content] of files)
        await writeFile(join(subtree, file), content);
      let found: JsonObject | undefined;
      const server = new ModelServer([
        [
          call(
            name,
            {
              pattern: name === 'project_glob' ? '**/*' : 'entry-marker',
              path,
            },
            { callId: 'literal-names' },
          ),
        ],
        (request) => {
          found = result(request, 'literal-names');
          return [message('searched')];
        },
      ]);
      await using provider = await providerFor(server);
      await new Agent({ provider, instructions: 'Search.' }).run('Go.', {
        environment: new Environment({
          url: executor.url,
          cwd: root,
          headers: executor.headers,
          tools: [name],
        }),
      });
      expect.soft(found).toMatchObject({
        errors: [],
        truncated: false,
        truncation_reasons: [],
      });
      const matches = files.map(([file, content]) => {
        const relativePath = path === '.' ? file : `${path}/${file}`;
        return name === 'project_glob'
          ? relativePath
          : {
              path: relativePath,
              line_number: 1,
              line: content,
              before: [],
              after: [],
            };
      });
      expect.soft(found?.matches).toEqual(expect.arrayContaining(matches));
      expect.soft(found?.matches).toHaveLength(matches.length);
      expect.soft(JSON.stringify(server.requests)).not.toContain(outsideCanary);
      expect.soft(JSON.stringify(found)).not.toContain('outside.txt');
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  30_000,
);

it
  .skipIf(process.platform === 'win32')
  .for(['project_glob', 'project_grep'] as const)(
  '%s retains valid root and nested matches beside a non-UTF-8 filename',
  { timeout: 30_000 },
  async (name, context) => {
    await using project = await workspace();
    await mkdir(join(project.root, 'nested'));
    await writeFile(
      join(project.root, 'encoding-root.txt'),
      'encoding-match root\n',
    );
    await writeFile(
      join(project.root, 'nested', 'encoding-nested.txt'),
      'encoding-match nested\n',
    );
    try {
      await writeFile(
        Buffer.concat([
          Buffer.from(join(project.root, 'invalid-')),
          Buffer.from([0xff]),
          Buffer.from('.txt'),
        ]),
        'unrelated content\n',
      );
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'EILSEQ'
      ) {
        context.skip('This filesystem does not support non-UTF-8 filenames.');
      }
      throw error;
    }
    const server = new ModelServer([
      [
        call(
          name,
          { pattern: name === 'project_glob' ? '**/*.txt' : '^encoding-match' },
          { callId: 'encoding' },
        ),
      ],
      (request) => {
        const found = result(request, 'encoding');
        expect(found).toMatchObject({
          truncated: true,
          truncation_reasons: expect.arrayContaining(['read_errors']),
          errors: [{ path: '', code: 'path_unavailable' }],
        });
        expect(found.matches).toEqual(
          name === 'project_glob'
            ? ['encoding-root.txt', 'nested/encoding-nested.txt']
            : [
                {
                  path: 'encoding-root.txt',
                  line_number: 1,
                  line: 'encoding-match root',
                  before: [],
                  after: [],
                },
                {
                  path: 'nested/encoding-nested.txt',
                  line_number: 1,
                  line: 'encoding-match nested',
                  before: [],
                  after: [],
                },
              ],
        );
        return [message('retained valid matches')];
      },
    ]);
    await using provider = await providerFor(server);
    await new Agent({ provider, instructions: 'Search.' }).run('Go.', {
      environment: project.environment([name]),
    });
    server.assertExhausted();
  },
);

it.skipIf(process.platform === 'win32')(
  'skips symlinks and files that are not UTF-8 text',
  async () => {
    await using project = await workspace();
    await mkdir(join(project.root, 'links'));
    await symlink(
      join(project.root, 'src'),
      join(project.root, 'links', 'directory'),
      'dir',
    );
    await symlink(
      join(project.root, 'src', 'alpha.ts'),
      join(project.root, 'links', 'file.ts'),
    );
    await writeFile(
      join(project.root, 'links', 'invalid.ts'),
      Buffer.from([0xff, 0xfe]),
    );
    await writeFile(
      join(project.root, 'links', 'binary.ts'),
      'needle\0private',
    );
    const server = new ModelServer([
      [
        call(
          'project_grep',
          { pattern: 'needle', path: 'links' },
          { callId: 'links' },
        ),
      ],
      (request) => {
        expect(result(request, 'links').matches).toEqual([]);
        expect(output(request, 'links')).not.toContain('needle alpha');
        return [message('safe')];
      },
    ]);
    await using provider = await providerFor(server);
    await new Agent({ provider, instructions: 'Search.' }).run('Go.', {
      environment: project.environment(['project_grep']),
    });
    server.assertExhausted();
  },
  30_000,
);

it.skipIf(process.platform === 'win32').each(['root', 'subtree'] as const)(
  'rejects a symlink in the selected %s',
  async (location) => {
    await using project = await workspace();
    const alias = join(project.root, 'alias');
    await symlink(join(project.root, 'src'), alias, 'dir');
    const server = new ModelServer([
      [
        call(
          'project_grep',
          { pattern: 'needle', path: location === 'root' ? '.' : 'alias' },
          { callId: 'symlink' },
        ),
      ],
      (request) => {
        expect(result(request, 'symlink')).toMatchObject({
          matches: [],
          errors: expect.arrayContaining([
            expect.objectContaining({ code: 'path_unavailable' }),
          ]),
        });
        expect(output(request, 'symlink')).not.toContain('needle alpha');
        return [message('rejected')];
      },
    ]);
    await using provider = await providerFor(server);
    await new Agent({ provider, instructions: 'Search.' }).run('Go.', {
      environment: project.environment(
        ['project_grep'],
        location === 'root' ? alias : project.root,
      ),
    });
    server.assertExhausted();
  },
  30_000,
);

it.skipIf(process.platform === 'win32')(
  'reports a denied remote read as unavailable rather than oversized',
  async () => {
    await using project = await workspace();
    const denied = join(project.root, 'src', 'private.ts');
    await writeFile(denied, 'needle private\n');
    await chmod(denied, 0);
    try {
      const server = new ModelServer([
        [
          call(
            'project_grep',
            { pattern: 'needle private', path: 'src', glob: 'private.ts' },
            { callId: 'denied-read' },
          ),
        ],
        (request) => {
          const found = result(request, 'denied-read');
          expect(found).toMatchObject({
            matches: [],
            truncated: true,
            errors: [{ path: 'src/private.ts', code: 'path_unavailable' }],
            truncation_reasons: expect.arrayContaining(['read_errors']),
          });
          expect(output(request, 'denied-read')).not.toMatch(
            /file_too_large|file_bytes|needle private/,
          );
          return [message('denied safely')];
        },
      ]);
      await using provider = await providerFor(server);
      await new Agent({ provider, instructions: 'Search.' }).run('Go.', {
        environment: project.environment(['project_grep']),
      });
      server.assertExhausted();
    } finally {
      await chmod(denied, 0o600);
    }
  },
  30_000,
);

it('keeps opening and restored grants separate from saved search history', async () => {
  await using project = await workspace();
  const server = new ModelServer([
    (request) => {
      const names = wireToolNames(request);
      expect(names).toContain('project_glob');
      expect(names).not.toContain('project_grep');
      return [
        call('project_glob', { pattern: '**/*.ts' }, { callId: 'allowed' }),
      ];
    },
    [message('saved')],
    (request) => {
      const names = wireToolNames(request);
      for (const name of ['project_glob', 'project_grep'])
        expect(names).not.toContain(name);
      return [
        call('project_glob', { pattern: '**/*.ts' }, { callId: 'revoked' }),
      ];
    },
    (request) => {
      expect(output(request, 'revoked')).toMatch(
        /unsupported|not allowed|not available/i,
      );
      return [message('revoked')];
    },
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({ provider, instructions: 'Search.' });
  let saved: SessionState;
  {
    await using session = await agent.session({
      environment: project.environment(['project_glob']),
    });
    await (await session.submit('Go.')).wait();
    saved = await session.saveState();
    expect(JSON.stringify(saved)).not.toContain('_sdk_project_search');
  }
  await using restored = await agent.session({
    state: saved,
    environment: project.environment([]),
  });
  await (await restored.submit('Try again.')).wait();
  server.assertExhausted();
}, 30_000);

it('admits selected native search tools with local conversation storage', async () => {
  await using project = await workspace();
  const storage = await mkdtemp(join(tmpdir(), 'agents-search-storage-'));
  try {
    const server = new ModelServer([
      [
        call(
          'project_glob',
          { pattern: 'alpha.ts', path: 'src' },
          { callId: 'stored-search' },
        ),
      ],
      (request) => {
        expect(result(request, 'stored-search')).toMatchObject({
          matches: ['src/alpha.ts'],
          errors: [],
        });
        return [message('stored search completed')];
      },
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      model: nativeDescendantModel,
      instructions: 'Search.',
    }).session({
      storage: localStorage(join(storage, 'profile')),
      environment: project.environment(['project_glob', 'project_grep']),
    });
    expect((await (await session.submit('Go.')).wait()).finalOutput).toBe(
      'stored search completed',
    );
    server.assertExhausted();
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
}, 30_000);

it.skipIf(process.platform !== 'linux')(
  'keeps project search rooted at cwd with a disjoint read-only storage mount',
  async (context) => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'agents-search-mount-')),
    );
    const cwd = join(directory, 'work');
    const mounted = join(directory, 'storage');
    const canary = 'needle mounted private content 51f2';
    try {
      await Promise.all([mkdir(cwd), mkdir(mounted)]);
      await writeFile(join(cwd, 'visible.txt'), 'needle in cwd\n');
      await writeFile(join(mounted, 'mounted-private.txt'), canary);
      const searches = [
        {
          name: 'project_glob',
          pattern: '**/*.txt',
          path: '.',
          expected: { matches: ['visible.txt'], errors: [], truncated: false },
        },
        {
          name: 'project_grep',
          pattern: 'needle',
          path: '.',
          expected: {
            matches: [
              {
                path: 'visible.txt',
                line_number: 1,
                line: 'needle in cwd',
                before: [],
                after: [],
              },
            ],
            errors: [],
            truncated: false,
          },
        },
        ...['project_glob', 'project_grep'].flatMap((name) =>
          ['../storage', mounted].map((path) => ({
            name,
            pattern: name === 'project_glob' ? '**/*.txt' : 'needle',
            path,
            expected: {
              matches: [],
              errors: [{ path, code: 'invalid_path' }],
              truncated: false,
            },
          })),
        ),
      ];
      const searchCall = (index: number) => {
        const { name, pattern, path } = searches[index]!;
        return call(name, { pattern, path }, { callId: `mounted-${index}` });
      };
      const server = new ModelServer([
        (request) => {
          expect(wireToolNames(request)).toEqual([
            'project_glob',
            'project_grep',
          ]);
          return [searchCall(0)];
        },
        ...searches.map((search, index) => (request: JsonObject) => {
          expect(result(request, `mounted-${index}`)).toMatchObject(
            search.expected,
          );
          return index + 1 < searches.length
            ? [searchCall(index + 1)]
            : [message('search stayed in cwd')];
        }),
      ]);
      await using provider = await providerFor(server);
      const session = await new Agent({ provider, instructions: 'Search.' })
        .session({
          environment: Environment.local({
            cwd,
            tools: ['project_glob', 'project_grep'],
            mounts: [
              {
                source: mounted,
                destination: mounted,
                strategy: 'local_bind',
                readOnly: true,
              },
            ],
          }),
        })
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            error.message ===
              'local executor could not establish the platform sandbox' &&
            process.env.GITHUB_ACTIONS !== 'true' &&
            process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1' &&
            process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
          ) {
            expect(server.requests).toHaveLength(0);
            context.skip('This host cannot launch a nested platform sandbox');
          }
          throw error;
        });
      await using owned = session;
      expect(
        (await (await owned.submit('Search the workspace.')).wait())
          .finalOutput,
      ).toBe('search stayed in cwd');
      expect(JSON.stringify(server.requests)).not.toContain(canary);
      expect(JSON.stringify(server.requests)).not.toContain(
        'mounted-private.txt',
      );
      expect(await readFile(join(mounted, 'mounted-private.txt'), 'utf8')).toBe(
        canary,
      );
      server.assertExhausted();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

it('revokes search grants when reopening completed local durable storage', async () => {
  const executor = await startPublicExecutor();
  const directory = await mkdtemp(join(tmpdir(), 'agents-search-local-store-'));
  try {
    const cwd = await realpath(executor.cwd);
    await writeFile(join(cwd, 'visible.txt'), 'needle before close\n');
    const canary = 'needle private content added after close 781c';
    let requestIndex = -1;
    const server = new ModelServer([
      (request) => {
        expect(wireToolNames(request)).toEqual([
          'project_glob',
          'project_grep',
        ]);
        return [
          call(
            'project_glob',
            { pattern: '**/*.txt' },
            { callId: 'durable-glob' },
          ),
        ];
      },
      (request) => {
        expect(result(request, 'durable-glob')).toMatchObject({
          matches: ['visible.txt'],
          errors: [],
          truncated: false,
        });
        return [
          call(
            'project_grep',
            { pattern: 'needle' },
            { callId: 'durable-grep' },
          ),
        ];
      },
      (request) => {
        expect(result(request, 'durable-grep')).toMatchObject({
          matches: [
            {
              path: 'visible.txt',
              line_number: 1,
              line: 'needle before close',
            },
          ],
          errors: [],
          truncated: false,
        });
        return [message('durable searches completed')];
      },
      (request) => {
        for (const name of ['project_glob', 'project_grep'])
          expect(wireToolNames(request)).not.toContain(name);
        expect(JSON.stringify(request.input)).toContain(
          'durable searches completed',
        );
        requestIndex = executor.requests.length;
        return [
          call(
            'project_glob',
            { pattern: '**/*.txt' },
            { callId: 'revoked-glob' },
          ),
        ];
      },
      (request) => {
        expect(output(request, 'revoked-glob')).toMatch(
          /unsupported|not allowed|not available/i,
        );
        return [
          call(
            'project_grep',
            { pattern: 'needle' },
            { callId: 'revoked-grep' },
          ),
        ];
      },
      (request) => {
        expect(output(request, 'revoked-grep')).toMatch(
          /unsupported|not allowed|not available/i,
        );
        return [message('durable grants revoked')];
      },
    ]);
    await using provider = await providerFor(server);
    const connection = { cwd, url: executor.url, headers: executor.headers };
    const approvals: string[] = [];
    let id: string;
    let history: unknown[];
    {
      await using session = await new Agent({
        provider,
        model: nativeDescendantModel,
        instructions: 'Search.',
      }).session({
        storage: localStorage(join(directory, 'profile')),
        environment: new Environment({
          ...connection,
          tools: ['project_glob', 'project_grep'],
          approval(context) {
            approvals.push(context.toolName);
            return true;
          },
        }),
      });
      id = session.id;
      expect(
        (await (await session.submit('Search before closing.')).wait())
          .finalOutput,
      ).toBe('durable searches completed');
      history = await Array.fromAsync(session.items());
    }
    expect(approvals).toEqual(['project_glob', 'project_grep']);
    expect(executor.requests.map((request) => request.method)).toEqual(
      expect.arrayContaining(['fs/walk', 'fs/readFile']),
    );
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call_output',
          callId: 'durable-glob',
        }),
        expect.objectContaining({
          type: 'function_call_output',
          callId: 'durable-grep',
        }),
      ]),
    );
    await writeFile(join(cwd, 'after-close-private.txt'), canary);
    const currentApproval = vi.fn(() => true);
    {
      await using restored = await new Agent({
        provider,
        model: nativeDescendantModel,
        instructions: 'Search.',
      }).session({
        storage: localStorage(join(directory, 'profile')),
        resume: id,
        environment: new Environment({
          ...connection,
          tools: [],
          approval: currentApproval,
        }),
      });
      expect(restored.id).toBe(id);
      expect(await Array.fromAsync(restored.items())).toEqual(history);
      expect(
        (await (await restored.submit('Try both searches again.')).wait())
          .finalOutput,
      ).toBe('durable grants revoked');
    }
    expect(currentApproval).not.toHaveBeenCalled();
    expect(requestIndex).toBeGreaterThan(0);
    expect(
      executor.requests
        .slice(requestIndex)
        .filter((request) =>
          ['fs/walk', 'fs/readFile'].includes(String(request.method)),
        ),
    ).toEqual([]);
    expect(JSON.stringify(server.requests)).not.toContain(canary);
    expect(JSON.stringify(server.requests)).not.toContain(
      'after-close-private.txt',
    );
    server.assertExhausted();
  } finally {
    await executor.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('rejects search environments with custom storage before acquiring resources', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'agents-search-custom-store-'),
  );
  try {
    const durable = fileSessionStore(join(directory, 'store'));
    const acquire = vi.fn((id: string) => durable.acquire(id));
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const approval = vi.fn(() => true);
    await expect(
      new Agent({ provider, instructions: 'Search.' }).session({
        storage: { ...durable, acquire },
        environment: Environment.local({
          cwd: await realpath(directory),
          tools: ['project_glob', 'project_grep'],
          approval,
        }),
      }),
    ).rejects.toThrow('Custom canonical storage does not support environments');
    expect(acquire).not.toHaveBeenCalled();
    expect(approval).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(0);
    server.assertExhausted();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('lets turn selection narrow search grants without adding unselected tools', async () => {
  await using project = await workspace();
  const server = new ModelServer([
    (request) => {
      const names = wireToolNames(request);
      expect(names).toContain('project_glob');
      expect(names).not.toContain('project_grep');
      return [message('selected')];
    },
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    provider,
    instructions: 'Search.',
  }).session({
    environment: project.environment(['project_glob', 'project_grep']),
  });
  await (
    await session.submit('Go.', { tools: [toolRef('project_glob')] })
  ).wait();
  await expect(
    session.submit('No grant.', { tools: [toolRef('exec_command')] }),
  ).rejects.toThrow();
  server.assertExhausted();
}, 30_000);

it.each([true, false])(
  'preserves the search grant ceiling in native children: selected=%s',
  async (selected) => {
    await using project = await workspace();
    let rootId: string | undefined;
    let roots = 0;
    let children = 0;
    const checked = Promise.withResolvers<void>();
    const respond = (request: JsonObject) => {
      const metadata = request.client_metadata as Record<string, string>;
      const id = String(
        JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
      );
      rootId ??= id;
      if (id === rootId) {
        return ++roots === 1
          ? [
              call(
                'spawn_agent',
                { task_name: 'search', message: 'Search the project.' },
                {
                  namespace: 'collaboration',
                  callId: 'spawn-search',
                },
              ),
            ]
          : [message('root done')];
      }
      if (++children === 1) {
        const names = wireToolNames(request);
        expect(names.length).toBeGreaterThan(0);
        if (selected) expect(names).toContain('project_grep');
        else expect(names).not.toContain('project_grep');
        return [
          call(
            'project_grep',
            { pattern: 'needle alpha', path: 'src' },
            { callId: 'child-search' },
          ),
        ];
      }
      expect(selected).toBe(true);
      expect(result(request, 'child-search')).toMatchObject({
        matches: [
          { path: 'src/alpha.ts', line_number: 2, line: 'needle alpha' },
        ],
      });
      checked.resolve();
      return [message('child done')];
    };
    const server = new ModelServer(
      Array.from({ length: selected ? 4 : 3 }, () => respond),
    );
    await using provider = await providerFor(server);
    await using session = await new Agent({
      provider,
      model: nativeDescendantModel,
      instructions: 'Delegate the search.',
      tools: [new NativeAgents()],
    }).session({
      environment: project.environment([
        'exec_command',
        'write_stdin',
        'apply_patch',
        ...(selected ? ['project_grep' as const] : []),
      ]),
    });
    await (await session.submit('Go.')).wait();
    const descendants = await vi.waitUntil(
      async () => {
        const descendants = await Array.fromAsync(session.subagents());
        // Retry only the snapshot with one unpublished child turn.
        if (descendants.length === 1 && descendants[0]!.turn === null)
          return false;
        return descendants;
      },
      { timeout: 3000 },
    );
    expect(descendants).toHaveLength(1);
    const child = descendants[0]!;
    expect(child.turn).not.toBeNull();
    if (selected) {
      await checked.promise;
      expect((await child.turn!.wait()).finalOutput).toBe('child done');
      expect(children).toBe(2);
    } else {
      const error = await child.turn!.wait().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(NativeError);
      expect(String(error)).toContain('Native child turn failed');
      expect(await Array.fromAsync(child.turn!.events())).toContainEqual(
        expect.objectContaining({ type: 'turn_finished', status: 'failed' }),
      );
      expect(children).toBe(1);
    }
    server.assertExhausted();
  },
  30_000,
);
