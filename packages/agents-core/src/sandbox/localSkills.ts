import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openLocalSourceDirectory,
  readLocalSourceFile,
  readLocalSourceFileAt,
  readLocalSourceEntriesAt,
} from './shared/localSourceReader';
import type { Entry, Dir } from './entries';
import {
  parseSkillMetadataPrefix,
  type SkillMetadataLimits,
  type SkillTreeLimits,
  type LocalDirLazySkillSource,
  type SkillIndexEntry,
} from './skillResources';
import { localDir } from './entries';
import { SandboxSkillsConfigError } from './errors';
import type { Manifest } from './manifest';
import type { SandboxPathGrant } from './pathGrants';
import {
  isHostPathWithinRoot,
  sandboxPathGrantHostPath,
} from './shared/hostPath';

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
  function getIndex(manifest: Manifest, skillsPath: string): SkillIndexEntry[];
  function getIndex(
    manifest: Manifest,
    skillsPath: string,
    limits: SkillMetadataLimits,
  ): Promise<SkillIndexEntry[]>;
  function getIndex(
    manifest: Manifest,
    _skillsPath: string,
    limits?: SkillMetadataLimits,
  ): SkillIndexEntry[] | Promise<SkillIndexEntry[]> {
    return limits
      ? discoverBoundedLocalDirSkillIndex(
          options,
          manifest.extraPathGrants,
          limits,
        )
      : discoverLocalDirSkillIndex(options, manifest.extraPathGrants);
  }
  return { source: localDir({ src: sourceRoot }), getIndex };
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
  if (hasLocalSourceSymlinkAncestor(root) || !isDirectory(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(root, entry.name, 'SKILL.md');
      if (!isRegularFileWithoutSymlink(path)) return [];
      let markdown: string;
      try {
        markdown = readFileSync(path, 'utf8');
      } catch {
        return [];
      }
      return skillIndexEntry(entry.name, parseSkillMetadataPrefix(markdown));
    });
}

function skillIndexEntry(
  name: string,
  frontmatter: ReturnType<typeof parseSkillMetadataPrefix>,
): SkillIndexEntry[] {
  return frontmatter
    ? [
        {
          name: frontmatter.name ?? name,
          description: frontmatter.description ?? 'No description provided.',
          path: name,
        },
      ]
    : [];
}

