import { describe, expect, it } from 'vitest';
import {
  SandboxInvalidManifestPathError,
  SandboxWorkspaceScope,
  WorkspacePathPolicy,
} from '../src/sandbox';

describe('SandboxWorkspaceScope', () => {
  it('anchors relative tool paths without changing absolute paths', () => {
    const scope = SandboxWorkspaceScope.fromCwd('tasks/a');

    expect(scope.anchor()).toBe('tasks/a');
    expect(scope.anchor('reports/plot.png')).toBe('tasks/a/reports/plot.png');
    expect(scope.anchor('/workspace/shared.txt')).toBe('/workspace/shared.txt');
    expect(scope.modelResourcePath('/workspace', '.agents/reviewer')).toBe(
      '/workspace/.agents/reviewer',
    );
    expect(scope.absoluteCwd('/workspace')).toBe('/workspace/tasks/a');
  });

  it('preserves root-relative behavior when cwd is omitted', () => {
    const scope = new SandboxWorkspaceScope();

    expect(scope.anchor('reports/plot.png')).toBe('reports/plot.png');
    expect(scope.modelResourcePath('/workspace', '.agents/reviewer')).toBe(
      '.agents/reviewer',
    );
    expect(scope.absoluteCwd('/workspace')).toBeUndefined();
  });

  it.each([
    ['', /must be non-empty/u],
    ['.', /must be non-empty/u],
    ['./', /must be non-empty/u],
    ['.//', /must be non-empty/u],
    ['././', /must be non-empty/u],
    ['/workspace/tasks/a', /must be workspace-relative/u],
    ['tasks/../a', /must not contain parent segments/u],
    ['tasks\\a', /must use POSIX path separators/u],
  ])('rejects invalid cwd %j', (cwd, message) => {
    expect(() => new SandboxWorkspaceScope(cwd)).toThrow(message);
  });

  it('rejects non-string cwd values at runtime', () => {
    expect(() => new SandboxWorkspaceScope(42 as any)).toThrow(
      'sandbox.cwd must be a string.',
    );
  });
});

describe('WorkspacePathPolicy', () => {
  it('resolves workspace-relative and absolute in-root paths', () => {
    const policy = new WorkspacePathPolicy({
      root: '/workspace',
    });

    expect(policy.resolve('src/app.ts')).toMatchObject({
      path: '/workspace/src/app.ts',
      workspaceRelativePath: 'src/app.ts',
    });
    expect(policy.resolve('/workspace/src/../README.md')).toMatchObject({
      path: '/workspace/README.md',
      workspaceRelativePath: 'README.md',
    });
    expect(policy.resolve('src/../README.md')).toMatchObject({
      path: '/workspace/README.md',
      workspaceRelativePath: 'README.md',
    });
    expect(policy.resolve('/workspace')).toMatchObject({
      path: '/workspace',
      workspaceRelativePath: '',
    });
  });

  it('resolves extra path grants and enforces read-only grants', () => {
    const policy = new WorkspacePathPolicy({
      root: '/workspace',
      extraPathGrants: [
        {
          path: '/mnt/data',
          readOnly: true,
        },
        {
          path: '/mnt/data/write',
          readOnly: false,
        },
      ],
    });

    expect(policy.resolve('/mnt/data/input.json')).toMatchObject({
      path: '/mnt/data/input.json',
      grant: {
        path: '/mnt/data',
        readOnly: true,
      },
    });
    expect(() =>
      policy.resolve('/mnt/data/input.json', { forWrite: true }),
    ).toThrow(/read-only extra path grant/);
    expect(
      policy.resolve('/mnt/data/write/output.json', { forWrite: true }),
    ).toMatchObject({
      path: '/mnt/data/write/output.json',
      grant: {
        path: '/mnt/data/write',
        readOnly: false,
      },
    });
  });

  it('rejects absolute paths outside the workspace and grants', () => {
    const policy = new WorkspacePathPolicy({
      root: '/workspace',
      extraPathGrants: [
        {
          path: '/mnt/data',
          readOnly: true,
        },
      ],
    });

    expect(() => policy.resolve('/tmp/secret.txt')).toThrow(
      /escapes the workspace root/,
    );
    expect(() => policy.resolve('/tmp/secret.txt')).toThrow(
      SandboxInvalidManifestPathError,
    );
  });

  it('rejects malformed sandbox paths and roots', () => {
    const policy = new WorkspacePathPolicy({
      root: '/workspace',
    });

    expect(() => policy.resolve('/workspace/..\\secret.txt')).toThrow(
      /must use "\/" separators/i,
    );
    expect(() => policy.resolve('/../secret.txt')).toThrow(
      /must not escape root/i,
    );
    expect(() => policy.resolve('/../secret.txt')).toThrow(
      SandboxInvalidManifestPathError,
    );
    expect(() => policy.resolve('../secret.txt')).toThrow(
      /must not escape root/i,
    );
    expect(() => policy.resolve('src/../../secret.txt')).toThrow(
      /must not escape root/i,
    );
    expect(
      () =>
        new WorkspacePathPolicy({
          root: '/workspace\\nested',
        }),
    ).toThrow(/must use "\/" separators/i);
    expect(
      () =>
        new WorkspacePathPolicy({
          root: 'workspace',
        }),
    ).toThrow(/workspace root must be absolute/i);
    expect(
      () =>
        new WorkspacePathPolicy({
          root: '/workspace/..',
        }),
    ).toThrow(/workspace root must not contain parent segments/i);
    expect(
      () =>
        new WorkspacePathPolicy({
          root: '/workspace',
          extraPathGrants: [{ path: '/mnt/data/..' }],
        }),
    ).toThrow(/path grant path must not contain parent segments/i);
  });
});
