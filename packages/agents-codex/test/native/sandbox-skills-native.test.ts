import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  access,
  chmod,
  stat,
  mkdir,
  mkdtemp,
  readFile,
  truncate,
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
  gitRepo,
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

function clientFixture(verifyExisting = false) {
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
      const backing = verifyExisting
        ? await new UnixLocalSandboxClient({
            resumeAuthority: {
              workspaceRootPath: manifest.root,
              workspaceRootOwned: false,
            },
          }).resume({
            manifest,
            workspaceRootPath: manifest.root,
            workspaceRootOwned: false,
            environment: {},
          })
        : undefined;
      const session: SandboxSessionLike = {
        state: backing?.state ?? { manifest },
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
          if (backing) await backing.materializeEntry({ path, entry });
          else await materialize(join(manifest.root, path), entry);
        },
        async close() {
          await backing?.close();
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
    const f = clientFixture(true);
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
    const f = clientFixture(true);
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

nativeIt.each([
  { kind: 'inline', savedSkills: false, conflict: 'none' },
  { kind: 'inline', savedSkills: true, conflict: 'none' },
  { kind: 'from', savedSkills: false, conflict: 'none' },
  { kind: 'from', savedSkills: true, conflict: 'none' },
  { kind: 'from', savedSkills: true, conflict: 'missing-sentinel' },
  { kind: 'from', savedSkills: true, conflict: 'directory-to-file' },
  { kind: 'from', savedSkills: true, conflict: 'root-directory-to-file' },
  { kind: 'git-repo', savedSkills: true, conflict: 'missing-sentinel' },
  { kind: 'git-repo', savedSkills: true, conflict: 'directory-to-file' },
  { kind: 'git-repo', savedSkills: true, conflict: 'root-directory-to-file' },
] as const)(
  'stages $kind eager skills on an authorized cold resume with savedSkills=$savedSkills and conflict=$conflict',
  async ({ kind, savedSkills, conflict }) => {
    const replaceDirectory =
      conflict === 'directory-to-file' ||
      (kind === 'git-repo' && conflict === 'missing-sentinel');
    const client = new UnixLocalSandboxClient();
    const archiveBase = await mkdtemp(
      join(tmpdir(), 'skills-resume-snapshot-'),
    );
    const seed = await client.create({
      manifest: new Manifest({
        root: '/workspace',
        entries: savedSkills
          ? {
              '.agents': dir({
                children: {
                  report: dir({
                    children: {
                      ...(conflict === 'missing-sentinel'
                        ? {}
                        : {
                            'SKILL.md': file({
                              content:
                                '---\nname: report\ndescription: OLD_REPORT_INDEX\n---\n',
                            }),
                          }),
                      'removed.sh': file({ content: 'obsolete member' }),
                      ...(replaceDirectory
                        ? {
                            replaced: dir({
                              children: {
                                old: file({ content: 'obsolete directory' }),
                              },
                            }),
                          }
                        : {}),
                    },
                  }),
                  ...(conflict === 'root-directory-to-file'
                    ? {
                        'replaced-root': dir({
                          children: {
                            old: file({ content: 'obsolete root member' }),
                            ...(kind === 'from'
                              ? {
                                  'SKILL.md': file({
                                    content: 'retired skill',
                                  }),
                                }
                              : {}),
                          },
                        }),
                      }
                    : {}),
                  retired: dir({
                    children: {
                      'SKILL.md': file({
                        content:
                          '---\nname: retired\ndescription: RETIRED_OLD_INDEX\n---\n',
                      }),
                    },
                  }),
                  unrelated: dir({
                    children: {
                      'config.txt': file({ content: 'unrelated directory' }),
                    },
                  }),
                  'keep.txt': file({ content: 'unrelated namespace file' }),
                },
              }),
              'workspace.txt': file({ content: 'unrelated workspace file' }),
            }
          : {},
      }),
      snapshot: { type: 'local', baseDir: archiveBase },
    });
    if (savedSkills) {
      expect(
        await readFile(
          join(seed.state.workspaceRootPath, '.agents/report/removed.sh'),
          'utf8',
        ),
      ).toBe('obsolete member');
    }
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
    if (conflict === 'root-directory-to-file') {
      const resume = resumedClient.resume.bind(resumedClient);
      resumedClient.resume = async (...args) => {
        const resumed = await resume(...args);
        await chmod(
          join(resumed.state.workspaceRootPath, '.agents/unrelated'),
          0o700,
        );
        if (kind === 'git-repo')
          await chmod(
            join(resumed.state.workspaceRootPath, '.agents/report'),
            0o700,
          );
        return resumed;
      };
    }
    const peer = await startPublicExecutor();
    const server = new ModelServer([[message('resumed index')]]);
    await using provider = await providerFor(server);
    const document =
      kind === 'inline'
        ? 'EAGER_RESUMED_BYTES\r\n'
        : '---\nname: report\ndescription: EAGER_RESUME_INDEX\n---\nEAGER_RESUMED_BYTES\r\n';
    const currentSource = join(archiveBase, 'current-source');
    if (kind === 'git-repo') {
      await mkdir(join(currentSource, 'skill-root', 'report'), {
        recursive: true,
      });
      await writeFile(
        join(currentSource, 'skill-root', 'report', 'SKILL.md'),
        document,
      );
      await writeFile(
        join(currentSource, 'skill-root', 'report', 'replaced'),
        'replacement file',
      );
      if (conflict === 'root-directory-to-file')
        await writeFile(
          join(currentSource, 'skill-root', 'replaced-root'),
          'replacement root file',
        );
      const git = promisify(execFile);
      await git('git', ['-C', currentSource, 'init']);
      await git('git', ['-C', currentSource, 'add', '.']);
      await git('git', [
        '-C',
        currentSource,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'current skills',
      ]);
    }
    let resumedRoot = '';
    try {
      const source = sandboxEnvironment({
        client: resumedClient,
        manifest: new Manifest({
          root: '/workspace',
          ...(kind === 'git-repo'
            ? { extraPathGrants: [{ path: currentSource, readOnly: true }] }
            : {}),
        }),
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
                from:
                  kind === 'git-repo'
                    ? gitRepo({
                        repo: `file://${currentSource}`,
                        subpath: 'skill-root',
                      })
                    : dir({
                        children: {
                          ...(conflict === 'root-directory-to-file'
                            ? {
                                'replaced-root': file({
                                  content: 'replacement root file',
                                }),
                              }
                            : {}),
                          report: dir({
                            children: {
                              'SKILL.md': file({ content: document }),
                              ...(conflict === 'directory-to-file'
                                ? {
                                    replaced: file({
                                      content: 'replacement file',
                                    }),
                                  }
                                : {}),
                            },
                          }),
                        },
                      }),
              },
        ),
        connect: async (sandbox) => {
          resumedRoot = sandbox.state.workspaceRootPath;
          if (kind === 'git-repo')
            expect(sandbox.state.manifest.entries['.agents']).toMatchObject({
              type: 'git_repo',
              repo: `file://${currentSource}`,
              subpath: 'skill-root',
            });
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
      if (savedSkills) {
        expect(JSON.stringify(server.requests[0])).not.toContain(
          'RETIRED_OLD_INDEX',
        );
        await expect(
          access(join(resumedRoot, '.agents/retired/SKILL.md')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(
          access(join(resumedRoot, '.agents/report/removed.sh')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        if (conflict === 'root-directory-to-file') {
          expect(
            await readFile(join(resumedRoot, '.agents/replaced-root'), 'utf8'),
          ).toBe('replacement root file');
          expect(
            (await stat(join(resumedRoot, '.agents/unrelated'))).mode & 0o777,
          ).toBe(0o700);
          if (kind === 'git-repo')
            expect(
              (await stat(join(resumedRoot, '.agents/report'))).mode & 0o777,
            ).toBe(0o700);
        }
        if (replaceDirectory) {
          expect(
            await readFile(
              join(resumedRoot, '.agents/report/replaced'),
              'utf8',
            ),
          ).toBe('replacement file');
        }
        expect(
          await readFile(join(resumedRoot, '.agents/keep.txt'), 'utf8'),
        ).toBe('unrelated namespace file');
        expect(
          await readFile(
            join(resumedRoot, '.agents/unrelated/config.txt'),
            'utf8',
          ),
        ).toBe('unrelated directory');
        expect(await readFile(join(resumedRoot, 'workspace.txt'), 'utf8')).toBe(
          'unrelated workspace file',
        );
      }
      server.assertExhausted();
    } finally {
      await peer.close();
      await rm(archiveBase, { recursive: true, force: true });
    }
  },
  20_000,
);

it.each(['count', 'aggregate', 'header'] as const)(
  'bounds %s metadata before publishing a from-source index',
  async (kind) => {
    const workspace = '/workspace';
    const f = clientFixture();
    let reads = 0;
    const document = new TextEncoder().encode(
      `---\ndescription: ${'x'.repeat(kind === 'header' ? 100_000 : 60_000)}\n---\n`,
    );
    f.client.create = async (args) => {
      const sandbox: SandboxSessionLike = {
        state: { manifest: normalizeSandboxClientCreateArgs(args).manifest },
        async close() {
          f.closed.push(sandbox);
        },
      };
      sandbox.listDir = async () =>
        Array.from(
          { length: kind === 'count' ? 1025 : kind === 'aggregate' ? 100 : 1 },
          (_, i) => ({
            name: `skill-${i}`,
            path: `.agents/skill-${i}`,
            type: 'dir' as const,
          }),
        );
      sandbox.readFile = async ({ maxBytes }) => {
        reads++;
        return document.subarray(0, maxBytes);
      };
      return sandbox;
    };
    const source = sandboxEnvironment({
      client: f.client,
      manifest: new Manifest({ root: workspace }),
      skills: skills({ from: dir({ children: {} }) }),
      connect: async () =>
        Environment.lease(
          new Environment({
            url: 'wss://fixture.invalid',
            cwd: workspace,
            capabilityDirectories: [join(workspace, '.agents')],
          }),
          async () => {},
        ),
    });
    await expect(
      acquireEnvironment(source, new AbortController().signal),
    ).rejects.toThrow(/Skill metadata.*limit/);
    if (kind === 'count') expect(reads).toBe(0);
    if (kind === 'aggregate') expect(reads).toBeLessThan(100);
    expect(f.closed).toHaveLength(1);
  },
);

nativeIt(
  'reads a bounded metadata prefix while preserving a large skill document',
  async () => {
    const peer = await startPublicExecutor();
    const server = new ModelServer([[message('bounded metadata')]]);
    await using provider = await providerFor(server);
    const document =
      '---\nname: report\ndescription: BOUNDED_NATIVE_INDEX\n---\n' +
      'body\n'.repeat(220_000);
    const readCaps: (number | undefined)[] = [];
    try {
      const source = sandboxEnvironment({
        client: new UnixLocalSandboxClient(),
        manifest: new Manifest({ root: '/workspace' }),
        skills: skills({
          from: dir({
            children: {
              report: dir({
                children: { 'SKILL.md': file({ content: document }) },
              }),
            },
          }),
        }),
        connect: async (sandbox) => {
          const read = sandbox.readFile!.bind(sandbox);
          sandbox.readFile = async (args) => {
            readCaps.push(args.maxBytes);
            return read(args);
          };
          const root = sandbox.state.workspaceRootPath;
          expect(
            await readFile(join(root, '.agents/report/SKILL.md'), 'utf8'),
          ).toBe(document);
          return Environment.lease(
            new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: root,
              capabilityDirectories: [join(root, '.agents')],
              tools: [],
            }),
            async () => {},
          );
        },
      });
      await using session = await new Agent({
        provider,
        model: 'fixture-skills',
        instructions: 'Inspect the index.',
      }).session({ environment: source });
      await (await session.submit('Inspect the index.')).wait();
      expect(readCaps).toHaveLength(1);
      expect(readCaps[0]).toBeLessThanOrEqual(65_537);
      expect(JSON.stringify(server.requests[0])).toContain(
        'BOUNDED_NATIVE_INDEX',
      );
      server.assertExhausted();
    } finally {
      await peer.close();
    }
  },
  20_000,
);

nativeIt.each(['count', 'aggregate', 'header'] as const)(
  'bounds %s metadata in the default lazy local index before activation',
  async (kind) => {
    const hostRoot = await mkdtemp(join(tmpdir(), 'lazy-skill-metadata-'));
    const document = `---\ndescription: ${'x'.repeat(kind === 'header' ? 100_000 : 60_000)}\n---\n`;
    const count = kind === 'count' ? 1025 : kind === 'aggregate' ? 100 : 1;
    const f = clientFixture();
    try {
      for (let i = 0; i < count; i++) {
        const path = join(hostRoot, `skill-${i}`);
        await mkdir(path);
        if (kind !== 'count') await writeFile(join(path, 'SKILL.md'), document);
      }
      const source = sandboxEnvironment({
        client: f.client,
        manifest: new Manifest({
          root: '/workspace',
          extraPathGrants: [{ path: hostRoot, readOnly: true }],
        }),
        skills: skills({
          lazyFrom: localDirLazySkillSource({
            src: hostRoot,
            baseDir: hostRoot,
          }),
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
      await expect(
        acquireEnvironment(source, new AbortController().signal),
      ).rejects.toThrow(/Skill metadata.*limit/);
      expect(f.closed).toHaveLength(1);
    } finally {
      await rm(hostRoot, { recursive: true, force: true });
    }
  },
);

nativeIt(
  'loads a large local lazy document from its bounded captured index',
  async () => {
    const hostRoot = await mkdtemp(join(tmpdir(), 'native-lazy-prefix-'));
    const peer = await startPublicExecutor();
    const server = new ModelServer([
      [
        call(
          'load_skill',
          { skill_name: 'report' },
          { callId: 'bounded-local' },
        ),
      ],
      [message('bounded local index')],
    ]);
    await using provider = await providerFor(server);
    const document =
      '---\nname: report\ndescription: BOUNDED_LOCAL_INDEX\n---\n' +
      'body\n'.repeat(220_000);
    let workspace = '';
    try {
      await mkdir(join(hostRoot, 'report'));
      await writeFile(join(hostRoot, 'report/SKILL.md'), document);
      const source = sandboxEnvironment({
        client: new UnixLocalSandboxClient(),
        manifest: new Manifest({
          root: '/workspace',
          extraPathGrants: [{ path: hostRoot, readOnly: true }],
        }),
        skills: skills({
          lazyFrom: localDirLazySkillSource({
            src: hostRoot,
            baseDir: hostRoot,
          }),
        }),
        connect: async (sandbox) => {
          workspace = sandbox.state.workspaceRootPath;
          return Environment.lease(
            new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: workspace,
              capabilityDirectories: [join(workspace, '.agents')],
              tools: [],
            }),
            async () => {},
          );
        },
      });
      await using session = await new Agent({
        provider,
        model: 'fixture-skills',
        instructions: 'Load the indexed skill.',
        tools: [...source.skillTools],
      }).session({ environment: source });
      await (await session.submit('Load report.')).wait();
      expect(JSON.stringify(server.requests[0])).toContain(
        'BOUNDED_LOCAL_INDEX',
      );
      expect(
        await readFile(join(workspace, '.agents/report/SKILL.md'), 'utf8'),
      ).toBe(document);
      server.assertExhausted();
    } finally {
      await peer.close();
      await rm(hostRoot, { recursive: true, force: true });
    }
  },
  20_000,
);

nativeIt.each(['members', 'depth', 'bytes'] as const)(
  'bounds selected lazy skill tree %s before provider materialization',
  async (boundary) => {
    const hostRoot = await mkdtemp(join(tmpdir(), 'native-skill-tree-'));
    const peer = await startPublicExecutor();
    const server = new ModelServer([
      [call('load_skill', { skill_name: 'report' }, { callId: 'tree-limit' })],
      [message('unexpected unbounded load')],
    ]);
    await using provider = await providerFor(server);
    let workspace = '';
    try {
      const selected = join(hostRoot, 'report');
      await mkdir(selected);
      await writeFile(
        join(selected, 'SKILL.md'),
        '---\nname: report\ndescription: SELECTED_TREE_LIMIT\n---\nbody',
      );
      const source = sandboxEnvironment({
        client: new UnixLocalSandboxClient(),
        manifest: new Manifest({
          root: '/workspace',
          extraPathGrants: [{ path: hostRoot, readOnly: true }],
        }),
        skills: skills({
          lazyFrom: localDirLazySkillSource({
            src: hostRoot,
            baseDir: hostRoot,
          }),
        }),
        connect: async (sandbox) => {
          workspace = sandbox.state.workspaceRootPath;
          // Mutate only after bounded metadata discovery, before the tool call.
          if (boundary === 'members') {
            for (let i = 0; i < 4096; i++)
              await writeFile(join(selected, `asset-${i}`), '');
          } else if (boundary === 'depth') {
            await mkdir(join(selected, ...Array(33).fill('nested')), {
              recursive: true,
            });
          } else {
            const asset = join(selected, 'large-asset');
            await writeFile(asset, '');
            await truncate(asset, 64 * 1024 * 1024 + 1);
          }
          return Environment.lease(
            new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: workspace,
              capabilityDirectories: [join(workspace, '.agents')],
              tools: [],
            }),
            async () => {},
          );
        },
      });
      await using session = await new Agent({
        provider,
        model: 'fixture-skills',
        instructions: 'Load the selected skill.',
        tools: source.skillTools,
      }).session({ environment: source });
      await expect(
        (await session.submit('Load report.')).wait(),
      ).rejects.toThrow(/skill.*(member|depth|byte).*limit/i);
      await expect(
        access(join(workspace, '.agents/report/SKILL.md')),
      ).rejects.toThrow();
      expect(server.requests).toHaveLength(1);
    } finally {
      await peer.close();
      await rm(hostRoot, { recursive: true, force: true });
    }
  },
  30_000,
);

nativeIt(
  'bounds from-source provider enumeration before native session publication',
  async () => {
    const peer = await startPublicExecutor();
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    let returned = 0;
    let reads = 0;
    class CountingClient extends UnixLocalSandboxClient {
      override async create(
        args: Parameters<UnixLocalSandboxClient['create']>[0],
      ) {
        const sandbox = await super.create(args);
        const list = sandbox.listDir.bind(sandbox);
        const read = sandbox.readFile.bind(sandbox);
        sandbox.listDir = async (request) => {
          const entries = await list(request);
          returned++;
          return entries;
        };
        sandbox.readFile = async (request) => {
          reads++;
          return read(request);
        };
        return sandbox;
      }
    }
    const children: Record<string, Entry> = {};
    for (let i = 0; i < 1025; i++)
      children[`skill-${i}`] = dir({ children: {} });
    const source = sandboxEnvironment({
      client: new CountingClient(),
      manifest: new Manifest({ root: '/workspace' }),
      skills: skills({ from: dir({ children }) }),
      connect: async (sandbox) =>
        Environment.lease(
          new Environment({
            url: peer.url,
            headers: peer.headers,
            cwd: sandbox.state.workspaceRootPath,
            capabilityDirectories: [
              join(sandbox.state.workspaceRootPath, '.agents'),
            ],
            tools: [],
          }),
          async () => {},
        ),
    });
    try {
      await expect(
        new Agent({
          provider,
          model: 'fixture-skills',
          instructions: 'Inspect skills.',
        }).session({ environment: source }),
      ).rejects.toThrow(/entry limit/);
      expect(returned).toBe(0);
      expect(reads).toBe(0);
      expect(server.requests).toHaveLength(0);
    } finally {
      await peer.close();
    }
  },
  20_000,
);

nativeIt(
  'rejects a new lazy copy after authorized cold Source restoration reaches its quota',
  async () => {
    const catalog = await mkdtemp(join(tmpdir(), 'skill-quota-catalog-'));
    const archives = await mkdtemp(join(tmpdir(), 'skill-quota-archives-'));
    const client = new UnixLocalSandboxClient();
    const seed = await client.create({
      manifest: new Manifest({
        root: '/workspace',
        entries: {
          '.agents/alpha': dir({
            children: {
              'SKILL.md': file({ content: 'previously loaded skill' }),
              asset: file({ content: new Uint8Array(33 * 1024 * 1024) }),
            },
          }),
        },
      }),
      snapshot: { type: 'local', baseDir: archives },
    });
    const saved = JSON.parse(
      JSON.stringify(await client.serializeSessionState(seed.state)),
    );
    await seed.close();
    const peer = await startPublicExecutor();
    const server = new ModelServer([
      [
        call(
          'load_skill',
          { skill_name: 'beta' },
          { callId: 'call_cold_skill_quota' },
        ),
      ],
    ]);
    await using provider = await providerFor(server);
    let resumedRoot = '';
    try {
      await mkdir(join(catalog, 'beta'));
      await writeFile(
        join(catalog, 'beta', 'SKILL.md'),
        '---\nname: beta\ndescription: CURRENT_QUOTA_INDEX\n---\n',
      );
      await writeFile(join(catalog, 'beta', 'asset'), '');
      await truncate(join(catalog, 'beta', 'asset'), 33 * 1024 * 1024);
      const resumed = new UnixLocalSandboxClient({
        resumeAuthority: {
          workspaceRootPath: saved.workspaceRootPath,
          workspaceRootOwned: true,
          localSnapshotPath: saved.snapshot.path,
        },
      });
      const state = await resumed.deserializeSessionState(saved);
      const source = sandboxEnvironment({
        client: resumed,
        manifest: new Manifest({
          root: '/workspace',
          extraPathGrants: [{ path: catalog, readOnly: true }],
        }),
        authorizedResumeState: { backendId: resumed.backendId, state },
        skills: skills({
          lazyFrom: localDirLazySkillSource({ src: catalog, baseDir: catalog }),
        }),
        connect: async (resource) => {
          resumedRoot = resource.state.workspaceRootPath;
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
        tools: source.skillTools,
        instructions: 'Load only selected skills.',
      }).session({ environment: source });
      await expect((await session.submit('Load beta.')).wait()).rejects.toThrow(
        /skill tree byte limit/i,
      );
      await expect(
        access(join(resumedRoot, '.agents/beta/SKILL.md')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(JSON.stringify(server.requests)).toContain('CURRENT_QUOTA_INDEX');
      server.assertExhausted();
    } finally {
      await peer.close();
      await rm(catalog, { recursive: true, force: true });
      await rm(archives, { recursive: true, force: true });
    }
  },
  60_000,
);

nativeIt(
  'rejects an unverified stale lazy tree in a borrowed UnixLocal workspace',
  async () => {
    const client = new UnixLocalSandboxClient();
    const sandbox = await client.create(
      new Manifest({
        entries: {
          '.agents/report': dir({
            children: {
              'SKILL.md': file({ content: 'STALE_WORKSPACE_INSTRUCTIONS' }),
              asset: file({ content: 'old asset' }),
            },
          }),
        },
      }),
    );
    const peer = await startPublicExecutor();
    const server = new ModelServer([
      [
        call(
          'load_skill',
          { skill_name: 'report' },
          { callId: 'stale-borrowed-skill' },
        ),
      ],
      [message('accepted stale skill')],
    ]);
    await using provider = await providerFor(server);
    try {
      const source = sandboxEnvironment({
        client,
        session: sandbox,
        manifest: new Manifest(),
        skills: skills({
          lazyFrom: {
            source: dir({
              children: {
                report: dir({
                  children: {
                    'SKILL.md': file({
                      content: 'CURRENT_SOURCE_INSTRUCTIONS',
                    }),
                  },
                }),
              },
            }),
            index: [{ name: 'report', description: 'CURRENT_SOURCE_INDEX' }],
          },
        }),
        connect: async () =>
          Environment.lease(
            new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: sandbox.state.workspaceRootPath,
              capabilityDirectories: [
                join(sandbox.state.workspaceRootPath, '.agents'),
              ],
              tools: [],
            }),
            async () => {},
          ),
      });
      await using session = await new Agent({
        provider,
        model: 'fixture-skills',
        instructions: 'Load the current report skill.',
        tools: source.skillTools,
      }).session({ environment: source });
      await expect(
        (await session.submit('Load report.')).wait(),
      ).rejects.toThrow(/current source|verif/i);
      expect(
        await readFile(
          join(sandbox.state.workspaceRootPath, '.agents/report/SKILL.md'),
          'utf8',
        ),
      ).toBe('STALE_WORKSPACE_INSTRUCTIONS');
      expect(
        await readFile(
          join(sandbox.state.workspaceRootPath, '.agents/report/asset'),
          'utf8',
        ),
      ).toBe('old asset');
      expect(server.requests).toHaveLength(1);
    } finally {
      await sandbox.close();
      await peer.close();
    }
  },
  20_000,
);
