import { Buffer } from 'node:buffer';
import { readlink } from 'node:fs/promises';
import { parse, resolve, sep } from 'node:path';
import { UserError } from '../../errors';
import type {
  NativeSourceDirectory,
  NativeSourceEntry,
} from './localSourceTypes';

export type LocalSourceContent =
  | { type: 'dir'; path: string }
  | { type: 'file'; path: string; content: Uint8Array };

type SourceType = 'local_file' | 'local_dir';
let posixBackend: Promise<typeof import('./localSourcePosix')> | undefined;

function pathChanged(type: SourceType, path: string): UserError {
  return new UserError(
    `${type} entry path changed while materializing: ${path}`,
  );
}

function sourceError(
  error: unknown,
  type: SourceType,
  path: string,
  ancestor = false,
): never {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ELOOP') {
    throw new UserError(
      `${type} entries do not support symbolic link${ancestor ? ' ancestors' : 's'}: ${path}`,
    );
  }
  if (
    code === 'ENOENT' ||
    code === 'ENOTDIR' ||
    code === 'ESTALE' ||
    code === 'EINVAL' ||
    code === 'EISDIR'
  ) {
    throw pathChanged(type, path);
  }
  throw error;
}

async function nativeRoot(
  root: string,
  enumerate: boolean,
): Promise<NativeSourceDirectory> {
  // Load the native dependency only for host source reads. Deno applications
  // using these entries need local node_modules and --allow-ffi.
  if (process.platform === 'win32') {
    const { openWindowsSourceRoot } = await import('./localSourceWindows');
    return openWindowsSourceRoot(root, enumerate);
  }
  if (process.platform === 'linux' && process.arch === 's390x') {
    // Koffi has no s390x ABI. Real Node descriptors can instead retain source
    // authority through trusted, accessible Linux procfs magic links.
    const { openProcfsSourceRoot } = await import('./localSourceProcfs');
    return openProcfsSourceRoot(root);
  }
  let backend: typeof import('./localSourcePosix');
  try {
    // Retain failed initialization too: bundled CommonJS modules must not
    // retry a partially initialized native backend on a later source.
    backend = await (posixBackend ??= import('./localSourcePosix'));
  } catch (nativeError) {
    if (
      process.platform !== 'linux' ||
      process.release.name !== 'node' ||
      process.versions.bun ||
      process.versions.deno
    ) {
      throw nativeError;
    }
    try {
      const { openProcfsSourceRoot } = await import('./localSourceProcfs');
      return await openProcfsSourceRoot(root);
    } catch (procfsError) {
      throw Object.assign(
        new AggregateError(
          [nativeError, procfsError],
          'Linux Node local sources require a compatible native dependency or trusted, accessible /proc/self/fd (procfs)',
        ),
        { code: 'ENOTSUP' },
      );
    }
  }
  // Source access and containment failures must never select another backend.
  return backend.openPosixSourceRoot(root);
}

