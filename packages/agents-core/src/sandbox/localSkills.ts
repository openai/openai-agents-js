import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readdirSync,
  readFileSync,
  readSync,
  type Dirent,
} from 'node:fs';
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
  return {
    source: localDir({ src: sourceRoot }),
    getIndex: (
      manifest: Manifest,
      _skillsPath: string,
      limits?: SkillMetadataLimits,
    ) => discoverLocalDirSkillIndex(options, manifest.extraPathGrants, limits),
  };
}

function discoverLocalDirSkillIndex(
  options: LocalDirLazySkillSourceOptions,
  sourceGrants: SandboxPathGrant[] = [],
  limits?: SkillMetadataLimits,
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

  let totalBytes = 0;
  return (
    limits
      ? boundedDirectoryEntries(root, limits.maxEntries)
      : readdirSync(root, { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const skillMarkdownPath = join(root, entry.name, 'SKILL.md');
      if (!isRegularFileWithoutSymlink(skillMarkdownPath)) {
        return [];
      }

      const readLimit = limits
        ? Math.min(limits.maxFileBytes, limits.maxTotalBytes - totalBytes)
        : undefined;
      if (readLimit !== undefined && readLimit <= 0)
        throw new SandboxSkillsConfigError(
          'Skill metadata reads exceed their total byte limit',
        );
      let markdown: string | Uint8Array | undefined;
      try {
        markdown =
          readLimit === undefined
            ? readFileSync(skillMarkdownPath, 'utf8')
            : readMetadataPrefix(skillMarkdownPath, readLimit);
      } catch {
        return [];
      }
      if (markdown === undefined) return [];
      if (limits) {
        totalBytes += markdown.length;
        if (totalBytes > limits.maxTotalBytes)
          throw new SandboxSkillsConfigError(
            'Skill metadata reads exceed their total byte limit',
          );
      }
      const frontmatter = parseSkillMetadataPrefix(
        markdown,
        limits?.maxFileBytes,
      );
      return [
        {
          name: frontmatter.name ?? entry.name,
          description: frontmatter.description ?? 'No description provided.',
          path: entry.name,
        },
      ];
    });
}

function boundedDirectoryEntries(root: string, maxEntries: number): Dirent[] {
  const directory = opendirSync(root);
  const entries: Dirent[] = [];
  try {
    for (let entry; (entry = directory.readSync()) !== null;) {
      if (entries.length >= maxEntries)
        throw new SandboxSkillsConfigError(
          'Skill metadata directory count exceeds its limit',
        );
      entries.push(entry);
    }
  } finally {
    directory.closeSync();
  }
  return entries;
}

function readMetadataPrefix(
  path: string,
  maxBytes: number,
): Uint8Array | undefined {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!fstatSync(descriptor).isFile()) return undefined;
    const buffer = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(
        descriptor,
        buffer,
        count,
        buffer.length - count,
        null,
      );
      if (!read) break;
      count += read;
    }
    return buffer.subarray(0, count);
  } finally {
    closeSync(descriptor);
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
