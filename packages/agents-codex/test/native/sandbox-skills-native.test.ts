import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
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
