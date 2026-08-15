import { UserError } from '../errors';
import { SandboxInvalidManifestPathError } from './errors';
import {
  normalizePathGrant,
  type SandboxPathGrant,
  type SandboxPathGrantInit,
} from './pathGrants';
import {
  hasBackslashPathSeparator,
  hasEscapingParentPathSegment,
  hasParentPathSegment,
  isUnderPosixPath,
  normalizePosixPath,
  relativePosixPathWithinRoot,
} from './shared/posixPath';

export type WorkspacePathPolicyOptions = {
  root: string;
  extraPathGrants?: SandboxPathGrantInit[];
};

export type ResolveSandboxPathOptions = {
  forWrite?: boolean;
};

export type ResolvedSandboxPath = {
  path: string;
  workspaceRelativePath?: string;
  grant?: SandboxPathGrant;
};

export class SandboxWorkspaceScope {
  readonly cwd?: string;

  constructor(cwd?: string) {
    this.cwd = cwd === undefined ? undefined : normalizeSandboxCwd(cwd);
  }

  static fromCwd(cwd?: string): SandboxWorkspaceScope {
    return new SandboxWorkspaceScope(cwd);
  }

  anchor(path?: string): string | undefined {
    if (this.cwd === undefined) {
      return path;
    }
    const trimmed = path?.trim() ?? '';
    if (!trimmed) {
      return this.cwd;
    }
    if (trimmed.startsWith('/')) {
      return trimmed;
    }
    return `${this.cwd}/${trimmed}`;
  }

  modelResourcePath(workspaceRoot: string, path: string): string {
    if (this.cwd === undefined) {
      return path;
    }
    const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
    const normalizedPath = normalizeWorkspaceRelativeResourcePath(path);
    return normalizedPath
      ? joinPosixPath(normalizedRoot, normalizedPath)
      : normalizedRoot;
  }

  absoluteCwd(workspaceRoot: string): string | undefined {
    return this.cwd === undefined
      ? undefined
      : this.modelResourcePath(workspaceRoot, this.cwd);
  }
}

export function normalizeSandboxCwd(cwd: string): string {
  if (typeof cwd !== 'string') {
    throw new UserError('sandbox.cwd must be a string.');
  }
  const trimmed = cwd.trim();
  if (!trimmed) {
    throw new UserError('sandbox.cwd must be non-empty.');
  }
  if (hasBackslashPathSeparator(cwd)) {
    throw new UserError('sandbox.cwd must use POSIX path separators.');
  }
  if (trimmed.startsWith('/')) {
    throw new UserError('sandbox.cwd must be workspace-relative.');
  }
  if (hasParentPathSegment(cwd)) {
    throw new UserError('sandbox.cwd must not contain parent segments.');
  }
  const normalized = normalizePosixPath(trimmed);
  if (normalized === '.') {
    throw new UserError('sandbox.cwd must be non-empty.');
  }
  return normalized;
}

export class WorkspacePathPolicy {
  readonly root: string;
  readonly extraPathGrants: SandboxPathGrant[];

  constructor(options: WorkspacePathPolicyOptions) {
    if (hasParentPathSegment(options.root)) {
      throw new UserError(
        'Sandbox workspace root must not contain parent segments.',
      );
    }
    if (hasBackslashPathSeparator(options.root)) {
      throw new UserError(
        `Sandbox path "${options.root}" must use "/" separators.`,
      );
    }
    const root = normalizePosixPath(options.root);
    if (!root.startsWith('/')) {
      throw new UserError('Sandbox workspace root must be absolute.');
    }
    this.root = root;
    this.extraPathGrants = (options.extraPathGrants ?? [])
      .map((grant) => normalizePathGrant(grant))
      .sort((left, right) => right.path.length - left.path.length);
  }

  resolve(
    path?: string,
    options: ResolveSandboxPathOptions = {},
  ): ResolvedSandboxPath {
    const originalPath = path ?? '';
    const trimmed = originalPath.trim();
    const normalizedPath =
      trimmed.length === 0
        ? this.root
        : trimmed.startsWith('/')
          ? normalizeSandboxPath(trimmed, originalPath)
          : joinPosixPath(
              this.root,
              normalizeSandboxPath(trimmed, originalPath),
            );

    const workspaceRelativePath = relativePosixPathWithinRoot(
      this.root,
      normalizedPath,
    );
    if (workspaceRelativePath !== null) {
      return {
        path: normalizedPath,
        workspaceRelativePath,
      };
    }

    const grant = this.matchingGrant(normalizedPath);
    if (grant) {
      if (options.forWrite && grant.readOnly) {
        throw new UserError(
          `Sandbox path "${originalPath}" uses read-only extra path grant "${grant.path}".`,
        );
      }
      return {
        path: normalizedPath,
        grant,
      };
    }

    throw new SandboxInvalidManifestPathError(
      `Sandbox path "${originalPath}" escapes the workspace root.`,
    );
  }

  private matchingGrant(path: string): SandboxPathGrant | undefined {
    return this.extraPathGrants.find((grant) =>
      isUnderPosixPath(path, grant.path),
    );
  }
}

function joinPosixPath(root: string, relativePath: string): string {
  if (!relativePath) {
    return normalizePosixPath(root);
  }
  return normalizePosixPath(`${root.replace(/\/+$/u, '')}/${relativePath}`);
}

function normalizeWorkspaceRoot(root: string): string {
  if (hasBackslashPathSeparator(root)) {
    throw new UserError(
      'Sandbox workspace root must use POSIX path separators.',
    );
  }
  if (hasParentPathSegment(root)) {
    throw new UserError(
      'Sandbox workspace root must not contain parent segments.',
    );
  }
  const normalized = normalizePosixPath(root);
  if (!normalized.startsWith('/')) {
    throw new UserError('Sandbox workspace root must be POSIX absolute.');
  }
  return normalized;
}

function normalizeWorkspaceRelativeResourcePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new UserError('Sandbox resource path must be non-empty.');
  }
  if (hasBackslashPathSeparator(path)) {
    throw new UserError(
      'Sandbox resource path must use POSIX path separators.',
    );
  }
  if (trimmed.startsWith('/')) {
    throw new UserError('Sandbox resource path must be workspace-relative.');
  }
  if (hasParentPathSegment(path)) {
    throw new UserError(
      'Sandbox resource path must not contain parent segments.',
    );
  }
  const normalized = normalizePosixPath(trimmed);
  return normalized === '.' ? '' : normalized;
}

function normalizeSandboxPath(path: string, originalPath: string): string {
  if (hasBackslashPathSeparator(path)) {
    throw new UserError(
      `Sandbox path "${originalPath}" must use "/" separators.`,
    );
  }
  if (hasEscapingParentPathSegment(path)) {
    throw new SandboxInvalidManifestPathError(
      `Sandbox path "${originalPath}" must not escape root.`,
    );
  }
  return normalizePosixPath(path);
}
