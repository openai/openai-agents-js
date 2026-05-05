import { describe, expect, it } from 'vitest';
import { Manifest, dir, file, mount } from '../src/sandbox';
import {
  deserializeManifest,
  deserializePersistedEnvironmentForRuntime,
  imageOutputFromBytes,
  materializeEnvironment,
  materializeStaticEnvironment,
  MAX_VIEW_IMAGE_BYTES,
  mergeManifestDelta,
  mergeManifestEntryDelta,
  mergeMaterializedEnvironment,
  mergeStaticMaterializedEnvironment,
  serializeManifestEnvironment,
  serializeManifestRecord,
  serializeRuntimeEnvironmentForPersistence,
  sniffImageMediaType,
  truncateOutput,
} from '../src/sandbox/internal';
import {
  stableJsonPrettyStringify,
  stableJsonStringify,
} from '../src/sandbox/shared/stableJson';
import { jsonEqual } from '../src/sandbox/shared/compare';
import {
  hasEscapingParentPathSegment,
  hasParentPathSegment,
  isUnderPosixPath,
  normalizePosixPath,
  posixDirname,
  relativePosixPathWithinRoot,
} from '../src/sandbox/shared/posixPath';

describe('sandbox shared helpers', () => {
  it('truncates output with a byte budget and keeps head and tail context', () => {
    const result = truncateOutput('0123456789abcdef', 2);

    expect(result).toEqual({
      text: 'Total output lines: 1\n\n0123...2 tokens truncated...cdef',
      originalTokenCount: 4,
    });
  });

  it('preserves active process truncation notices when applying output budgets', () => {
    const result = truncateOutput(
      '[...1200 characters truncated from process output...]\n0123456789abcdef',
      2,
    );

    expect(result.text).toContain('characters truncated from process output');
    expect(result.text).toContain('tokens truncated');
  });

  it('sniffs image media types from bytes and falls back to path extensions', () => {
    expect(sniffImageMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBe(
      'image/png',
    );
    expect(sniffImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe(
      'image/jpeg',
    );
    expect(sniffImageMediaType(Uint8Array.from([0]), 'diagram.svg')).toBe(
      'image/svg+xml',
    );
    expect(sniffImageMediaType(Uint8Array.from([0]))).toBeNull();
  });

  it('builds image tool output from bytes with shared validation', () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

    expect(imageOutputFromBytes('diagram.png', bytes)).toEqual({
      type: 'image',
      image: {
        data: bytes,
        mediaType: 'image/png',
      },
    });
    expect(() =>
      imageOutputFromBytes(
        'large.png',
        new Uint8Array(MAX_VIEW_IMAGE_BYTES + 1),
      ),
    ).toThrow('Image file exceeds the 10 MB limit: large.png');
    expect(() =>
      imageOutputFromBytes('notes.txt', Uint8Array.from([0])),
    ).toThrow('Unsupported image format for view_image: notes.txt');
  });

  it('stable-stringifies JSON-like values with sorted object keys', () => {
    expect(
      stableJsonStringify({
        b: 2,
        a: {
          d: 4,
          c: Uint8Array.from([1, 2]),
        },
      }),
    ).toBe('{"a":{"c":{"type":"Uint8Array","data":[1,2]},"d":4},"b":2}');
    expect(
      stableJsonPrettyStringify({
        b: 2,
        a: 1,
      }),
    ).toBe('{\n  "a":1,\n  "b":2\n}');
    expect(jsonEqual({ b: 2, a: 1 }, { a: 1, b: 2 })).toBe(true);
  });

  it('normalizes POSIX sandbox paths and compares roots', () => {
    expect(normalizePosixPath('/workspace//src/../README.md')).toBe(
      '/workspace/README.md',
    );
    expect(normalizePosixPath('src/../README.md')).toBe('README.md');
    expect(hasParentPathSegment('src/../README.md')).toBe(true);
    expect(hasEscapingParentPathSegment('src/../README.md')).toBe(false);
    expect(hasEscapingParentPathSegment('../secret.txt')).toBe(true);
    expect(isUnderPosixPath('/workspace/app.ts', '/workspace')).toBe(true);
    expect(isUnderPosixPath('/workspace-other/app.ts', '/workspace')).toBe(
      false,
    );
    expect(
      relativePosixPathWithinRoot('/workspace', '/workspace/src/app.ts'),
    ).toBe('src/app.ts');
    expect(relativePosixPathWithinRoot('/workspace', '/tmp/app.ts')).toBeNull();
    expect(posixDirname('/workspace/src/app.ts')).toBe('/workspace/src');
    expect(posixDirname('/workspace/src/')).toBe('/workspace');
    expect(posixDirname('/')).toBe('/');
    expect(posixDirname('README.md')).toBe('.');
  });

  it('serializes manifests without ephemeral entries or environment values', () => {
    const manifest = new Manifest({
      entries: {
        'kept.txt': file({ content: 'ok' }),
        'tmp.txt': file({ content: 'skip', ephemeral: true }),
        mounted: mount({
          source: 's3://bucket/data',
        }),
        ephemeral: dir({
          ephemeral: true,
          children: {
            'skip.txt': file({ content: 'skip' }),
            mounted: mount({
              source: 's3://bucket/nested',
            }),
          },
        }),
        dir: dir({
          children: {
            'nested.txt': file({ content: 'ok' }),
            'nested.tmp': file({ content: 'skip', ephemeral: true }),
          },
        }),
      },
      environment: {
        KEPT: { value: 'ok' },
        SKIPPED: {
          value: 'secret',
          ephemeral: true,
        },
      },
    });

    const serialized = serializeManifestRecord(manifest);

    expect(serialized).toMatchObject({
      entries: {
        'kept.txt': { content: 'ok' },
        mounted: {
          type: 'mount',
          source: 's3://bucket/data',
          ephemeral: true,
          readOnly: true,
        },
        ephemeral: {
          children: {
            mounted: {
              type: 'mount',
              source: 's3://bucket/nested',
              ephemeral: true,
              readOnly: true,
            },
          },
        },
        dir: {
          children: {
            'nested.txt': { content: 'ok' },
          },
        },
      },
      environment: {
        KEPT: { value: 'ok' },
      },
    });
    expect(serialized.entries).not.toHaveProperty('tmp.txt');
    expect(serialized.entries).not.toHaveProperty([
      'ephemeral',
      'children',
      'skip.txt',
    ]);
    expect(serialized.entries).not.toHaveProperty([
      'dir',
      'children',
      'nested.tmp',
    ]);
  });

  it('encodes binary manifest files for JSON persistence', () => {
    const bytes = Uint8Array.from([0, 255, 34, 17, 128, 64]);
    const manifest = new Manifest({
      entries: {
        'image.bin': file({ content: bytes }),
        nested: dir({
          children: {
            'payload.bin': file({ content: bytes }),
          },
        }),
      },
    });

    const serialized = serializeManifestRecord(manifest);
    const jsonRoundTrip = JSON.parse(JSON.stringify(serialized));
    const restored = deserializeManifest(jsonRoundTrip);

    expect((serialized.entries as any)['image.bin'].content).toEqual({
      type: 'base64',
      data: 'AP8iEYBA',
    });
    expect((restored.entries['image.bin'] as any).content).toEqual(bytes);
    expect(
      (restored.entries.nested as any).children['payload.bin'].content,
    ).toEqual(bytes);
  });

  it('materializes manifest environment values and preserves runtime overrides', async () => {
    const previous = new Manifest({
      environment: {
        KEEP: 'previous',
        OVERRIDE: 'old',
      },
    });
    const next = new Manifest({
      environment: {
        KEEP: 'next',
        OVERRIDE: 'next-manifest',
        NEW_VALUE: 'new',
      },
    });

    await expect(
      materializeEnvironment(previous, {
        OVERRIDE: 'runtime',
        TOKEN: 'client',
      }),
    ).resolves.toEqual({
      KEEP: 'previous',
      OVERRIDE: 'old',
      TOKEN: 'client',
    });
    await expect(
      mergeMaterializedEnvironment(previous, next, {
        KEEP: 'previous',
        OVERRIDE: 'runtime',
        TOKEN: 'client',
      }),
    ).resolves.toEqual({
      KEEP: 'next',
      OVERRIDE: 'next-manifest',
      NEW_VALUE: 'new',
      TOKEN: 'client',
    });
  });

  it('serializes and restores manifest-bound runtime environment values', async () => {
    const manifest = new Manifest({
      environment: {
        KEEP: {
          value: 'manifest',
          description: 'stored',
        },
        TOKEN: {
          value: 'placeholder',
          resolve: async () => 'resolved-token',
        },
        SECRET: {
          value: 'secret',
          ephemeral: true,
        },
      },
    });

    expect(serializeManifestEnvironment(manifest)).toEqual({
      KEEP: {
        value: 'manifest',
        description: 'stored',
      },
      TOKEN: {
        value: 'placeholder',
      },
      SECRET: {
        value: 'secret',
        ephemeral: true,
      },
    });
    await expect(materializeEnvironment(manifest)).resolves.toMatchObject({
      TOKEN: 'resolved-token',
    });
    expect(
      serializeRuntimeEnvironmentForPersistence(manifest, {
        KEEP: 'runtime-keep',
        TOKEN: 'resolved-token',
        SECRET: 'runtime-secret',
        CLIENT_ONLY: 'skip',
      }),
    ).toEqual({
      KEEP: 'manifest',
      TOKEN: 'resolved-token',
    });
    expect(
      deserializePersistedEnvironmentForRuntime(
        manifest,
        {
          KEEP: 'persisted',
          TOKEN: 'persisted-token',
          SECRET: 'persisted-secret',
          CLIENT_ONLY: 'persisted-client',
        },
        {
          CLIENT_ONLY: 'client',
        },
      ),
    ).toEqual({
      CLIENT_ONLY: 'client',
      KEEP: 'persisted',
      TOKEN: 'persisted-token',
    });
  });

  it('materializes static manifest environment without invoking resolvers', () => {
    const previous = new Manifest({
      environment: {
        TOKEN: {
          value: 'placeholder',
          resolve: () => {
            throw new Error('resolver should not run');
          },
        },
      },
    });
    const next = new Manifest({
      environment: {
        TOKEN: 'next',
      },
    });

    expect(materializeStaticEnvironment(previous)).toEqual({
      TOKEN: 'placeholder',
    });
    expect(
      mergeStaticMaterializedEnvironment(previous, next, {
        TOKEN: 'runtime',
        CLIENT_ONLY: 'client',
      }),
    ).toEqual({
      CLIENT_ONLY: 'client',
      TOKEN: 'next',
    });
  });

  it('merges manifest deltas by replacing named and path-keyed entries', () => {
    const base = new Manifest({
      entries: {
        'base.txt': file({ content: 'base' }),
      },
      groups: [{ name: 'operators', users: [{ name: 'agent' }] }],
      extraPathGrants: [{ path: '/tmp/base', readOnly: true }],
    });
    const update = new Manifest({
      entries: {
        'update.txt': file({ content: 'update' }),
      },
      groups: [{ name: 'operators', users: [{ name: 'reviewer' }] }],
      extraPathGrants: [{ path: '/tmp/base', readOnly: false }],
    });

    const merged = mergeManifestDelta(base, update);

    expect(Object.keys(merged.entries)).toEqual(['base.txt', 'update.txt']);
    expect(merged.groups).toEqual([
      { name: 'operators', users: [{ name: 'reviewer' }] },
    ]);
    expect(merged.extraPathGrants).toEqual([
      { path: '/tmp/base', readOnly: false },
    ]);
  });

  it('merges single manifest entry deltas without rebuilding the delta inline', () => {
    const base = new Manifest({
      root: '/workspace',
      entries: {
        'base.txt': file({ content: 'base' }),
      },
    });

    const merged = mergeManifestEntryDelta(
      base,
      'nested/update.txt',
      file({ content: 'update' }),
    );

    expect(merged.root).toBe('/workspace');
    expect(merged.entries).toEqual({
      'base.txt': file({ content: 'base' }),
      'nested/update.txt': file({ content: 'update' }),
    });
  });
});
