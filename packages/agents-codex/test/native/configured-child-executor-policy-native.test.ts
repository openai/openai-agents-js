import { afterEach, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Agent,
  Environment,
  NativeProvider,
  NativeAgents,
  NativeRole,
  type Session,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

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

afterEach(() => ModelServer.closeAll());

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
