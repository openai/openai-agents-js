import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const packagesDir = join(repoRoot, 'packages');

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }

  const distDir = join(packagesDir, entry.name, 'dist');
  if (!existsSync(distDir)) {
    continue;
  }

  rmSync(distDir, { force: true, recursive: true });
}
