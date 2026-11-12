import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  UnixLocalSandboxClient,
  localDirLazySkillSource,
} from '@openai/agents/sandbox/local';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  Manifest,
  dir,
  file,
  normalizeSandboxClientCreateArgs,
  skills,
  sandboxEnvironment,
  type Entry,
  type SandboxClient,
  type SandboxSessionLike,
} from '@openai/agents/sandbox';
import { Agent, Environment, NativeProvider } from '../../src';
import { acquireEnvironment } from '../../src/runtime/environment-source';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

// Physical fixture roots have been using the sandbox POSIX path contract.
const nativeIt = it.skipIf(process.platform === 'win32');

// This application provider materializes only the file/dir entries used here.
async function materialize(path: string, entry: Entry): Promise<void> {
  if (entry.type === 'dir') {
    await mkdir(path, { recursive: true });
    for (const [name, child] of Object.entries(entry.children ?? {})) {
      await materialize(join(path, name), child);
    }
  } else if (entry.type === 'file' && entry.content !== undefined) {
    await writeFile(path, entry.content);
  } else {
    throw new Error('Unexpected fixture resource');
  }
}

function clientFixture() {
  const sessions: SandboxSessionLike[] = [];
  const effects: string[] = [];
  const materializationOwners: number[] = [];
  const closed: SandboxSessionLike[] = [];
  const client: SandboxClient = {
    backendId: 'skills-fixture',
    async create(args) {
      const manifest = normalizeSandboxClientCreateArgs(args).manifest;
      for (const [path, entry] of Object.entries(manifest.entries)) {
        await materialize(join(manifest.root, path), entry);
      }
      const session: SandboxSessionLike = {
        state: { manifest },
        async pathExists(path) {
          try {
            await access(join(manifest.root, path));
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
              return false;
            throw error;
          }
        },
        async materializeEntry({ path, entry }) {
          effects.push(path);
          materializationOwners.push(sessions.indexOf(session));
          await materialize(join(manifest.root, path), entry);
        },
        async close() {
          closed.push(session);
        },
      };
      sessions.push(session);
      return session;
    },
  };
  return { client, sessions, effects, materializationOwners, closed };
}

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-skills-provider',
    supportsWebsockets: false,
  });
}

const lazyResource = () =>
  dir({
    children: {
      report: dir({
        children: { 'SKILL.md': file({ content: 'lazy document\n' }) },
      }),
    },
  });

nativeIt(
  'publishes the inline descriptor index and preserves document bytes through a native Session',
  async () => {
    const peer = await startPublicExecutor();
    const server = new ModelServer([[message('indexed')]]);
    await using provider = await providerFor(server);
    const f = clientFixture();
    const document = new TextEncoder().encode(
      'plain document\r\nwith exact bytes\n',
    );
    try {
      const source = sandboxEnvironment({
        client: f.client,
        manifest: new Manifest({ root: peer.cwd }),
        skills: skills({
          skills: [
            {
              name: 'report',
              description: 'INLINE_REPORT_INDEX',
              content: document,
            },
          ],
        }),
        connect: async () =>
          Environment.lease(
            new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: peer.cwd,
              tools: [],
              capabilityDirectories: [join(peer.cwd, '.agents')],
            }),
            async () => {},
          ),
      });
      expect(source.skillTools).toEqual([]);
      await using session = await new Agent({
        provider,
        model: 'fixture-skills',
        instructions: 'Inspect skills.',
      }).session({ environment: source });
      expect(
        (await (await session.submit('Inspect the index.')).wait()).finalOutput,
      ).toBe('indexed');
      expect(JSON.stringify(server.requests[0])).toContain('## Skills');
      expect(JSON.stringify(server.requests[0])).toContain(
        `file: ${peer.cwd}/.agents/report`,
      );
      expect(JSON.stringify(server.requests[0])).toContain(
        'INLINE_REPORT_INDEX',
      );
      expect(await readFile(join(peer.cwd, '.agents/report/SKILL.md'))).toEqual(
        Buffer.from(document),
      );
      server.assertExhausted();
    } finally {
      await peer.close();
    }
  },
);

