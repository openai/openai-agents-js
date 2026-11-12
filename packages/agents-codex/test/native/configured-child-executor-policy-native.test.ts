import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Agent,
  Environment,
  NativeProvider,
  NativeAgents,
  NativeRole,
  toolRef,
  tool,
  type Session,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { z } from 'zod';

function functionOutput(
  request: ModelServer['requests'][number],
  callId: string,
) {
  return Array.isArray(request.input)
    ? request.input.find(
        (item) =>
          item !== null &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          item.type === 'function_call_output' &&
          item.call_id === callId,
      )
    : undefined;
}

const native = process.env.OPENAI_AGENTS_NATIVE_TESTS === '1';
const catalog: {
  slug: string;
  supported_in_api?: boolean;
  multi_agent_version?: string;
}[] = native
  ? JSON.parse(
      readFileSync(
        process.env.OPENAI_AGENTS_NATIVE_TEST_MODELS_CATALOG ??
          new URL(
            '../../native/.upstream/reviewed-codex/codex-rs/models-manager/models.json',
            import.meta.url,
          ),
        'utf8',
      ),
    ).models
  : [];
const descendantModel = catalog.find(
  (entry) => entry.supported_in_api && entry.multi_agent_version === 'v2',
)?.slug;
if (native && !descendantModel)
  throw new Error('Expected a catalog model with V2 collaboration');

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

it
  .skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')
  .each([
    'opening',
    'narrowed',
    'replacement',
    'inherited',
    'managed',
  ] as const)(
  'configured child inherits the %s executor write roots',
  async (kind) => {
    const executor = await startPublicExecutor();
    try {
      const opening = join(executor.cwd, '..', 'additional');
      await mkdir(opening);
      const replacement = join(executor.cwd, '..', 'accepted');
      await mkdir(replacement);
      const work = [
        call(
          'configured_child',
          { input: 'run child' },
          { callId: 'root-child' },
        ),
      ];
      const rootModel = new ModelServer([
        ...(kind === 'inherited' ? [[message('policy accepted')]] : []),
        ...(kind === 'managed'
          ? [
              [
                call(
                  'managed_parent',
                  { input: 'run configured child' },
                  { namespace: 'collaboration', callId: 'managed-root' },
                ),
              ],
              work,
              [message('managed complete')],
            ]
          : [work]),
        [message('root complete')],
      ]);
      const childModel = new ModelServer([[message('child complete')]]);
      async function provider(server: ModelServer) {
        const config = await server.config();
        return new NativeProvider({
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'local-fixture',
          supportsWebsockets: false,
        });
      }
      await using rootProvider = await provider(rootModel);
      await using childProvider = await provider(childModel);
      const child = new Agent({
        instructions: 'Report.',
        model: 'gpt-5.5',
        provider: childProvider,
      });
      let childSession: Session | undefined;
      let childRoots: readonly string[] | undefined;
      let openingRoots: readonly string[] | undefined;
      let childEnvironment: Environment | undefined;
      const open = child.session.bind(child);
      child.session = async (...args) => {
        const options = args[0] as { environment?: Environment } | undefined;
        childEnvironment = options?.environment;
        openingRoots = childEnvironment?.writableRoots;
        const session = await open(...args);
        childSession = session;
        return session;
      };
      const parent = new Agent({
        instructions: 'Run the child.',
        model: kind === 'managed' ? descendantModel! : 'gpt-5.5',
        provider: rootProvider,
        tools: [
          ...(kind === 'managed'
            ? [
                new NativeAgents({
                  additionalRoles: [
                    new NativeRole({
                      name: 'policy_worker',
                      description: 'Run configured work.',
                      instructions: 'Call configured_child.',
                    }),
                  ],
                  managedTools: [
                    {
                      name: 'managed_parent',
                      role: 'policy_worker',
                      description: 'Delegate configured work.',
                    },
                  ],
                }),
              ]
            : []),
          child.asTool({
            toolName: 'configured_child',
            async customOutputExtractor(result) {
              const records = await Array.fromAsync(childSession!.turns());
              expect(records).toHaveLength(1);
              childRoots = records[0].receipt?.executors?.[0]?.writableRoots;
              return String(result.finalOutput);
            },
          }),
        ],
      });
      const untouchedPolicy = () => {
        throw new Error('Unexpected executor policy callback');
      };
      const environment = new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        writableRoots: [opening],
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
        env: { CONFIGURED_CHILD_INHERITANCE: 'fixture' },
        connectTimeout: 30,
        policyTimeout: 30,
        approval: untouchedPolicy,
        transformArguments: untouchedPolicy,
        transformResult: untouchedPolicy,
      });
      await using root = await parent.session({ environment });
      if (kind === 'inherited') {
        const first = await root.submit('Narrow the accepted policy.', {
          writableRoots: [],
        });
        expect((await first.wait()).finalOutput).toBe('policy accepted');
      }
      const turn = await root.submit(
        'Run child.',
        kind === 'replacement'
          ? { writableRoots: [replacement] }
          : kind === 'narrowed' || kind === 'managed'
            ? { writableRoots: [] }
            : undefined,
      );
      expect((await turn.wait()).finalOutput).toBe('root complete');
      const roots = [pathToFileURL(executor.cwd).href];
      if (kind === 'opening') roots.push(pathToFileURL(opening).href);
      if (kind === 'replacement') roots.push(pathToFileURL(replacement).href);
      const records = await Array.fromAsync(root.turns());
      expect(records).toHaveLength(kind === 'inherited' ? 2 : 1);
      expect(
        new Set(records.at(-1)!.receipt?.executors?.[0]?.writableRoots),
      ).toEqual(new Set(roots));
      expect(
        new Set([pathToFileURL(executor.cwd).href, ...(openingRoots ?? [])]),
      ).toEqual(new Set(roots));
      expect(new Set(childRoots)).toEqual(new Set(roots));
      expect(childEnvironment?.env).toEqual(environment.env);
      expect(childEnvironment?.approval).toBe(untouchedPolicy);
      expect(childEnvironment?.transformArguments).toBe(untouchedPolicy);
      expect(childEnvironment?.transformResult).toBe(untouchedPolicy);
      expect(childEnvironment?.headers).toEqual(environment.headers);
      expect(childEnvironment?.tools).toEqual(environment.tools);
      expect(childEnvironment?.connectTimeout).toBe(environment.connectTimeout);
      expect(childEnvironment?.policyTimeout).toBe(environment.policyTimeout);
      rootModel.assertExhausted();
      childModel.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  15000,
);

