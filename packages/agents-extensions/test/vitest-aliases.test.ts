import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const packageJson = JSON.parse(
  readFileSync(
    resolve(rootDir, 'packages/agents-extensions/package.json'),
    'utf8',
  ),
) as {
  exports: Record<string, unknown>;
};
const vitestConfig = readFileSync(resolve(rootDir, 'vitest.config.ts'), 'utf8');

describe('Vitest workspace package aliases', () => {
  it('maps agents-extensions public subpaths before the package root alias', () => {
    const rootAlias = '@openai/agents-extensions';
    const rootAliasIndex = vitestConfig.indexOf(`'${rootAlias}': resolve(`);

    expect(rootAliasIndex).toBeGreaterThanOrEqual(0);

    for (const exportPath of Object.keys(packageJson.exports)) {
      if (exportPath === '.') {
        continue;
      }

      const subpath = exportPath.replace(/^\.\//u, '');
      const aliasName = `${rootAlias}/${subpath}`;
      const expectedSource = resolve(
        rootDir,
        'packages/agents-extensions/src',
        subpath,
        'index.ts',
      );
      const aliasIndex = vitestConfig.indexOf(`'${aliasName}': resolve(`);

      expect(aliasIndex).toBeGreaterThanOrEqual(0);
      expect(aliasIndex).toBeLessThan(rootAliasIndex);
      expect(vitestConfig).toContain(
        `'packages/agents-extensions/src/${subpath}/index.ts'`,
      );
      expect(existsSync(expectedSource)).toBe(true);
    }
  });
});