nativeIt(
  'loads a captured lazy skill once and reports an already loaded result on the same native Session',
  async () => {
    const peer = await startPublicExecutor();
    const server = new ModelServer([
      [
        call(
          'load_skill',
          { skill_name: 'report' },
          { callId: 'call_skill_first' },
        ),
      ],
      [
        call(
          'load_skill',
          { skill_name: 'report' },
          { callId: 'call_skill_again' },
        ),
      ],
      [message('loaded')],
    ]);
    await using provider = await providerFor(server);
    const f = clientFixture();
    let indexReads = 0;
    try {
      await mkdir(join(peer.cwd, '.agents'));
      const source = sandboxEnvironment({
        client: f.client,
        manifest: new Manifest({ root: peer.cwd }),
        skills: skills({
          lazyFrom: {
            source: lazyResource(),
            getIndex: () => {
              indexReads++;
              return [{ name: 'report', description: 'LAZY_REPORT_INDEX' }];
            },
          },
        }),
        connect: async () =>
          Environment.lease(
            new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: peer.cwd,
              tools: [],
              capabilityDirectories: [join(peer.cwd, '.agents')],
            }),
            async () => {},
          ),
      });
      await using session = await new Agent({
        provider,
        model: 'fixture-skills',
        instructions: 'Use the selected skills only.',
        tools: source.skillTools,
      }).session({ environment: source });
      expect(
        (await (await session.submit('Load the report twice.')).wait())
          .finalOutput,
      ).toBe('loaded');
      expect(indexReads).toBe(1);
      expect(f.effects).toEqual(['.agents/report']);
      expect(JSON.stringify(server.requests[0])).toContain('LAZY_REPORT_INDEX');
      expect(JSON.stringify(server.requests[1])).toContain('loaded');
      expect(JSON.stringify(server.requests[2])).toContain('already_loaded');
      expect(
        await readFile(join(peer.cwd, '.agents/report/SKILL.md'), 'utf8'),
      ).toBe('lazy document\n');
      server.assertExhausted();
    } finally {
      await peer.close();
    }
  },
);

nativeIt(
  'rejects a foreign source loader even while its source and exact same Environment remain live',
  async () => {
    const peer = await startPublicExecutor();
    const server = new ModelServer([
      [
        call(
          'load_skill',
          { skill_name: 'report' },
          { callId: 'call_foreign_skill' },
        ),
      ],
    ]);
    await using provider = await providerFor(server);
    const a = clientFixture();
    const b = clientFixture();
    try {
      await mkdir(join(peer.cwd, '.agents'));
      const environment = new Environment({
        url: peer.url,
        headers: peer.headers,
        cwd: peer.cwd,
        tools: [],
        capabilityDirectories: [join(peer.cwd, '.agents')],
      });
      const connect = async () =>
        Environment.lease(environment, async () => {});
      const sourceA = sandboxEnvironment({
        client: a.client,
        manifest: new Manifest({ root: peer.cwd }),
        connect,
        skills: skills({
          lazyFrom: {
            source: lazyResource(),
            index: [{ name: 'report', description: 'SOURCE_A_PRIVATE_INDEX' }],
          },
        }),
      });
      const sourceB = sandboxEnvironment({
        client: b.client,
        manifest: new Manifest({ root: peer.cwd }),
        connect,
      });
      await using liveA = await new Agent({
        provider,
        model: 'fixture-skills',
        instructions: 'Use the selected skills only.',
        tools: sourceA.skillTools,
      }).session({ environment: sourceA });
      await using foreign = await new Agent({
        provider,
        model: 'fixture-skills',
        instructions: 'Use the selected skills only.',
        tools: sourceA.skillTools,
      }).session({ environment: sourceB });
      expect(liveA).not.toBe(foreign);
      await expect(
        (await foreign.submit('Load report.')).wait(),
      ).rejects.toThrow(/different sandbox source/);
      expect(a.closed).toEqual([]);
      expect(a.effects).toEqual([]);
      expect(b.effects).toEqual([]);
      expect(JSON.stringify(server.requests)).not.toContain(
        'SOURCE_A_PRIVATE_INDEX',
      );
      server.assertExhausted();
    } finally {
      await peer.close();
    }
  },
);

it('rejects an unselected namespace before invoking its application index callback', async () => {
  const f = clientFixture();
  let reads = 0;
  const source = sandboxEnvironment({
    client: f.client,
    manifest: new Manifest({ root: '/workspace' }),
    skills: skills({
      lazyFrom: {
        source: lazyResource(),
        getIndex: () => {
          reads++;
          return [{ name: 'report', description: 'undisclosed' }];
        },
      },
    }),
    connect: async () =>
      Environment.lease(
        new Environment({
          url: 'wss://fixture.invalid',
          cwd: '/workspace',
          tools: [],
          capabilityDirectories: ['/workspace/unrelated'],
        }),
        async () => {},
      ),
  });
  await expect(acquireEnvironment(source)).rejects.toThrow(
    /selected current Environment/,
  );
  expect(reads).toBe(0);
  expect(f.effects).toEqual([]);
  expect(f.closed).toHaveLength(1);
});