it.skipIf(!native || process.platform !== 'linux')(
  'keeps trusted local runtime temp grants out of a configured child checkpoint',
  async () => {
    const temporary = await mkdtemp(
      join(tmpdir(), 'agents-configured-policy-'),
    );
    try {
      const directory = await realpath(temporary);
      const cwd = join(directory, 'work');
      const extra = join(directory, 'extra');
      await Promise.all([mkdir(cwd), mkdir(extra)]);
      const rootModel = new ModelServer([
        [
          call(
            'configured_child',
            { input: 'run child' },
            { callId: 'trusted-child' },
          ),
        ],
        [message('root complete')],
      ]);
      const childModel = new ModelServer([
        [message('child complete')],
        [message('restored child complete')],
      ]);
      const provider = async (server: ModelServer) => {
        const config = await server.config();
        return new NativeProvider({
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'local-fixture',
          supportsWebsockets: false,
        });
      };
      await using rootProvider = await provider(rootModel);
      await using childProvider = await provider(childModel);
      const child = new Agent({
        instructions: 'Report.',
        model: 'gpt-5.5',
        provider: childProvider,
      });
      let childSession: Session | undefined;
      let childEnvironment: Environment | undefined;
      let saved: Awaited<ReturnType<Session['saveState']>> | undefined;
      const open = child.session.bind(child);
      child.session = async (...args) => {
        childEnvironment = (
          args[0] as { environment?: Environment } | undefined
        )?.environment;
        childSession = await open(...args);
        return childSession;
      };
      const parent = new Agent({
        instructions: 'Run the child.',
        model: 'gpt-5.5',
        provider: rootProvider,
        tools: [
          child.asTool({
            toolName: 'configured_child',
            async customOutputExtractor(result) {
              saved = await childSession!.saveState();
              return String(result.finalOutput);
            },
          }),
        ],
      });
      const environment = Environment.local({
        cwd,
        writableRoots: [extra],
        writePolicy: 'trusted_workspace_write',
      });
      {
        await using root = await parent.session({ environment });
        expect(
          (await (await root.submit('Run child.')).wait()).finalOutput,
        ).toBe('root complete');
        const records = await Array.fromAsync(root.turns());
        const declared = new Set([
          pathToFileURL(cwd).href,
          pathToFileURL(extra).href,
        ]);
        const privateRoots =
          records[0].receipt!.executors![0].writableRoots.filter(
            (root) => !declared.has(root),
          );
        expect(privateRoots).toHaveLength(1);
        expect(new Set(childEnvironment!.writableRoots)).toEqual(declared);
        expect(childEnvironment!.writableRoots).not.toContain(privateRoots[0]);
      }
      expect(saved).toBeDefined();
      await using restored = await child.session({
        state: saved!,
        environment,
      });
      expect(
        (await (await restored.submit('Continue.')).wait()).finalOutput,
      ).toBe('restored child complete');
      rootModel.assertExhausted();
      childModel.assertExhausted();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
  15000,
);

it
  .skipIf(!native)
  .each([
    'operation',
    'before-step',
    'forced-name',
    'legacy-operation',
    'application-search',
    'stdin-only',
  ] as const)(
  'keeps the issuing %s executor tool ceiling in a configured child',
  async (selection) => {
    const executor = await startPublicExecutor();
    try {
      const rootModel = new ModelServer([
        [
          call(
            'configured_child',
            { input: 'run child' },
            { callId: 'selected-child' },
          ),
        ],
        [message('root complete')],
      ]);
      const childModel = new ModelServer([
        [
          call(
            'exec_command',
            { cmd: 'printf OMITTED_EXECUTOR_RAN' },
            { callId: 'omitted-executor' },
          ),
        ],
        [message('child complete')],
      ]);
      const provider = async (server: ModelServer) => {
        const config = await server.config();
        return new NativeProvider({
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'local-fixture',
          supportsWebsockets: false,
        });
      };
      await using rootProvider = await provider(rootModel);
      await using childProvider = await provider(childModel);
      const child = new Agent({
        instructions: 'Report.',
        model: 'gpt-5.5',
        provider: childProvider,
      });
      let childEnvironment: Environment | undefined;
      const open = child.session.bind(child);
      child.session = async (...args) => {
        childEnvironment = (
          args[0] as { environment?: Environment } | undefined
        )?.environment;
        return open(...args);
      };
      const configured = child.asTool({ toolName: 'configured_child' });
      const callbackCalls: string[] = [];
      const applicationSearch = tool({
        name: 'project_glob',
        parameters: z.object({}),
        execute: () => {
          callbackCalls.push('search');
          return 'application search';
        },
      });
      const selected =
        selection === 'application-search'
          ? [configured, applicationSearch]
          : [configured];
      const receipts: { tools: string[] }[] = [];
      const nativeBinding = await binding();
      const capture =
        nativeBinding.NativeThread.prototype._configured_child_policy;
      vi.spyOn(
        nativeBinding.NativeThread.prototype,
        '_configured_child_policy',
      ).mockImplementation(async function (
        this: NativeThread,
        request: string,
      ) {
        const encoded = await capture.call(this, request);
        receipts.push(JSON.parse(encoded));
        return encoded;
      });
      const parent = new Agent({
        instructions: 'Run the child.',
        model: 'gpt-5.5',
        provider: rootProvider,
        tools: selected,
        modelSettings:
          selection === 'forced-name'
            ? { toolChoice: toolRef('configured_child', 'functions') }
            : undefined,
      });
      await using root = await parent.session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
          writePolicy: selection === 'legacy-operation' ? 'legacy' : undefined,
        }),
      });
      const turn = await root.submit(
        'Run child.',
        selection === 'operation' ||
          selection === 'legacy-operation' ||
          selection === 'application-search'
          ? { tools: selected }
          : selection === 'before-step'
            ? { beforeStep: () => [configured] }
            : selection === 'stdin-only'
              ? { tools: [configured, toolRef('write_stdin')] }
              : undefined,
      );
      expect((await turn.wait()).finalOutput).toBe('root complete');
      expect(JSON.stringify(rootModel.requests[0].tools)).not.toContain(
        'exec_command',
      );
      expect(
        executor.requests.filter(
          (request) => request.method === 'process/start',
        ),
      ).toEqual([]);
      expect(childEnvironment!.tools).toEqual([]);
      expect(callbackCalls).toEqual([]);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].tools).toEqual(
        selection === 'stdin-only' ? ['write_stdin'] : [],
      );
      expect(JSON.stringify(childModel.requests[0].tools)).not.toContain(
        'exec_command',
      );
      rootModel.assertExhausted();
      childModel.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  15000,
);

