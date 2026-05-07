import {
  Manifest,
  SandboxArchiveError,
  SandboxUnsupportedFeatureError,
  type WorkspaceArchiveData,
} from '@openai/agents-core/sandbox';
import { shellQuote, validateRemoteSandboxPathForManifest } from './paths';
import type { RemoteManifestWriter } from './types';

const TAR_BLOCK_SIZE = 512;
const ZERO_BLOCK = new Uint8Array(TAR_BLOCK_SIZE);

export type RemoteWorkspaceTarCommandResult = {
  status: number;
  stdout?: string;
  stderr?: string;
};

export type RemoteWorkspaceTarIo = RemoteManifestWriter & {
  runCommand(command: string): Promise<RemoteWorkspaceTarCommandResult>;
  readFile(path: string): Promise<Uint8Array>;
};

export type WorkspaceTarValidationOptions = {
  allowSymlinks?: boolean;
  allowExternalSymlinkTargets?: boolean;
  rejectSymlinkRelPaths?: Iterable<string>;
  skipRelPaths?: Iterable<string>;
  rootName?: string;
};

export function assertTarWorkspacePersistence(
  providerName: string,
  workspacePersistence: unknown,
): void {
  if (
    workspacePersistence === undefined ||
    workspacePersistence === true ||
    workspacePersistence === 'tar'
  ) {
    return;
  }

  throw new SandboxUnsupportedFeatureError(
    `${providerName} currently supports only tar workspace persistence in TypeScript.`,
    {
      provider: providerName,
      feature: 'workspacePersistence',
      workspacePersistence,
    },
  );
}