nativeIt(
  'revokes lazy loading after the current source grants rotate',
  async () => {
    const peer = await startPublicExecutor();
    const f = clientFixture();
    const server = new ModelServer([
      (request) => {
        expect(JSON.stringify(request)).toContain('CURRENT_SKILL_INDEX');
        f.sessions[0].state.manifest.extraPathGrants.push({
          path: '/new-grant',
          readOnly: true,
        });
        return [
          call(
            'load_skill',
            { skill_name: 'report' },
            { callId: 'call_revoked_skill' },
          ),
        ];
      },
    ]);
    await using provider = await providerFor(server);
    try {
      await mkdir(join(peer.cwd, '.agents'));
      const source = sandboxEnvironment({
        client: f.client,
        manifest: new Manifest({ root: peer.cwd }),
        skills: skills({
          lazyFrom: {
            source: lazyResource(),
            index: [{ name: 'report', description: 'CURRENT_SKILL_INDEX' }],
          },
        }),
        connect: async () =>
          Environment.lease(
            new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: peer.cwd,
              tools: [],
              capabilityDirectories: [join(peer.cwd, '.agents')],
            }),
            async () => {},
          ),
      });
      await using session = await new Agent({
        provider,
        model: 'fixture-skills',
        instructions: 'Use the selected skills only.',
        tools: source.skillTools,
      }).session({ environment: source });
      await expect(
        (await session.submit('Load report.')).wait(),
      ).rejects.toThrow(/skill grants have changed/);
      expect(f.effects).toEqual([]);
      server.assertExhausted();
    } finally {
      await peer.close();
    }
  },
);

nativeIt(
  'keeps concurrent acquisitions independent when another lease closes',
  async () => {
    const peer = await startPublicExecutor();
    const f = clientFixture();
    let reads = 0;
    const server = new ModelServer([
      [
        call(
          'load_skill',
          { skill_name: 'report' },
          { callId: 'call_first_lease' },
        ),
      ],
      [message('first complete')],
      [
        call(
          'load_skill',
          { skill_name: 'report' },
          { callId: 'call_second_lease' },
        ),
      ],
      [message('second complete')],
    ]);
    await using provider = await providerFor(server);
    try {
      await mkdir(join(peer.cwd, '.agents'));
      const source = sandboxEnvironment({
        client: f.client,
        manifest: new Manifest({ root: peer.cwd }),
        skills: skills({
          lazyFrom: {
            source: lazyResource(),
            getIndex: () => [
              { name: 'report', description: `REUSED_SOURCE_INDEX_${++reads}` },
            ],
          },
        }),
        connect: async () =>
          Environment.lease(
            new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: peer.cwd,
              tools: [],
              capabilityDirectories: [join(peer.cwd, '.agents')],
            }),
            async () => {},
          ),
      });
      const agent = new Agent({
        provider,
        model: 'fixture-skills',
        instructions: 'Use selected skills.',
        tools: source.skillTools,
      });
      await using first = await agent.session({ environment: source });
      await using second = await agent.session({ environment: source });
      expect(
        (await (await first.submit('Load report.')).wait()).finalOutput,
      ).toBe('first complete');
      expect(f.materializationOwners).toEqual([0]);
      await first.close();
      expect(f.closed).toEqual([f.sessions[0]]);
      expect(
        (await (await second.submit('Load report.')).wait()).finalOutput,
      ).toBe('second complete');
      expect(reads).toBe(2);
      expect(JSON.stringify(server.requests[0])).toContain(
        'REUSED_SOURCE_INDEX_1',
      );
      expect(JSON.stringify(server.requests[2])).toContain(
        'REUSED_SOURCE_INDEX_2',
      );
      expect(JSON.stringify(server.requests[3])).toContain('already_loaded');
      server.assertExhausted();
    } finally {
      await peer.close();
    }
  },
);

