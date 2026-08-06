import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createWorkspacePackageAliases,
  readWorkspacePackages,
  type WorkspacePackage,
} from './workspacePackageAliases';

const rootDir = fileURLToPath(new URL('../..', import.meta.url));
const workspacePackages = readWorkspacePackages(resolve(rootDir, 'packages'));
const aliases = createWorkspacePackageAliases(workspacePackages);

describe('workspace package aliases', () => {
  it('maps every public package export to a source entrypoint', () => {
    const expectedAliases = workspacePackages.flatMap((workspacePackage) =>
      Object.keys(workspacePackage.exports).map((exportPath) => {
        const subpath = exportPath === '.' ? '' : exportPath.slice(1);
        return `${workspacePackage.name}${subpath}`;
      }),
    );

    expect(Object.keys(aliases)).toEqual(
      expect.arrayContaining(expectedAliases),
    );
    expect(Object.keys(aliases)).toHaveLength(expectedAliases.length);
    for (const sourcePath of Object.values(aliases)) {
      const relativePath = relative(resolve(rootDir, 'packages'), sourcePath);
      const pathSegments = relativePath.split(sep);

      expect(relativePath).not.toMatch(/^\.\./u);
      expect(pathSegments).toContain('src');
      expect(pathSegments).not.toContain('dist');
    }
  });

  it('uses Node shims and orders subpaths before package roots', () => {
    expect(aliases['@openai/agents-core/_shims']).toBe(
      resolve(rootDir, 'packages/agents-core/src/shims/shims-node.ts'),
    );
    expect(aliases['@openai/agents-realtime/_shims']).toBe(
      resolve(rootDir, 'packages/agents-realtime/src/shims/shims-node.ts'),
    );

    const aliasNames = Object.keys(aliases);
    for (const workspacePackage of workspacePackages) {
      const rootIndex = aliasNames.indexOf(workspacePackage.name);
      expect(rootIndex).toBeGreaterThanOrEqual(0);
      for (const aliasName of aliasNames) {
        if (aliasName.startsWith(`${workspacePackage.name}/`)) {
          expect(aliasNames.indexOf(aliasName)).toBeLessThan(rootIndex);
        }
      }
    }
  });

  it('fails fast when a published export has no source entrypoint', () => {
    const invalidPackage: WorkspacePackage = {
      name: '@openai/invalid',
      root: resolve(rootDir, 'packages/invalid'),
      exports: {
        '.': {
          import: './dist/index.mjs',
        },
      },
    };

    expect(() => createWorkspacePackageAliases([invalidPackage])).toThrow(
      'has no source entrypoint',
    );
  });
});
