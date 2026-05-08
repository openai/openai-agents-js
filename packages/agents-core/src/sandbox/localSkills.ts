import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  parseSkillFrontmatter,
  type LocalDirLazySkillSource,
  type SkillIndexEntry,
} from './capabilities/skills';
import { localDir } from './entries';
import type { Manifest } from './manifest';
import type { SandboxPathGrant } from './pathGrants';
import { isHostPathWithinRoot } from './shared/hostPath';

export type LocalDirLazySkillSourceOptions = {
  /**
   * Local directory containing one child directory per skill.
   */
  src: string;
  /**
   * Base directory used to resolve relative src paths when discovering SKILL.md metadata.
   * Defaults to the current working directory.
   */
  baseDir?: string;
};

export function localDirLazySkillSource(
  srcOrOptions: string | LocalDirLazySkillSourceOptions,
): LocalDirLazySkillSource {
  const options =
    typeof srcOrOptions === 'string' ? { src: srcOrOptions } : srcOrOptions;
  const sourceRoot = resolve(options.baseDir ?? process.cwd(), options.src);
  return {
    source: localDir({ src: sourceRoot }),
    getIndex: (manifest: Manifest) =>
      discoverLocalDirSkillIndex(options, manifest.extraPathGrants),
  };
}

function discoverLocalDirSkillIndex(
  options: LocalDirLazySkillSourceOptions,
  sourceGrants: SandboxPathGrant[] = [],
): SkillIndexEntry[] {
  const base = resolve(options.baseDir ?? process.cwd());
  let root: string;
  try {
    root = resolveLocalSkillSourcePath(options.src, base, sourceGrants);
  } catch {
    return [];
  }
  if (hasLocalSourceSymlinkAncestor(root) || !isDirectory(root)) {
    return [];
  }

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const skillMarkdownPath = join(root, entry.name, 'SKILL.md');
      if (!isRegularFileWithoutSymlink(skillMarkdownPath)) {
        return [];
      }

      let markdown: string;
      try {
        markdown = readFileSync(skillMarkdownPath, 'utf8');
      } catch {
        return [];
      }

      const frontmatter = parseSkillFrontmatter(markdown);
      return [
        {
          name: frontmatter.name ?? entry.name,
          description: frontmatter.description ?? 'No description provided.',
          path: entry.name,
        },
      ];
    });
}

function resolveLocalSkillSourcePath(
  sourcePath: string,
  base: string,
  sourceGrants: SandboxPathGrant[],
): string {
  const resolvedSourcePath = resolve(base, sourcePath);
  if (
    isHostPathWithinRoot(base, resolvedSourcePath) ||
    sourceGrants.some((grant) =>
      isHostPathWithinRoot(resolve(grant.path), resolvedSourcePath),
    )
  ) {
    return resolvedSourcePath;
  }
  throw new Error('local skill source is outside base directory');
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasLocalSourceSymlinkAncestor(path: string): boolean {
  const resolvedPath = resolve(path);
  let current = dirname(resolvedPath);

  while (current !== dirname(current)) {
    const parent = dirname(current);
    if (parent === dirname(parent)) {
      break;
    }
    try {
      if (lstatSync(current).isSymbolicLink()) {
        return true;
      }
    } catch {
      return false;
    }
    current = parent;
  }
  return false;
}

function isRegularFileWithoutSymlink(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}
