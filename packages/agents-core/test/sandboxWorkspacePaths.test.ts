import { describe, expect, it } from 'vitest';
import { WorkspacePathPolicy } from '../src/sandbox';

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