async function canonicalSourcePath(path: string): Promise<string> {
  if (process.platform !== 'darwin') return path;
  // macOS owns these top-level aliases. Never resolve an arbitrary source
  // ancestor: only accept the fixed OS target, then traverse it without links.
  const first = path.split('/')[1];
  if (!['tmp', 'var', 'etc'].includes(first) || path === `/${first}`) {
    return path;
  }
  try {
    const target = await readlink(`/${first}`);
    if (resolve('/', target) === `/private/${first}`) {
      return `/private${path}`;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EINVAL') return path;
    throw error;
  }
  return path;
}

async function openSourceParent(
  path: string,
  type: SourceType,
): Promise<{ parent: NativeSourceDirectory; name: string }> {
  const canonical = await canonicalSourcePath(resolve(path));
  const root = parse(canonical).root;
  if (process.platform === 'win32' && !/^[A-Za-z]:\\$/u.test(root)) {
    throw new UserError(
      `${type} source must be drive-qualified on Windows: ${path}`,
    );
  }
  const components = canonical.slice(root.length).split(sep).filter(Boolean);
  const name = components.pop() ?? '';
  let parent = await nativeRoot(root, type === 'local_dir' && !name);
  try {
    for (const component of components) {
      let child: NativeSourceDirectory;
      try {
        child = await parent.openDirectory(component);
      } catch (error) {
        sourceError(error, type, path, true);
      }
      await parent.close();
      parent = child;
    }
    return { parent, name };
  } catch (error) {
    await parent.close();
    throw error;
  }
}

export async function readLocalSourceFile(
  path: string,
  maxBytes?: number,
): Promise<Uint8Array> {
  const { parent, name } = await openSourceParent(path, 'local_file');
  try {
    if (!name) throw pathChanged('local_file', path);
    try {
      return await parent.readFile(name, maxBytes);
    } catch (error) {
      sourceError(error, 'local_file', path);
    }
  } finally {
    await parent.close();
  }
}

export async function* readLocalSourceDirectory(
  path: string,
): AsyncGenerator<LocalSourceContent> {
  const directory = await openLocalSourceDirectory(path);
  try {
    for await (const entry of walkLocalSourceDirectoryEntries(directory)) {
      const relative = entry.components.join('/');
      if (entry.type === 'directory') {
        yield { type: 'dir', path: relative };
      } else if (entry.type === 'file') {
        yield {
          type: 'file',
          path: relative,
          content: await readLocalSourceFileAt(directory, entry.components),
        };
      } else {
        throw new UserError(
          `local_dir entries do not support ${entry.type === 'symlink' ? 'symbolic links' : 'this file type'}: ${path}/${relative}`,
        );
      }
    }
  } finally {
    await directory.close();
  }
}

/** The returned directory owns a retained source authority and must be closed. */
export async function openLocalSourceDirectory(
  path: string,
): Promise<NativeSourceDirectory> {
  const { parent, name } = await openSourceParent(path, 'local_dir');
  try {
    if (!name) {
      return bindDirectory(parent, path);
    }
    let directory: NativeSourceDirectory;
    try {
      directory = await parent.openDirectory(name, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
        throw new UserError(`local_dir source must be a directory: ${path}`);
      }
      sourceError(error, 'local_dir', path);
    }
    await parent.close();
    return bindDirectory(directory, path);
  } catch (error) {
    await parent.close();
    throw error;
  }
}

function bindDirectory(
  directory: NativeSourceDirectory,
  path: string,
): NativeSourceDirectory {
  return {
    async openDirectory(name) {
      try {
        return bindDirectory(
          await directory.openDirectory(name, true),
          `${path}/${name}`,
        );
      } catch (error) {
        sourceError(error, 'local_dir', `${path}/${name}`);
      }
    },
    async readFile(name, maxBytes) {
      try {
        return await directory.readFile(name, maxBytes);
      } catch (error) {
        sourceError(error, 'local_dir', `${path}/${name}`);
      }
    },
    async entries(maxEntries) {
      try {
        // Match Node's scandir ordering so bounded materialization queues retain
        // their prior failure/skip behavior on every native backend.
        return (await directory.entries(maxEntries)).sort((left, right) =>
          Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
        );
      } catch (error) {
        sourceError(error, 'local_dir', path);
      }
    },
    close: () => directory.close(),
  };
}

async function withSourceDirectory<T>(
  root: NativeSourceDirectory,
  components: readonly string[],
  operation: (directory: NativeSourceDirectory) => Promise<T>,
): Promise<T> {
  let directory = root;
  try {
    for (const component of components) {
      const child = await directory.openDirectory(component, true);
      if (directory !== root) {
        try {
          await directory.close();
        } catch (error) {
          await child.close().catch(() => {});
          throw error;
        }
      }
      directory = child;
    }
    return await operation(directory);
  } finally {
    if (directory !== root) await directory.close();
  }
}

/** Reacquire one component at a time from the retained root, closing ancestors. */
export async function readLocalSourceFileAt(
  root: NativeSourceDirectory,
  components: readonly string[],
  maxBytes?: number,
): Promise<Uint8Array> {
  if (components.length === 0) {
    throw new UserError('Local source file needs a relative component.');
  }
  return withSourceDirectory(root, components.slice(0, -1), (directory) =>
    directory.readFile(components[components.length - 1], maxBytes),
  );
}

export async function readLocalSourceEntriesAt(
  root: NativeSourceDirectory,
  components: readonly string[],
  maxEntries?: number,
): Promise<NativeSourceEntry[]> {
  return withSourceDirectory(root, components, (directory) =>
    directory.entries(maxEntries),
  );
}

/** Walk with entry lists and relative names, retaining no directory per depth. */
export async function* walkLocalSourceDirectoryEntries(
  root: NativeSourceDirectory,
): AsyncGenerator<{ components: string[]; type: NativeSourceEntry['type'] }> {
  yield { components: [], type: 'directory' };
  const stack = [
    { components: [] as string[], entries: await root.entries(), index: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const entry = frame.entries[frame.index++];
    if (!entry) {
      stack.pop();
      continue;
    }
    const components = [...frame.components, entry.name];
    yield { components, type: entry.type };
    if (entry.type === 'directory') {
      const entries = await readLocalSourceEntriesAt(root, components);
      stack.push({ components, entries, index: 0 });
    }
  }
}
