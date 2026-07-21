import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

type PackageExportTarget =
  | string
  | null
  | PackageExportTarget[]
  | { [condition: string]: PackageExportTarget };

export type WorkspacePackage = {
  name: string;
  root: string;
  exports: Record<string, PackageExportTarget>;
};

type WorkspacePackageJson = {
  name?: string;
  exports?: Record<string, PackageExportTarget>;
};

const NODE_IMPORT_CONDITIONS = [
  'node',
  'import',
  'default',
  'require',
] as const;

function selectNodeImportTarget(
  target: PackageExportTarget,
): string | undefined {
  if (typeof target === 'string') {
    return target;
  }
  if (target === null) {
    return undefined;
  }
  if (Array.isArray(target)) {
    for (const candidate of target) {
      const selected = selectNodeImportTarget(candidate);
      if (selected !== undefined) {
        return selected;
      }
    }
    return undefined;
  }

  for (const condition of NODE_IMPORT_CONDITIONS) {
    if (condition in target) {
      const selected = selectNodeImportTarget(target[condition]);
      if (selected !== undefined) {
        return selected;
      }
    }
  }

  return undefined;
}

function sourcePathForExport(
  workspacePackage: WorkspacePackage,
  exportPath: string,
  target: PackageExportTarget,
): string {
  const distTarget = selectNodeImportTarget(target);
  if (distTarget === undefined) {
    throw new Error(
      `Package export ${workspacePackage.name}${exportPath.slice(1)} has no Node-compatible import target.`,
    );
  }
  if (!distTarget.startsWith('./dist/')) {
    throw new Error(
      `Package export ${workspacePackage.name}${exportPath.slice(1)} does not point into dist: ${distTarget}`,
    );
  }

  const sourceRelativePath = distTarget
    .slice('./dist/'.length)
    .replace(/\.(?:mjs|js)$/u, '.ts');
  const sourcePath = resolve(workspacePackage.root, 'src', sourceRelativePath);
  if (!existsSync(sourcePath)) {
    throw new Error(
      `Package export ${workspacePackage.name}${exportPath.slice(1)} has no source entrypoint at ${sourcePath}.`,
    );
  }

  return sourcePath;
}

export function readWorkspacePackages(packagesDir: string): WorkspacePackage[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const root = resolve(packagesDir, entry.name);
      const packageJsonPath = resolve(root, 'package.json');
      const packageJson = JSON.parse(
        readFileSync(packageJsonPath, 'utf8'),
      ) as WorkspacePackageJson;

      if (!packageJson.name || !packageJson.exports) {
        throw new Error(
          `Workspace package ${entry.name} must define name and exports.`,
        );
      }

      return {
        name: packageJson.name,
        root,
        exports: packageJson.exports,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function createWorkspacePackageAliases(
  workspacePackages: WorkspacePackage[],
): Record<string, string> {
  const aliases = workspacePackages.flatMap((workspacePackage) =>
    Object.entries(workspacePackage.exports).map(([exportPath, target]) => {
      const subpath = exportPath === '.' ? '' : exportPath.slice(1);
      const aliasName = `${workspacePackage.name}${subpath}`;
      return [
        aliasName,
        sourcePathForExport(workspacePackage, exportPath, target),
      ] as const;
    }),
  );

  aliases.sort(
    ([left], [right]) =>
      right.length - left.length || left.localeCompare(right),
  );

  return Object.fromEntries(aliases);
}
