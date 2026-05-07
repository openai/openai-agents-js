import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  parseSkillFrontmatter,
  type LocalDirLazySkillSource,
  type SkillIndexEntry,
} from './capabilities/skills';
import { localDir } from './entries';
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
  /**
   * Allow reading skill metadata and materializing skills outside the local source base directory.
   */
  allowOutsideBaseDir?: boolean;
};

export function localDirLazySkillSource(
  srcOrOptions: string | LocalDirLazySkillSourceOptions,
): LocalDirLazySkillSource {
  const options =
    typeof srcOrOptions === 'string' ? { src: srcOrOptions } : srcOrOptions;
  const sourceRoot = resolve(options.baseDir ?? process.cwd(), options.src);
  return {
    source: localDir({
      src: sourceRoot,
      ...(options.allowOutsideBaseDir ? { allowOutsideBaseDir: true } : {}),
    }),
    index: discoverLocalDirSkillIndex(options),
  };
}

function discoverLocalDirSkillIndex(
  options: LocalDirLazySkillSourceOptions,
): SkillIndexEntry[] {
  const base = resolve(options.baseDir ?? process.cwd());
  const root = resolve(base, options.src);
  if (
    !options.allowOutsideBaseDir &&
    (!isHostPathWithinRoot(base, root) ||
      !isResolvedLocalSourceWithinBase(base, root))
  ) {
    return [];
  }
  if (!isDirectory(root)) {
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

function isResolvedLocalSourceWithinBase(base: string, root: string): boolean {
  try {
    return isHostPathWithinRoot(realpathSync(base), realpathSync(root));
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFileWithoutSymlink(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}