it.skipIf(!native)(
  'inherits real native project-search helpers in a configured child',
  async () => {
    const executor = await startPublicExecutor();
    try {
      await writeFile(
        join(await realpath(executor.cwd), 'child-search-proof.txt'),
        'configured child search proof\n',
      );
      const rootModel = new ModelServer([
        [
          call(
            'configured_child',
            { input: 'Search the workspace.' },
            { callId: 'search-child' },
          ),
        ],
        [message('root complete')],
      ]);
      const childModel = new ModelServer([
        [
          call(
            'project_glob',
            { pattern: '**/*.txt' },
            { callId: 'child-glob' },
          ),
        ],
        (request) => {
          const output = functionOutput(request, 'child-glob');
          if (!output || typeof output !== 'object' || Array.isArray(output))
            throw new Error('Missing accepted glob output');
          const found = JSON.parse(String(output.output));
          expect(found.errors).toEqual([]);
          expect(found.matches).toContain('child-search-proof.txt');
          return [
            call(
              'project_grep',
              { pattern: 'configured child search proof' },
              { callId: 'child-grep' },
            ),
          ];
        },
        (request) => {
          const output = functionOutput(request, 'child-grep');
          if (!output || typeof output !== 'object' || Array.isArray(output))
            throw new Error('Missing accepted grep output');
          expect(JSON.parse(String(output.output))).toMatchObject({
            errors: [],
            matches: [
              {
                path: 'child-search-proof.txt',
                line_number: 1,
                line: 'configured child search proof',
              },
            ],
          });
          return [message('child search complete')];
        },
      ]);
      const provider = async (server: ModelServer) => {
        const config = await server.config();
        return new NativeProvider({
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'synthetic-search',
          supportsWebsockets: false,
        });
      };
      await using rootProvider = await provider(rootModel);
      await using childProvider = await provider(childModel);
      const child = new Agent({
        instructions: 'Search.',
        model: 'gpt-5.5',
        provider: childProvider,
      });
      const parent = new Agent({
        instructions: 'Use the child.',
        model: 'gpt-5.5',
        provider: rootProvider,
        tools: [child.asTool({ toolName: 'configured_child' })],
      });
      await using root = await parent.session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['project_glob', 'project_grep'],
        }),
      });
      expect((await (await root.submit('Search.')).wait()).finalOutput).toBe(
        'root complete',
      );
      rootModel.assertExhausted();
      childModel.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  15000,
);

