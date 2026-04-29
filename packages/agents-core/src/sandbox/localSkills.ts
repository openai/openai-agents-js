import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  parseSkillFrontmatter,
  type LocalDirLazySkillSource,
  type SkillIndexEntry,
} from './capabilities/skills';
import { localDir } from './entries';

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
    index: discoverLocalDirSkillIndex(options),
  };
}

function discoverLocalDirSkillIndex(
  options: LocalDirLazySkillSourceOptions,
): SkillIndexEntry[] {
  const root = resolve(options.baseDir ?? process.cwd(), options.src);
  if (!isDirectory(root)) {
    return [];
  }

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const skillMarkdownPath = join(root, entry.name, 'SKILL.md');
      if (!isFile(skillMarkdownPath)) {
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