async function discoverBoundedLocalDirSkillIndex(
  options: LocalDirLazySkillSourceOptions,
  sourceGrants: SandboxPathGrant[],
  limits: SkillMetadataLimits,
): Promise<SkillIndexEntry[]> {
  let directory: Awaited<ReturnType<typeof openLocalSourceDirectory>>;
  try {
    directory = await openLocalSourceDirectory(
      resolveLocalSkillSourcePath(
        options.src,
        resolve(options.baseDir ?? process.cwd()),
        sourceGrants,
      ),
    );
  } catch {
    return [];
  }
  try {
    let entries;
    try {
      entries = await readLocalSourceEntriesAt(
        directory,
        [],
        limits.maxEntries,
      );
    } catch (error) {
      if (error instanceof RangeError)
        throw new SandboxSkillsConfigError(
          'Skill metadata directory count exceeds its limit',
          { cause: error },
        );
      throw error;
    }
    let totalBytes = 0;
    const index: SkillIndexEntry[] = [];
    for (const entry of entries
      .filter((item) => item.type === 'directory')
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const readLimit = Math.min(
        limits.maxFileBytes,
        limits.maxTotalBytes - totalBytes,
      );
      let markdown: Uint8Array;
      try {
        markdown = await readLocalSourceFileAt(
          directory,
          [entry.name, 'SKILL.md'],
          readLimit + 1,
          true,
        );
      } catch {
        continue;
      }
      if (readLimit <= 0)
        throw new SandboxSkillsConfigError(
          'Skill metadata reads exceed their total byte limit',
        );
      totalBytes += markdown.byteLength;
      if (totalBytes > limits.maxTotalBytes)
        throw new SandboxSkillsConfigError(
          'Skill metadata reads exceed their total byte limit',
        );
      index.push(
        ...skillIndexEntry(
          entry.name,
          parseSkillMetadataPrefix(markdown, readLimit),
        ),
      );
    }
    return index;
  } finally {
    await directory.close();
  }
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
      isHostPathWithinRoot(
        resolve(sandboxPathGrantHostPath(grant)),
        resolvedSourcePath,
      ),
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

/** Capture only the selected native skill; ordinary resource copying stays unchanged. */
export async function captureSkillEntry(
  entry: Entry,
  limits: SkillTreeLimits,
  sourceGrants: SandboxPathGrant[],
): Promise<Entry> {
  let members = 0;
  let bytes = 0;
  const member = (depth: number) => {
    if (++members > limits.maxMembers)
      throw new SandboxSkillsConfigError('Skill tree member limit exceeded');
    if (depth > limits.maxDepth)
      throw new SandboxSkillsConfigError('Skill tree depth limit exceeded');
  };
  const consume = (content: string | Uint8Array) => {
    const size =
      typeof content === 'string'
        ? Buffer.byteLength(content)
        : content.byteLength;
    if (size > limits.maxBytes - bytes)
      throw new SandboxSkillsConfigError('Skill tree byte limit exceeded');
    bytes += size;
    return typeof content === 'string' ? content : Uint8Array.from(content);
  };
  const sourcePath = (src: string) =>
    resolveLocalSkillSourcePath(
      src.startsWith('file:') ? fileURLToPath(src) : src,
      process.cwd(),
      sourceGrants,
    );
  const visit = async (item: Entry, depth: number): Promise<Entry> => {
    member(depth);
    if (item.type === 'file')
      return { ...item, content: consume(item.content) };
    if (item.type === 'dir') {
      const children: Record<string, Entry> = Object.create(null);
      for (const name in item.children ?? {}) {
        if (!Object.prototype.hasOwnProperty.call(item.children, name))
          continue;
        children[name] = await visit(item.children![name], depth + 1);
      }
      return { ...item, children };
    }
    if (item.type === 'local_file') {
      const content = await readLocalSourceFile(
        sourcePath(item.src),
        limits.maxBytes - bytes,
      );
      const result = {
        ...item,
        type: 'file' as const,
        content: consume(content),
      };
      Reflect.deleteProperty(result, 'src');
      return result;
    }
    if (item.type === 'local_dir') {
      const root = await openLocalSourceDirectory(sourcePath(item.src));
      const walk = async (
        components: string[],
        currentDepth: number,
      ): Promise<Dir> => {
        const children: Record<string, Entry> = Object.create(null);
        const entries = await readLocalSourceEntriesAt(
          root,
          components,
          limits.maxMembers - members,
        );
        for (const child of entries) {
          member(currentDepth + 1);
          const path = [...components, child.name];
          if (child.type === 'directory') {
            children[child.name] = await walk(path, currentDepth + 1);
          } else if (child.type === 'file') {
            const content = await readLocalSourceFileAt(
              root,
              path,
              limits.maxBytes - bytes,
            );
            children[child.name] = { type: 'file', content: consume(content) };
          } else {
            throw new SandboxSkillsConfigError(
              'Skill trees require regular files and directories',
            );
          }
        }
        return { type: 'dir', children };
      };
      try {
        const captured = await walk([], depth);
        const result = { ...item, ...captured };
        Reflect.deleteProperty(result, 'src');
        return result;
      } finally {
        await root.close();
      }
    }
    throw new SandboxSkillsConfigError(
      `Native lazy skill trees do not support bounded ${item.type} materialization yet`,
    );
  };
  try {
    return await visit(entry, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_FS_FILE_TOO_LARGE')
      throw new SandboxSkillsConfigError('Skill tree byte limit exceeded', {
        cause: error,
      });
    if (
      error instanceof RangeError &&
      error.message === 'Local source member limit exceeded'
    )
      throw new SandboxSkillsConfigError('Skill tree member limit exceeded', {
        cause: error,
      });
    throw error;
  }
}