it.skipIf(!native || process.platform !== 'linux').each([false, true])(
  'normalizes dependent network policy for configured child with exec_command=%s',
  async (commands) => {
    const executor = await startPublicExecutor();
    try {
      const server = new ModelServer([
        [
          call(
            'configured_child',
            { input: 'Report.' },
            { callId: 'network-child' },
          ),
        ],
        [message('child complete')],
        [message('root complete')],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-child-network',
        supportsWebsockets: false,
      });
      const child = new Agent({
        instructions: 'Report.',
        model: 'gpt-5.5',
        provider,
      });
      let childEnvironment: Environment | undefined;
      const open = child.session.bind(child);
      child.session = async (...args) => {
        childEnvironment = (
          args[0] as { environment?: Environment } | undefined
        )?.environment;
        return open(...args);
      };
      const configured = child.asTool({ toolName: 'configured_child' });
      const parent = new Agent({
        instructions: 'Use the child.',
        model: 'gpt-5.5',
        provider,
        tools: [configured],
      });
      const environment = new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command'],
        network: {
          allowedDomains: ['child-policy.invalid'],
          allowAllUnixSockets: true,
        },
      });
      await using root = await parent.session({ environment });
      const turn = await root.submit(
        'Report.',
        commands ? undefined : { tools: [configured] },
      );
      expect((await turn.wait()).finalOutput).toBe('root complete');
      expect(childEnvironment!.tools).toEqual(commands ? ['exec_command'] : []);
      expect(childEnvironment!.network).toEqual(
        commands ? environment.network : undefined,
      );
      expect(
        executor.requests.filter(
          (request) => request.method === 'process/start',
        ),
      ).toEqual([]);
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  15000,
);
