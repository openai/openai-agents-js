import { cloneManifest, Manifest, type ManifestInput } from './manifest';
import {
  validateMountCredentialBoundaries,
  validateMountEnvironmentCredentialBoundaries,
} from './mountSecurity';
import type { SandboxSessionLike, SandboxSessionState } from './session';
import { isRecord } from './shared/typeGuards';
import type { SnapshotSpec } from './snapshot';
import { UserError } from '../errors';

export type SandboxConcurrencyLimits = {
  manifestEntries?: number;
  localDirFiles?: number;
};

export type SandboxArchiveLimits = {
  maxInputBytes?: number | null;
  maxExtractedBytes?: number | null;
  maxMembers?: number | null;
};

export type ResolvedSandboxArchiveLimits = {
  maxInputBytes: number | null;
  maxExtractedBytes: number | null;
  maxMembers: number | null;
};

export const DEFAULT_SANDBOX_ARCHIVE_LIMITS: ResolvedSandboxArchiveLimits = {
  maxInputBytes: 1024 * 1024 * 1024,
  maxExtractedBytes: 4 * 1024 * 1024 * 1024,
  maxMembers: 100_000,
};

export type SandboxClientOptions = Record<string, unknown>;

export type SandboxClientCreateArgs<
  TOptions extends SandboxClientOptions = SandboxClientOptions,
> = {
  snapshot?: SnapshotSpec;
  manifest?: ManifestInput;
  options?: TOptions;
  concurrencyLimits?: SandboxConcurrencyLimits;
  archiveLimits?: SandboxArchiveLimits | null;
};

export type NormalizedSandboxClientCreateArgs<
  TOptions extends SandboxClientOptions = SandboxClientOptions,
> = {
  snapshot?: SnapshotSpec;
  manifest: Manifest;
  options?: TOptions;
  concurrencyLimits?: SandboxConcurrencyLimits;
  archiveLimits?: SandboxArchiveLimits | null;
};

export type SandboxClientResumeOptions<
  TOptions extends SandboxClientOptions = SandboxClientOptions,
> = {
  archiveLimits?: SandboxArchiveLimits | null;
  clientOptions?: TOptions;
};

export type SandboxSessionResumeValidationInput<
  TSessionState extends SandboxSessionState = SandboxSessionState,
> =
  | {
      source: 'explicit';
      state: TSessionState;
    }
  | {
      source: 'runState';
      state: Record<string, unknown>;
    };

export type SandboxClientCreate<
  TOptions extends SandboxClientOptions = SandboxClientOptions,
  TSessionState extends SandboxSessionState = SandboxSessionState,
> = {
  (
    args?: SandboxClientCreateArgs<TOptions>,
  ): Promise<SandboxSessionLike<TSessionState>>;
  (
    manifest: Manifest,
    options?: TOptions,
  ): Promise<SandboxSessionLike<TSessionState>>;
};

export type SandboxSessionSerializationOptions = {
  preserveOwnedSession?: boolean;
  reuseLiveSession?: boolean;
  /**
   * The runtime will close the owned session after serialization.
   */
  willCloseAfterSerialize?: boolean;
};

export type SandboxPreservedSessionReuseOptions<
  TOptions extends SandboxClientOptions = SandboxClientOptions,
> = {
  clientOptions?: TOptions;
  /**
   * Revalidate the entries materialized when the backend was created before
   * reusing a same-process preserved session.
   */
  revalidateManifestEntries?: boolean;
  trustedManifest?: Manifest;
};

export interface SandboxClient<
  TOptions extends SandboxClientOptions = SandboxClientOptions,
  TSessionState extends SandboxSessionState = SandboxSessionState,
> {
  backendId: string;
  supportsDefaultOptions?: boolean;
  /**
   * Persisted provider state cannot authenticate enough backend authority to
   * reconnect safely, so only a same-process live session may be reused.
   */
  serializedSessionStateRequiresFreshCreation?: boolean;
  create?: SandboxClientCreate<TOptions, TSessionState>;
  delete?(state: TSessionState): Promise<void>;
  serializeSessionState?(
    state: TSessionState,
    options?: SandboxSessionSerializationOptions,
  ): Promise<Record<string, unknown>>;
  canPersistOwnedSessionState?(
    state: TSessionState,
  ): Promise<boolean> | boolean;
  canReusePreservedOwnedSession?(
    state: TSessionState,
    options?: SandboxPreservedSessionReuseOptions<TOptions>,
  ): Promise<boolean> | boolean;
  deserializeSessionState?(
    state: Record<string, unknown>,
  ): Promise<TSessionState>;
  /**
   * Resolves the current trusted manifest to the provider-owned root used by
   * persisted session state before security-sensitive resume validation.
   */
  resolveTrustedManifestForResume?(
    manifest: Manifest,
    options?: TOptions,
  ): Manifest;
  /** Synchronously validates resume policy before environment materialization. */
  validateSessionStateForResume?(
    input: SandboxSessionResumeValidationInput<TSessionState>,
    options?: SandboxClientResumeOptions<TOptions>,
  ): void;
  resume?(
    state: TSessionState,
    options?: SandboxClientResumeOptions<TOptions>,
  ): Promise<SandboxSessionLike<TSessionState>>;
}

