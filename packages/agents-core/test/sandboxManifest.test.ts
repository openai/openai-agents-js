import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  cloneManifest,
  Environment,
  FileMode,
  Manifest,
  normalizeRelativePath,
  Permissions,
  renderManifestDescription,
  type Dir,
  type File,
  type GitRepo,
  type AzureBlobMount,
  type BoxMount,
  type GCSMount,
  type LocalDir,
  type ManifestEntries,
  type Mount,
  type R2Mount,
  type S3Mount,
} from '../src/sandbox';

describe('Manifest', () => {
  it('infers inline entry types from entry discriminators', () => {
    const entries = {
      'README.md': {
        type: 'file',
        content: 'hello',
      },
      src: {
        type: 'dir',
        children: {
          'index.ts': {
            type: 'file',
            content: 'export {};\n',
          },
        },
      },
      local: {
        type: 'local_dir',
        src: '/tmp/local',
      },
      repo: {
        type: 'git_repo',
        repo: 'https://github.com/openai/openai-agents-js',
      },
      data: {
        type: 'mount',
        source: 's3://bucket/data',
        mountStrategy: { type: 'in_container' },
      },
    } satisfies ManifestEntries;
    const manifest = new Manifest({
      entries,
      environment: {
        API_KEY: {
          value: 'secret',
          ephemeral: true,
        },
      },
    });
    const inlineManifest = new Manifest({
      entries: {
        'inline.txt': {
          type: 'file',
          content: 'hello',
        },
      },
    });

    expectTypeOf(manifest.entries['README.md']).toMatchTypeOf<File>();
    expectTypeOf(manifest.entries.src).toMatchTypeOf<Dir>();
    expectTypeOf(manifest.entries.local).toMatchTypeOf<LocalDir>();
    expectTypeOf(manifest.entries.repo).toMatchTypeOf<GitRepo>();
    expectTypeOf(manifest.entries.data).toMatchTypeOf<Mount>();
    expectTypeOf(manifest.environment.API_KEY).toEqualTypeOf<Environment>();
    expectTypeOf(inlineManifest.entries['inline.txt']).toMatchTypeOf<File>();
  });

  it('rejects nested child paths with parent segments', () => {
    expect(
      () =>
        new Manifest({
          entries: {
            safe: {
              type: 'dir',
              children: {
                '../outside.txt': {
                  type: 'file',
                  content: 'nope',
                },
              },
            },
          },
        }),
    ).toThrow(/must not contain parent segments/i);
  });

  it('resolves async environment values and keeps normalized env serializable', async () => {
    const manifest = new Manifest({
      environment: {
        STATIC_VALUE: 'static',
        ASYNC_VALUE: {
          value: 'placeholder',
          resolve: async () => 'resolved',
          ephemeral: true,
          description: 'loaded at runtime',
        },
      },
    });
    const cloned = cloneManifest(manifest);
    const reconstructed = new Manifest({
      environment: cloned.environment as any,
    });

    await expect(manifest.resolveEnvironment()).resolves.toEqual({
      STATIC_VALUE: 'static',
      ASYNC_VALUE: 'resolved',
    });
    await expect(cloned.resolveEnvironment()).resolves.toEqual({
      STATIC_VALUE: 'static',
      ASYNC_VALUE: 'resolved',
    });
    await expect(reconstructed.resolveEnvironment()).resolves.toEqual({
      STATIC_VALUE: 'static',
      ASYNC_VALUE: 'resolved',
    });
    expect(manifest.environment.ASYNC_VALUE.normalized()).toEqual({
      value: 'placeholder',
      ephemeral: true,
      description: 'loaded at runtime',
    });
  });

  it('rejects backslash-separated paths before host resolution', () => {
    expect(() => normalizeRelativePath('..\\outside.txt')).toThrow(
      /must use "\/" separators/i,
    );
    expect(
      () =>
        new Manifest({
          root: '/workspace\\subdir',
        }),
    ).toThrow(/must use "\/" separators/i);
    expect(
      () =>
        new Manifest({
          entries: {
            data: {
              type: 'mount',
              source: 's3://bucket/data',
              mountPath: 'data\\reports',
            },
          },
        }),
    ).toThrow(/must use "\/" separators/i);
    expect(
      () =>
        new Manifest({
          extraPathGrants: [{ path: '/tmp\\secrets' }],
        }),
    ).toThrow(/must use "\/" separators/i);
  });

  it('rejects nested absolute child paths', () => {
    expect(
      () =>
        new Manifest({
          entries: {
            safe: {
              type: 'dir',
              children: {
                '/tmp/outside.txt': {
                  type: 'file',
                  content: 'nope',
                },
              },
            },
          },
        }),
    ).toThrow(/must be relative/i);
  });

  it('normalizes roots and relative paths', () => {
    const manifest = new Manifest({
      root: '/workspace//./',
      entries: {
        ' ./src//index.ts ': {
          type: 'file',
          content: 'export {};\n',
        },
      },
    });
    const rootManifest = new Manifest({
      root: '/',
      entries: {
        '.': {
          type: 'dir',
        },
      },
    });

    expect(manifest.root).toBe('/workspace');
    expect(Object.keys(manifest.entries)).toEqual(['src/index.ts']);
    expect(normalizeRelativePath(' ./src//index.ts ')).toBe('src/index.ts');
    expect([...manifest.iterEntries()][0]).toMatchObject({
      logicalPath: 'src/index.ts',
      absolutePath: '/workspace/src/index.ts',
    });
    expect(Object.keys(rootManifest.entries)).toEqual(['']);
    expect([...rootManifest.iterEntries()][0]).toMatchObject({
      logicalPath: '',
      absolutePath: '/',
    });
    expect(
      [
        ...new Manifest({
          root: '/',
          entries: {
            'src/app.py': {
              type: 'file',
              content: 'print("hello")\n',
            },
          },
        }).iterEntries(),
      ][0],
    ).toMatchObject({
      logicalPath: 'src/app.py',
      absolutePath: '/src/app.py',
    });
    expect(() => new Manifest({ root: 'workspace' })).toThrow(
      /must be absolute/i,
    );
    expect(() => new Manifest({ root: '/workspace/..' })).toThrow(
      /must not contain parent segments/i,
    );
    expect(() => new Manifest({ root: '/vercel/sandbox/..' })).toThrow(
      /must not contain parent segments/i,
    );
    expect(
      () =>
        new Manifest({
          entries: {
            'src/index.ts': {
              type: 'file',
              content: 'ok',
            },
            './src//index.ts': {
              type: 'file',
              content: 'duplicate',
            },
          },
        }),
    ).toThrow(/duplicates normalized path "src\/index.ts"/i);
    expect(
      () =>
        new Manifest({
          entries: {
            src: {
              type: 'dir',
              children: {
                'index.ts': {
                  type: 'file',
                  content: 'nested',
                },
              },
            },
            'src/index.ts': {
              type: 'file',
              content: 'flattened',
            },
          },
        }),
    ).toThrow(/duplicates normalized path "src\/index.ts"/i);
  });

  it('normalizes Python-compatible GitRepo fields', () => {
    const manifest = new Manifest({
      entries: {
        repo: {
          type: 'git_repo',
          host: ' github.example.com ',
          repo: ' openai/openai-agents-js ',
          ref: 'main',
          subpath: './packages/agents-core',
        },
      },
    });
    const repo = manifest.entries.repo as GitRepo;

    expect(repo.host).toBe('github.example.com');
    expect(repo.repo).toBe('openai/openai-agents-js');
    expect(repo.subpath).toBe('packages/agents-core');
  });

  it('normalizes typed mount config and defaults', () => {
    const manifest = new Manifest({
      entries: {
        data: {
          type: 's3_mount',
          bucket: 'bucket',
          prefix: 'reports',
          mountPath: '/mnt/./data/',
          readOnly: false,
          mountStrategy: {
            type: 'docker_volume',
            driverOptions: {
              type: 'nfs',
            },
          },
        },
        gcs: {
          type: 'gcs_mount',
          bucket: 'gcs-bucket',
          prefix: 'exports',
          region: 'auto',
          endpointUrl: 'https://storage.example.test',
        },
        r2: {
          type: 'r2_mount',
          bucket: 'r2-bucket',
          accountId: 'account-id',
          customDomain: 'https://r2.example.test',
        },
        azure: {
          type: 'azure_blob_mount',
          container: 'container',
          prefix: 'runs',
          account: 'storage-account',
          endpointUrl: 'https://blob.example.test',
        },
        box: {
          type: 'box_mount',
          path: '/Shared/Reports',
          boxSubType: 'enterprise',
          rootFolderId: '12345',
          impersonate: 'agent@example.com',
          ownedBy: 'owner@example.com',
          accessToken: 'secret-token',
        },
      },
    });
    const data = manifest.entries.data as S3Mount;

    expect(data.ephemeral).toBe(true);
    expect(data.readOnly).toBe(false);
    expect(data.mountPath).toBe('/mnt/data');
    expect(data.mountStrategy).toEqual({
      type: 'docker_volume',
      driverOptions: {
        type: 'nfs',
      },
    });
    expect(data.provider).toBe('s3');
    expect(data.config).toMatchObject({
      bucket: 'bucket',
      prefix: 'reports',
    });
    expect((manifest.entries.gcs as GCSMount).config).toMatchObject({
      bucket: 'gcs-bucket',
      prefix: 'exports',
      region: 'auto',
      endpointUrl: 'https://storage.example.test',
    });
    expect((manifest.entries.r2 as R2Mount).config).toMatchObject({
      bucket: 'r2-bucket',
      accountId: 'account-id',
      customDomain: 'https://r2.example.test',
    });
    expect((manifest.entries.azure as AzureBlobMount).config).toMatchObject({
      container: 'container',
      prefix: 'runs',
      account: 'storage-account',
      endpointUrl: 'https://blob.example.test',
    });
    expect((manifest.entries.box as BoxMount).provider).toBe('box');
    expect((manifest.entries.box as BoxMount).config).toMatchObject({
      path: '/Shared/Reports',
      boxSubType: 'enterprise',
      rootFolderId: '12345',
      impersonate: 'agent@example.com',
      ownedBy: 'owner@example.com',
    });
    expect((manifest.entries.box as BoxMount).config).not.toHaveProperty(
      'accessToken',
    );
  });

  it('clones manifests without sharing entries or environment values', () => {
    const manifest = new Manifest({
      entries: {
        'notes.txt': {
          type: 'file',
          content: 'original',
          permissions: '-rw-r-----',
        },
      },
      environment: {
        TOKEN: {
          value: 'secret',
          ephemeral: true,
          description: 'token',
        },
      },
      users: [{ name: 'sandbox-user' }],
      groups: [{ name: 'sandbox-group', users: [{ name: 'sandbox-user' }] }],
      extraPathGrants: [{ path: '/tmp/data', readOnly: true }],
      remoteMountCommandAllowlist: ['ls', 'cat'],
    });
    const cloned = cloneManifest(manifest);

    (cloned.entries['notes.txt'] as { content: string }).content = 'cloned';
    cloned.users[0].name = 'changed';

    expect((manifest.entries['notes.txt'] as { content: string }).content).toBe(
      'original',
    );
    expect((manifest.entries['notes.txt'] as File).permissions).toMatchObject({
      owner: FileMode.READ | FileMode.WRITE,
      group: FileMode.READ,
      other: FileMode.NONE,
    });
    expect(cloned.environment.TOKEN).toBeInstanceOf(Environment);
    expect(cloned.environment.TOKEN.normalized()).toEqual({
      value: 'secret',
      ephemeral: true,
      description: 'token',
    });
    expect(manifest.users[0].name).toBe('sandbox-user');
    expect(cloned.extraPathGrants).toEqual([
      {
        path: '/tmp/data',
        readOnly: true,
      },
    ]);
    expect(cloned.remoteMountCommandAllowlist).toEqual(['ls', 'cat']);
  });

  it('normalizes manifest identity, permissions, and path policy fields', () => {
    const manifest = new Manifest({
      users: [{ name: ' sandbox-user ' }],
      groups: [
        {
          name: ' sandbox-group ',
          users: [{ name: ' sandbox-user ' }],
        },
      ],
      extraPathGrants: [
        {
          path: '/var/tmp/data',
          readOnly: true,
          description: 'fixture data',
        },
      ],
      remoteMountCommandAllowlist: ['ls', 'cat'],
      entries: {
        bin: {
          type: 'dir',
          permissions: {
            owner: FileMode.ALL,
            group: FileMode.READ | FileMode.EXEC,
            other: FileMode.NONE,
            directory: true,
          },
          group: {
            name: ' sandbox-group ',
            users: [{ name: ' sandbox-user ' }],
          },
          children: {
            'run.sh': {
              type: 'file',
              content: '#!/bin/sh\n',
              permissions: '-rwxr-x---',
            },
          },
        },
      },
    });

    expect(manifest.users).toEqual([{ name: 'sandbox-user' }]);
    expect(manifest.groups).toEqual([
      {
        name: 'sandbox-group',
        users: [{ name: 'sandbox-user' }],
      },
    ]);
    expect(manifest.extraPathGrants).toEqual([
      {
        path: '/var/tmp/data',
        readOnly: true,
        description: 'fixture data',
      },
    ]);
    expect(manifest.remoteMountCommandAllowlist).toEqual(['ls', 'cat']);
    expect((manifest.entries.bin as Dir).permissions).toEqual({
      owner: FileMode.ALL,
      group: FileMode.READ | FileMode.EXEC,
      other: FileMode.NONE,
      directory: true,
    });
    expect((manifest.entries.bin as Dir).group).toEqual({
      name: 'sandbox-group',
      users: [{ name: 'sandbox-user' }],
    });
    expect(
      ((manifest.entries.bin as Dir).children!['run.sh'] as File).permissions,
    ).toEqual({
      owner: FileMode.ALL,
      group: FileMode.READ | FileMode.EXEC,
      other: FileMode.NONE,
      directory: false,
    });
  });

  it('normalizes mount entry config and defaults', () => {
    const manifest = new Manifest({
      entries: {
        data: {
          type: 'mount',
          source: 's3://bucket/data',
          mountPath: ' ./data// ',
          readOnly: false,
          mountStrategy: {
            type: ' in_container ',
            pattern: { provider: 's3' },
          },
        },
      },
    });
    const mount = manifest.entries.data as Mount;

    expect(mount).toMatchObject({
      type: 'mount',
      source: 's3://bucket/data',
      mountPath: 'data',
      readOnly: false,
      mountStrategy: {
        type: 'in_container',
        pattern: { provider: 's3' },
      },
    });
  });

  it('rejects known snake_case mount config aliases', () => {
    expect(
      () =>
        new Manifest({
          entries: {
            data: {
              type: 'mount',
              mount_path: '/mnt/data',
            } as any,
          },
        }),
    ).toThrow('snake_case key "mount_path" is not supported');

    expect(
      () =>
        new Manifest({
          entries: {
            data: {
              type: 'mount',
              mountStrategy: {
                type: 'docker_volume',
                driver_options: {},
              },
            } as any,
          },
        }),
    ).toThrow('snake_case key "driver_options" is not supported');

    expect(
      () =>
        new Manifest({
          entries: {
            box: {
              type: 'box_mount',
              access_token: 'secret',
            } as any,
          },
        }),
    ).toThrow('snake_case key "access_token" is not supported');
  });

  it('rejects known snake_case manifest and path grant config aliases', () => {
    expect(
      () =>
        new Manifest({
          extra_path_grants: [],
        } as any),
    ).toThrow('snake_case key "extra_path_grants" is not supported');

    expect(
      () =>
        new Manifest({
          extraPathGrants: [
            {
              path: '/var/tmp/data',
              read_only: true,
            },
          ],
        } as any),
    ).toThrow('snake_case key "read_only" is not supported');
  });

  it('parses permission strings and modes', () => {
    const executable = Permissions.fromString('-rwxr-x---');
    const directory = Permissions.fromMode(0o40750);

    expect(executable.toMode() & 0o777).toBe(0o750);
    expect(executable.toString()).toBe('-rwxr-x---');
    expect(directory.normalized()).toEqual({
      owner: FileMode.ALL,
      group: FileMode.READ | FileMode.EXEC,
      other: FileMode.NONE,
      directory: true,
    });
    expect(directory.toString()).toBe('drwxr-x---');
  });

  it('rejects invalid manifest identity and permission metadata', () => {
    expect(() => new Manifest({ users: [{ name: ' ' }] })).toThrow(
      /user name must be non-empty/i,
    );
    expect(
      () =>
        new Manifest({
          extraPathGrants: [{ path: '/' }],
        }),
    ).toThrow(/must not be filesystem root/i);
    expect(
      () =>
        new Manifest({
          extraPathGrants: [{ path: 'relative/path' }],
        }),
    ).toThrow(/must be absolute/i);
    expect(
      () =>
        new Manifest({
          extraPathGrants: [{ path: '/var/tmp/../tmp/data' }],
        }),
    ).toThrow(/path grant path must not contain parent segments/i);
    expect(
      () =>
        new Manifest({
          entries: {
            data: {
              type: 'mount',
              source: 's3://bucket/data',
              mountPath: '/mnt/../data',
            },
          },
        }),
    ).toThrow(/must not contain parent segments/i);
    expect(
      () =>
        new Manifest({
          entries: {
            bad: {
              type: 'file',
              content: 'bad',
              permissions: {
                owner: 8,
              },
            },
          },
        }),
    ).toThrow(/permission owner bits/i);
  });

  it('includes nested ephemeral children in ephemeralEntryPaths', () => {
    const manifest = new Manifest({
      entries: {
        dir: {
          type: 'dir',
          children: {
            'keep.txt': {
              type: 'file',
              content: 'keep',
            },
            'tmp.txt': {
              type: 'file',
              content: 'tmp',
              ephemeral: true,
            },
          },
        },
      },
    });

    expect([...manifest.ephemeralEntryPaths()].map(String)).toEqual([
      'dir/tmp.txt',
    ]);
  });

  it('resolves mount targets and persistence exclusions', () => {
    const manifest = new Manifest({
      root: '/workspace',
      entries: {
        data: {
          type: 'mount',
          source: 's3://bucket/data',
          mountPath: 'custom/data',
        },
        cache: {
          type: 'mount',
          source: 's3://bucket/cache',
          ephemeral: false,
          mountPath: 'custom/cache',
        },
        external: {
          type: 'mount',
          source: 's3://bucket/external',
          mountPath: '/mnt/external',
        },
      },
    });

    expect(manifest.mountTargets().map((target) => target.mountPath)).toEqual([
      '/workspace/custom/cache',
      '/workspace/custom/data',
      '/mnt/external',
    ]);
    expect(
      manifest.ephemeralMountTargets().map((target) => target.mountPath),
    ).toEqual(['/workspace/custom/data', '/mnt/external']);
    expect([...manifest.ephemeralPersistencePaths()].sort()).toEqual([
      'custom/data',
      'data',
      'external',
    ]);
  });

  it('orders mount targets by usage', () => {
    const manifest = new Manifest({
      root: '/workspace',
      entries: {
        parent: {
          type: 'mount',
          source: 's3://bucket/parent',
          mountPath: 'mounted',
        },
        child: {
          type: 'mount',
          source: 's3://bucket/child',
          mountPath: 'mounted/cache',
        },
        other: {
          type: 'mount',
          source: 's3://bucket/other',
        },
      },
    });

    expect(manifest.mountTargets().map((target) => target.mountPath)).toEqual([
      '/workspace/mounted/cache',
      '/workspace/mounted',
      '/workspace/other',
    ]);
    expect(
      manifest
        .mountTargetsForMaterialization()
        .map((target) => target.mountPath),
    ).toEqual([
      '/workspace/mounted',
      '/workspace/other',
      '/workspace/mounted/cache',
    ]);
  });

  it('preserves tree rendering in describe', () => {
    const manifest = new Manifest({
      root: '/workspace',
      entries: {
        repo: {
          type: 'dir',
          description: 'project root',
          children: {
            'README.md': {
              type: 'file',
              content: 'hi',
              description: 'overview',
            },
          },
        },
        data: {
          type: 'dir',
          description: 'shared data',
        },
      },
    });

    const description = manifest.describe(2);

    expect(description.startsWith('/workspace\n')).toBe(true);
    expect(description).toContain('data/');
    expect(description).toContain('/workspace/data');
    expect(description).toContain('repo/');
    expect(description).toContain('/workspace/repo/README.md');
  });

  it('reports truncation guidance when the rendered tree is too large', () => {
    const manifest = new Manifest({
      root: '/workspace',
      entries: Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [
          `file_${String(index).padStart(3, '0')}.txt`,
          {
            type: 'file',
            content: '',
            description: 'x'.repeat(40),
          },
        ]),
      ),
    });

    const rendered = renderManifestDescription(manifest, { depth: 3 });

    expect(rendered.text).toContain('... (truncated ');
    expect(rendered.text).toContain(
      'Hint: increase depth, maxLines, or maxChars to see more of the manifest layout.',
    );
  });

  it('reports rendered and total path counts for depth and line limits', () => {
    const manifest = new Manifest({
      entries: {
        dir: {
          type: 'dir',
          children: {
            'a.txt': {
              type: 'file',
              content: 'a',
            },
            'b.txt': {
              type: 'file',
              content: 'b',
            },
          },
        },
      },
    });

    const shallow = renderManifestDescription(manifest, {
      depth: 1,
      maxLines: 5,
    });
    const limited = renderManifestDescription(manifest, {
      depth: null,
      maxLines: 2,
    });

    expect(shallow).toMatchObject({
      renderedPaths: 1,
      totalPaths: 1,
    });
    expect(limited).toMatchObject({
      renderedPaths: 1,
      totalPaths: 3,
    });
    expect(limited.text).toContain('truncated 2 additional paths');
  });

  it('limits rendered manifest descriptions by character count', () => {
    const manifest = new Manifest({
      root: '/workspace',
      entries: Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [
          `file_${index}.txt`,
          {
            type: 'file',
            content: '',
            description: 'long description '.repeat(8),
          },
        ]),
      ),
    });

    const rendered = renderManifestDescription(manifest, {
      depth: null,
      maxChars: 180,
    });

    expect(rendered.renderedPaths).toBeLessThan(rendered.totalPaths);
    expect(rendered.text.length).toBeLessThanOrEqual(180);
    expect(rendered.text).toContain('truncated');
  });
});
