import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Manifest, UnixLocalSandboxSession } from '../../src/sandbox/local';
import { materializeLocalWorkspaceManifestEntry } from '../../src/sandbox/sandboxes/shared/localWorkspace';

describe('local workspace logical paths', () => {
  // Inspect diagnostics at the materialization boundary because public session
  // paths are normalized before they reach the recursive materializer.
  it.each([
    ['', 'leaf.txt'],
    ['.', 'leaf.txt'],
    ['parent', 'parent/leaf.txt'],
    ['parent/', 'parent/leaf.txt'],
    ['parent//nested///', 'parent//nested/leaf.txt'],
    ['parent/\n', 'parent/\n/leaf.txt'],
  ])('preserves child diagnostics under %j', async (parent, expectedPath) => {
    await expect(
      materializeLocalWorkspaceManifestEntry('/unused', parent, {
        type: 'dir',
        children: {
          './leaf.txt/': {
            type: 'file',
            content: '',
            group: { name: 'unsupported-group' },
          },
        },
      }),
    ).rejects.toThrow(
      `Local sandbox materialization does not support sandbox entry group ownership yet: ${expectedPath}`,
    );
  });

  it('materializes nested files through a session with normalized paths', async () => {
    const workspaceRootPath = await mkdtemp(
      join(tmpdir(), 'logical-path-test-'),
    );
    const session = new UnixLocalSandboxSession({
      state: {
        manifest: new Manifest(),
        workspaceRootPath,
        workspaceRootOwned: false,
        environment: {},
      },
    });
    try {
      await session.materializeEntry({
        path: 'parent//nested/',
        entry: {
          type: 'dir',
          children: {
            './leaf.txt/': { type: 'file', content: 'hello' },
          },
        },
      });
      expect(
        await readFile(
          join(workspaceRootPath, 'parent/nested/leaf.txt'),
          'utf8',
        ),
      ).toBe('hello');
    } finally {
      await session.close();
      await rm(workspaceRootPath, { recursive: true, force: true });
    }
  });
});
