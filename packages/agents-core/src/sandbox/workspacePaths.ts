import { UserError } from '../errors';
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

    throw new UserError(
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

function normalizeSandboxPath(path: string, originalPath: string): string {
  if (hasBackslashPathSeparator(path)) {
    throw new UserError(
      `Sandbox path "${originalPath}" must use "/" separators.`,
    );
  }
  if (hasEscapingParentPathSegment(path)) {
    throw new UserError(`Sandbox path "${originalPath}" must not escape root.`);
  }
  return normalizePosixPath(path);
}