export type SandboxRunConfig<
  TOptions extends SandboxClientOptions = SandboxClientOptions,
  TSessionState extends SandboxSessionState = SandboxSessionState,
> = {
  client?: SandboxClient<TOptions, TSessionState>;
  options?: TOptions;
  session?: SandboxSessionLike<TSessionState>;
  sessionState?: TSessionState;
  manifest?: ManifestInput;
  snapshot?: SnapshotSpec;
  concurrencyLimits?: SandboxConcurrencyLimits;
  archiveLimits?: SandboxArchiveLimits | null;
  /**
   * Workspace-relative POSIX working directory for built-in sandbox tools in this run.
   */
  cwd?: string;
};

export function normalizeSandboxClientCreateArgs<
  TOptions extends SandboxClientOptions = SandboxClientOptions,
>(
  args?: SandboxClientCreateArgs<TOptions> | Manifest,
  manifestOptions?: TOptions,
): NormalizedSandboxClientCreateArgs<TOptions> {
  if (args instanceof Manifest) {
    const manifest = cloneManifest(args);
    validateMountCredentialBoundaries(manifest);
    validateMountEnvironmentCredentialBoundaries(manifest, {});
    return {
      manifest,
      options: manifestOptions,
      snapshot: readSnapshotOption(manifestOptions),
      concurrencyLimits: readConcurrencyLimitsOption(manifestOptions),
      archiveLimits: readArchiveLimitsOption(manifestOptions),
    };
  }

  const manifest = args?.manifest;

  const normalizedManifest = manifest
    ? cloneManifest(manifest)
    : new Manifest();
  validateMountCredentialBoundaries(normalizedManifest);
  validateMountEnvironmentCredentialBoundaries(normalizedManifest, {});

  return {
    manifest: normalizedManifest,
    options: args?.options,
    snapshot: args?.snapshot,
    concurrencyLimits: args?.concurrencyLimits,
    archiveLimits: args?.archiveLimits,
  };
}

export function resolveSandboxArchiveLimits(
  limits?: SandboxArchiveLimits | null,
): ResolvedSandboxArchiveLimits | null {
  if (limits == null) {
    return null;
  }
  validateSandboxArchiveLimits(limits);
  return {
    maxInputBytes:
      limits.maxInputBytes === undefined
        ? DEFAULT_SANDBOX_ARCHIVE_LIMITS.maxInputBytes
        : limits.maxInputBytes,
    maxExtractedBytes:
      limits.maxExtractedBytes === undefined
        ? DEFAULT_SANDBOX_ARCHIVE_LIMITS.maxExtractedBytes
        : limits.maxExtractedBytes,
    maxMembers:
      limits.maxMembers === undefined
        ? DEFAULT_SANDBOX_ARCHIVE_LIMITS.maxMembers
        : limits.maxMembers,
  };
}

export function validateSandboxArchiveLimits(
  limits?: SandboxArchiveLimits | null,
): void {
  if (limits == null) {
    return;
  }
  validatePositiveArchiveLimit('maxInputBytes', limits.maxInputBytes);
  validatePositiveArchiveLimit('maxExtractedBytes', limits.maxExtractedBytes);
  validatePositiveArchiveLimit('maxMembers', limits.maxMembers);
}

function validatePositiveArchiveLimit(
  name: keyof SandboxArchiveLimits,
  value: number | null | undefined,
): void {
  if (value == null) {
    return;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new UserError(`archiveLimits.${name} must be at least 1.`);
  }
}

function readSnapshotOption(options: unknown): SnapshotSpec | undefined {
  if (!isRecord(options)) {
    return undefined;
  }
  return options.snapshot as SnapshotSpec | undefined;
}

function readConcurrencyLimitsOption(
  options: unknown,
): SandboxConcurrencyLimits | undefined {
  if (!isRecord(options)) {
    return undefined;
  }
  return options.concurrencyLimits as SandboxConcurrencyLimits | undefined;
}

function readArchiveLimitsOption(
  options: unknown,
): SandboxArchiveLimits | null | undefined {
  if (!isRecord(options)) {
    return undefined;
  }
  return options.archiveLimits as SandboxArchiveLimits | null | undefined;
}