it('budgets the combined workspace and multibyte skill index instructions', async () => {
  const f = clientFixture();
  const source = sandboxEnvironment({
    client: f.client,
    manifest: new Manifest({ root: '/workspace' }),
    skills: skills({
      lazyFrom: {
        source: lazyResource(),
        index: Array.from({ length: 100 }, (_, i) => ({
          name: `report-${i}`,
          description: 'é'.repeat(500),
        })),
      },
    }),
    connect: async () =>
      Environment.lease(
        new Environment({
          url: 'wss://fixture.invalid',
          cwd: '/workspace',
          capabilityDirectories: ['/workspace/.agents'],
        }),
        async () => {},
      ),
  });
  const lease = await acquireEnvironment(source, new AbortController().signal);
  try {
    expect(
      Buffer.byteLength(lease.workspaceInstructions!, 'utf8'),
    ).toBeLessThanOrEqual(40_000);
    expect(lease.workspaceInstructions).toContain('## Skills');
    expect(lease.workspaceInstructions).not.toContain('�');
  } finally {
    await lease.dispose();
  }
});

it.each(['matching', 'revoked', 'replaced'] as const)(
  'checks %s borrowed UnixLocal source grants before index discovery',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'native-skills-borrowed-'));
    const client = new UnixLocalSandboxClient();
    const localSkills = join(root, 'private');
    await mkdir(join(localSkills, 'report'), { recursive: true });
    await mkdir(join(root, 'other'));
    await writeFile(
      join(localSkills, 'report/SKILL.md'),
      '---\nname: report\ndescription: PRIVATE_METADATA\n---\nprivate skill',
    );
    const sandbox = await client.create({
      manifest: new Manifest({
        root: '/workspace',
        extraPathGrants: [{ path: localSkills, readOnly: true }],
      }),
    });
    let indexed = false;
    try {
      const source = sandboxEnvironment({
        client,
        session: sandbox,
        manifest: new Manifest({
          root: '/workspace',
          extraPathGrants:
            mode === 'matching'
              ? [{ path: localSkills, readOnly: true }]
              : mode === 'replaced'
                ? [{ path: join(root, 'other'), readOnly: true }]
                : [],
        }),
        skills: skills({
          lazyFrom: {
            ...localDirLazySkillSource(localSkills),
            getIndex: (manifest, skillsPath) => {
              indexed = true;
              return localDirLazySkillSource(localSkills).getIndex!(
                manifest,
                skillsPath,
              );
            },
          },
        }),
        connect: async () =>
          Environment.lease(
            new Environment({
              url: 'wss://fixture.invalid',
              cwd: sandbox.state.workspaceRootPath,
              capabilityDirectories: [
                join(sandbox.state.workspaceRootPath, '.agents'),
                '/workspace/.agents',
              ],
            }),
            async () => {},
          ),
      });
      if (mode === 'matching') {
        const acquisition = await acquireEnvironment(
          source,
          new AbortController().signal,
        );
        try {
          expect(acquisition.workspaceInstructions).toContain(
            'PRIVATE_METADATA',
          );
        } finally {
          await acquisition.dispose();
        }
        expect(indexed).toBe(true);
      } else {
        await expect(
          acquireEnvironment(source, new AbortController().signal),
        ).rejects.toThrow(/grant/);
        expect(indexed).toBe(false);
      }
      await expect(
        access(
          join(sandbox.state.workspaceRootPath, '.agents/report/SKILL.md'),
        ),
      ).rejects.toThrow();
    } finally {
      await sandbox.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(['inline', 'from'] as const)(
  'rejects %s eager borrowed UnixLocal declarations before publishing an index',
  async (mode) => {
    const client = new UnixLocalSandboxClient();
    const sandbox = await client.create({
      manifest: new Manifest({ root: '/workspace' }),
    });
    let connected = false;
    try {
      expect(() =>
        sandboxEnvironment({
          client,
          session: sandbox,
          manifest: new Manifest({ root: '/workspace' }),
          skills: skills(
            mode === 'from'
              ? { from: lazyResource() }
              : {
                  skills: [
                    {
                      name: 'report',
                      description: 'BORROWED_REPORT',
                      content: 'borrowed bytes',
                    },
                  ],
                },
          ),
          connect: async () => {
            connected = true;
            return Environment.lease(
              new Environment({
                url: 'wss://fixture.invalid',
                cwd: '/workspace',
              }),
              async () => {},
            );
          },
        }),
      ).toThrow(/Eager Skills require an owned/);
      expect(connected).toBe(false);
      expect(await sandbox.pathExists('.agents/report/SKILL.md')).toBe(false);
    } finally {
      await sandbox.close();
    }
  },
);

nativeIt(
  'uses the acquired UnixLocal executor root across relocated Sessions with a subdirectory cwd',
  async () => {
    const client = new UnixLocalSandboxClient();
    const peer = await startPublicExecutor();
    const server = new ModelServer([
      [message('first index')],
      [message('relocated index')],
    ]);
    await using provider = await providerFor(server);
    const roots: string[] = [];
    try {
      const source = sandboxEnvironment({
        client,
        manifest: new Manifest({ root: '/workspace' }),
        skills: skills({
          skills: [
            {
              name: 'report',
              description: 'LOCAL_REPORT',
              content: 'local bytes\r\n',
            },
          ],
        }),
        connect: async (sandbox) => {
          const root = sandbox.state.workspaceRootPath;
          roots.push(root);
          await mkdir(join(root, 'work'));
          return Environment.lease(
            new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: join(root, 'work'),
              capabilityDirectories: [join(root, '.agents')],
              tools: [],
            }),
            async () => {},
          );
        },
      });
      for (let i = 0; i < 2; i++) {
        await using session = await new Agent({
          provider,
          model: 'fixture-skills',
          instructions: 'Read the current skill index.',
        }).session({ environment: source });
        await (await session.submit('Inspect the index.')).wait();
        expect(JSON.stringify(server.requests[i])).toContain(
          `file: ${roots[i]}/.agents/report`,
        );
        expect(
          await readFile(join(roots[i], '.agents/report/SKILL.md'), 'utf8'),
        ).toBe('local bytes\r\n');
      }
      expect(roots[0]).not.toBe(roots[1]);
      server.assertExhausted();
    } finally {
      await peer.close();
    }
  },
  20_000,
);