export async function persistRemoteWorkspaceTar(args: {
  providerName: string;
  manifest: Manifest;
  io: RemoteWorkspaceTarIo;
  archivePath?: string;
}): Promise<Uint8Array> {
  const root = args.manifest.root;
  const archivePath = args.archivePath ?? remoteArchivePath(args.providerName);
  assertRemoteWorkspaceTarRoot(args.providerName, root, archivePath, 'persist');

  await validateRemoteSandboxPathForManifest({
    manifest: args.manifest,
    path: root,
    options: { forWrite: true },
    runCommand: args.io.runCommand,
  });

  const excludeArgs = workspaceTarExcludeArgs(args.manifest);
  const tarCommand = [
    `mkdir -p -- ${shellQuote(root)}`,
    [
      'tar',
      ...excludeArgs,
      '-C',
      shellQuote(root),
      '-cf',
      shellQuote(archivePath),
      '.',
    ].join(' '),
  ].join(' && ');

  try {
    const result = await args.io.runCommand(tarCommand);
    if (result.status !== 0) {
      throw new SandboxArchiveError(
        `${args.providerName} failed to create a workspace tar archive.`,
        {
          provider: args.providerName,
          root,
          archivePath,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        },
      );
    }

    const archive = await args.io.readFile(archivePath);
    validateWorkspaceTarArchive(archive);
    return archive;
  } catch (error) {
    if (error instanceof SandboxArchiveError) {
      throw error;
    }
    throw new SandboxArchiveError(
      `${args.providerName} failed to persist the workspace archive.`,
      {
        provider: args.providerName,
        root,
        archivePath,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  } finally {
    await args.io
      .runCommand(`rm -f -- ${shellQuote(archivePath)}`)
      .catch(() => {});
  }
}

export async function hydrateRemoteWorkspaceTar(args: {
  providerName: string;
  manifest: Manifest;
  io: RemoteWorkspaceTarIo;
  data: WorkspaceArchiveData;
  archivePath?: string;
}): Promise<void> {
  const root = args.manifest.root;
  const archive = toWorkspaceArchiveBytes(args.data);
  validateWorkspaceTarArchive(archive, { allowSymlinks: false });

  const archivePath = args.archivePath ?? remoteArchivePath(args.providerName);
  assertRemoteWorkspaceTarRoot(args.providerName, root, archivePath, 'hydrate');
  await validateRemoteSandboxPathForManifest({
    manifest: args.manifest,
    path: root,
    options: { forWrite: true },
    runCommand: args.io.runCommand,
  });

  try {
    await args.io.writeFile(archivePath, archive);
    const result = await args.io.runCommand(
      [
        `mkdir -p -- ${shellQuote(root)}`,
        `find ${shellQuote(root)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
        `tar -C ${shellQuote(root)} -xf ${shellQuote(archivePath)}`,
      ].join(' && '),
    );
    if (result.status !== 0) {
      throw new SandboxArchiveError(
        `${args.providerName} failed to hydrate a workspace tar archive.`,
        {
          provider: args.providerName,
          root,
          archivePath,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        },
      );
    }
  } catch (error) {
    if (error instanceof SandboxArchiveError) {
      throw error;
    }
    throw new SandboxArchiveError(
      `${args.providerName} failed to hydrate the workspace archive.`,
      {
        provider: args.providerName,
        root,
        archivePath,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  } finally {
    await args.io
      .runCommand(`rm -f -- ${shellQuote(archivePath)}`)
      .catch(() => {});
  }
}

function assertRemoteWorkspaceTarRoot(
  providerName: string,
  root: string,
  archivePath: string,
  operation: 'hydrate' | 'persist',
): void {
  if (root !== '/') {
    return;
  }

  throw new SandboxArchiveError(
    `${providerName} refuses to ${operation} a workspace tar archive at filesystem root.`,
    {
      provider: providerName,
      root,
      archivePath,
    },
  );
}

export function validateWorkspaceTarArchive(
  data: WorkspaceArchiveData,
  options: WorkspaceTarValidationOptions = {},
): void {
  const bytes = toWorkspaceArchiveBytes(data);
  const membersByPath = new Map<string, TarMember>();
  const symlinkPaths = new Set<string>();
  const members: TarMember[] = [];
  let pendingLongName: string | undefined;
  let pendingPax: Record<string, string> | undefined;

  try {
    for (let offset = 0; offset < bytes.byteLength; ) {
      const header = bytes.subarray(offset, offset + TAR_BLOCK_SIZE);
      if (header.byteLength < TAR_BLOCK_SIZE) {
        throw tarError('<tar>', 'truncated header');
      }
      offset += TAR_BLOCK_SIZE;

      if (blocksEqual(header, ZERO_BLOCK)) {
        break;
      }

      const rawType = header[156] === 0 ? '' : String.fromCharCode(header[156]);
      const size = parseTarOctal(header, 124, 12);
      const payload = bytes.subarray(offset, offset + size);
      if (payload.byteLength !== size) {
        throw tarError('<tar>', 'truncated member payload');
      }
      offset += Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

      if (rawType === 'x') {
        pendingPax = parsePaxPayload(payload);
        continue;
      }
      if (rawType === 'g') {
        continue;
      }
      if (rawType === 'L') {
        pendingLongName = trimTarString(decodeBytes(payload));
        continue;
      }

      const name =
        pendingPax?.path ??
        pendingLongName ??
        joinTarName(
          readTarString(header, 0, 100),
          readTarString(header, 345, 155),
        );
      const linkName = pendingPax?.linkpath ?? readTarString(header, 157, 100);
      pendingPax = undefined;
      pendingLongName = undefined;

      if (
        shouldSkipTarMember(name, {
          skipRelPaths: options.skipRelPaths ?? [],
          rootName: options.rootName,
        })
      ) {
        continue;
      }

      const member = validateTarMember(name, rawType, options, linkName);
      if (!member) {
        continue;
      }

      const previous = membersByPath.get(member.path);
      if (
        previous &&
        !(previous.type === 'directory' && member.type === 'directory')
      ) {
        throw tarError(name, `duplicate archive path: ${member.path}`);
      }
      membersByPath.set(member.path, member);

      if (member.type === 'symlink') {
        symlinkPaths.add(member.path);
      }
      members.push(member);
    }

    // Remote providers often hand this archive to a plain tar extractor, so catch
    // symlink-parent escapes here instead of relying on provider-specific safety flags.
    for (const member of members) {
      for (const parent of parentPaths(member.path)) {
        const parentMember = membersByPath.get(parent);
        if (parentMember && parentMember.type !== 'directory') {
          throw tarError(
            member.rawName,
            `archive path descends through non-directory: ${parent}`,
          );
        }
        if (symlinkPaths.has(parent)) {
          throw tarError(
            member.rawName,
            `archive path descends through symlink: ${parent}`,
          );
        }
      }
    }
  } catch (error) {
    if (error instanceof SandboxArchiveError) {
      throw error;
    }
    throw new SandboxArchiveError('Invalid workspace tar archive.', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function toWorkspaceArchiveBytes(
  data: WorkspaceArchiveData,
): Uint8Array {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return Uint8Array.from(data);
}

export function workspaceTarExcludeArgs(manifest: Manifest): string[] {
  return [...manifest.ephemeralPersistencePaths()]
    .filter((path) => path.length > 0)
    .sort((left, right) => left.localeCompare(right))
    .flatMap((path) => [
      `--exclude=${shellQuote(path)}`,
      `--exclude=${shellQuote(`./${path}`)}`,
    ]);
}

type TarMember = {
  rawName: string;
  path: string;
  type: 'directory' | 'file' | 'symlink';
};

function validateTarMember(
  name: string,
  typeFlag: string,
  options: WorkspaceTarValidationOptions,
  linkName: string,
): TarMember | null {
  const relPath = safeTarMemberRelPath(name);
  if (relPath === null) {
    if (typeFlag === '5') {
      return null;
    }
    if (typeFlag === '2') {
      throw tarError(name, 'archive root symlink');
    }
    if (typeFlag === '1') {
      throw tarError(name, 'archive root hardlink');
    }
    throw tarError(name, 'archive root member must be directory');
  }

  if (typeFlag === '1') {
    throw tarError(name, 'hardlink member not allowed');
  }
  if (typeFlag === '2') {
    if (
      options.allowSymlinks === false ||
      matchesNormalizedPath(relPath, options.rejectSymlinkRelPaths ?? [])
    ) {
      throw tarError(name, `symlink member not allowed: ${relPath}`);
    }
    validateSymlinkTarget(name, relPath, linkName, options);
    return { rawName: name, path: relPath, type: 'symlink' };
  }
  if (typeFlag === '5') {
    return { rawName: name, path: relPath, type: 'directory' };
  }
  if (typeFlag === '' || typeFlag === '0') {
    return { rawName: name, path: relPath, type: 'file' };
  }

  throw tarError(name, 'unsupported member type');
}

function validateSymlinkTarget(
  name: string,
  relPath: string,
  linkName: string,
  options: WorkspaceTarValidationOptions,
): void {
  if (options.allowExternalSymlinkTargets !== false) {
    return;
  }
  if (linkName.startsWith('/')) {
    throw tarError(name, `absolute symlink target not allowed: ${linkName}`);
  }

  const parent = parentPath(relPath);
  if (
    normalizePosixPathWithoutRoot(parent ? `${parent}/${linkName}` : linkName)
  ) {
    return;
  }
  throw tarError(name, `symlink target escapes archive root: ${linkName}`);
}

function safeTarMemberRelPath(name: string): string | null {
  if (name === '' || name === '.' || name === './') {
    return null;
  }
  if (name.startsWith('/')) {
    throw tarError(name, 'absolute path');
  }
  if (/^[A-Za-z]:/u.test(name)) {
    throw tarError(name, 'windows drive path');
  }
  if (name.includes('\\')) {
    throw tarError(name, 'windows path separator');
  }

  const parts = name
    .split('/')
    .filter((part) => part.length > 0 && part !== '.');
  if (parts.length === 0) {
    return null;
  }
  if (parts.includes('..')) {
    throw tarError(name, 'parent traversal');
  }
  return parts.join('/');
}

function shouldSkipTarMember(
  memberName: string,
  options: { skipRelPaths: Iterable<string>; rootName?: string },
): boolean {
  const relPath = safeTarMemberRelPath(memberName);
  if (relPath === null) {
    return false;
  }
  const variants = [relPath];
  const rootName = options.rootName;
  if (rootName && relPath === rootName) {
    variants.push('');
  } else if (rootName && relPath.startsWith(`${rootName}/`)) {
    variants.push(relPath.slice(rootName.length + 1));
  }

  return variants.some((variant) =>
    matchesNormalizedPath(variant, options.skipRelPaths),
  );
}

function matchesNormalizedPath(
  path: string,
  candidates: Iterable<string>,
): boolean {
  return [...candidates].some((candidate) => {
    const normalized = normalizeTarRelPath(candidate);
    return path === normalized || path.startsWith(`${normalized}/`);
  });
}

function normalizeTarRelPath(path: string): string {
  const normalized = safeTarMemberRelPath(path);
  return normalized ?? '';
}

function parentPaths(path: string): string[] {
  const parts = path.split('/');
  const parents: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    parents.push(parts.slice(0, index).join('/'));
  }
  return parents;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function normalizePosixPathWithoutRoot(path: string): string[] | null {
  const normalized: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (normalized.length === 0) {
        return null;
      }
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return normalized;
}

function parsePaxPayload(payload: Uint8Array): Record<string, string> {
  const text = decodeBytes(payload);
  const values: Record<string, string> = {};
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space === -1) {
      break;
    }
    const length = Number(text.slice(offset, space));
    if (!Number.isInteger(length) || length <= 0) {
      break;
    }
    const record = text.slice(space + 1, offset + length);
    const trimmed = record.endsWith('\n') ? record.slice(0, -1) : record;
    const equals = trimmed.indexOf('=');
    if (equals > 0) {
      values[trimmed.slice(0, equals)] = trimmed.slice(equals + 1);
    }
    offset += length;
  }
  return values;
}

function parseTarOctal(
  header: Uint8Array,
  start: number,
  length: number,
): number {
  if ((header[start] & 0x80) !== 0) {
    throw tarError('<tar>', 'base-256 tar sizes are not supported');
  }
  const text = readTarString(header, start, length).trim();
  if (text.length === 0) {
    return 0;
  }
  if (!/^[0-7]+$/u.test(text)) {
    throw tarError('<tar>', 'invalid octal size');
  }
  return Number.parseInt(text, 8);
}

function readTarString(
  bytes: Uint8Array,
  start: number,
  length: number,
): string {
  return trimTarString(decodeBytes(bytes.subarray(start, start + length)));
}

function trimTarString(value: string): string {
  return value.replace(/\0.*$/u, '').replace(/\n$/u, '');
}

function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function joinTarName(name: string, prefix: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

function blocksEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function remoteArchivePath(providerName: string): string {
  const suffix = Math.random().toString(16).slice(2);
  const provider = providerName.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
  return `/tmp/openai-agents-${provider}-${Date.now()}-${suffix}.tar`;
}

function tarError(member: string, reason: string): SandboxArchiveError {
  return new SandboxArchiveError(`Unsafe tar member "${member}": ${reason}`, {
    member,
    reason,
  });
}
