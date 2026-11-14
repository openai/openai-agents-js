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
  it('maps public code to sources and portable control assets to native products', () => {
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
      if (
        sourcePath.endsWith('.wasm') ||
        sourcePath.endsWith('codex-realtime-control.mjs') ||
        sourcePath.endsWith('codex-turn-control.mjs')
      ) {
        expect(relativePath.split(sep).join('/')).toMatch(
          /^agents(?:-codex)?\/native\/codex-(?:realtime-control\.(?:wasm|mjs)|turn-control\.(?:wasm|mjs))$/u,
        );
      } else {
        expect(pathSegments).toContain('src');
      }
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

  it('maps the MCP tasks runtime wrapper to its TypeScript entrypoint', () => {
    const aliases = createWorkspacePackageAliases([
      {
        name: '@openai/agents-codex',
        root: resolve(rootDir, 'packages/agents-codex'),
        exports: {
          './experimental/mcp-tasks': {
            import: {
              types: './dist/experimental/mcp-tasks/index.d.mts',
              default: './experimental/mcp-tasks.mjs',
            },
          },
        },
      },
    ]);
    expect(aliases['@openai/agents-codex/experimental/mcp-tasks']).toBe(
      resolve(
        rootDir,
        'packages/agents-codex/src/experimental/mcp-tasks/index.ts',
      ),
    );
  });

  it('maps owner and facade A2A exports to their source entrypoints', () => {
    expect(aliases['@openai/agents-codex/a2a']).toBe(
      resolve(rootDir, 'packages/agents-codex/src/a2a/index.ts'),
    );
    expect(aliases['@openai/agents/a2a']).toBe(
      resolve(rootDir, 'packages/agents/src/a2a/index.ts'),
    );
  });

  it('maps the owner and facade portable control assets without a JS replacement', () => {
    for (const name of ['agents', 'agents-codex']) {
      expect(aliases[`@openai/${name}/voice/control.wasm`]).toBe(
        resolve(rootDir, `packages/${name}/native/codex-realtime-control.wasm`),
      );
      expect(aliases[`@openai/${name}/worker/control.wasm`]).toBe(
        resolve(rootDir, `packages/${name}/native/codex-turn-control.wasm`),
      );
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