nativeIt.each(['inline', 'from'] as const)(
  'stages %s eager skills before publishing an authorized cold UnixLocal resume',
  async (kind) => {
    const client = new UnixLocalSandboxClient();
    const archiveBase = await mkdtemp(
      join(tmpdir(), 'skills-resume-snapshot-'),
    );
    const seed = await client.create({
      manifest: new Manifest({ root: '/workspace' }),
      snapshot: { type: 'local', baseDir: archiveBase },
    });
    const saved = await client.serializeSessionState(seed.state);
    const snapshot = saved.snapshot as { type: 'local'; path: string };
    await seed.close();
    const resumedClient = new UnixLocalSandboxClient({
      resumeAuthority: {
        workspaceRootPath: saved.workspaceRootPath as string,
        workspaceRootOwned: true,
        localSnapshotPath: snapshot.path,
      },
    });
    const state = await resumedClient.deserializeSessionState(saved);
    const peer = await startPublicExecutor();
    const server = new ModelServer([[message('resumed index')]]);
    await using provider = await providerFor(server);
    const document =
      kind === 'inline'
        ? 'EAGER_RESUMED_BYTES\r\n'
        : '---\nname: report\ndescription: EAGER_RESUME_INDEX\n---\nEAGER_RESUMED_BYTES\r\n';
    let resumedRoot = '';
    try {
      const source = sandboxEnvironment({
        client: resumedClient,
        manifest: new Manifest({ root: '/workspace' }),
        authorizedResumeState: { backendId: resumedClient.backendId, state },
        skills: skills(
          kind === 'inline'
            ? {
                skills: [
                  {
                    name: 'report',
                    description: 'EAGER_RESUME_INDEX',
                    content: document,
                  },
                ],
              }
            : {
                from: dir({
                  children: {
                    report: dir({
                      children: { 'SKILL.md': file({ content: document }) },
                    }),
                  },
                }),
              },
        ),
        connect: async (sandbox) => {
          resumedRoot = sandbox.state.workspaceRootPath;
          expect(
            await readFile(
              join(resumedRoot, '.agents/report/SKILL.md'),
              'utf8',
            ),
          ).toBe(document);
          return Environment.lease(
            new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: resumedRoot,
              capabilityDirectories: [join(resumedRoot, '.agents')],
              tools: [],
            }),
            async () => {},
          );
        },
      });
      await using session = await new Agent({
        provider,
        model: 'fixture-skills',
        instructions: 'Inspect the restored skill index.',
      }).session({ environment: source });
      await (await session.submit('Inspect the index.')).wait();
      expect(resumedRoot).not.toBe(saved.workspaceRootPath);
      expect(JSON.stringify(server.requests[0])).toContain(
        'EAGER_RESUME_INDEX',
      );
      expect(JSON.stringify(server.requests[0])).toContain(
        `file: ${resumedRoot}/.agents/report`,
      );
      server.assertExhausted();
    } finally {
      await peer.close();
      await rm(archiveBase, { recursive: true, force: true });
    }
  },
  20_000,
);
