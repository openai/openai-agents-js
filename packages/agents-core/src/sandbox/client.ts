import { cloneManifest, Manifest, type ManifestInput } from './manifest';
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

export type SandboxClientResumeOptions = {
  archiveLimits?: SandboxArchiveLimits | null;
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

export interface SandboxClient<
  TOptions extends SandboxClientOptions = SandboxClientOptions,
  TSessionState extends SandboxSessionState = SandboxSessionState,
> {
  backendId: string;
  supportsDefaultOptions?: boolean;
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
  ): Promise<boolean> | boolean;
  deserializeSessionState?(
    state: Record<string, unknown>,
  ): Promise<TSessionState>;
  resume?(
    state: TSessionState,
    options?: SandboxClientResumeOptions,
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
};

export function normalizeSandboxClientCreateArgs<
  TOptions extends SandboxClientOptions = SandboxClientOptions,
>(
  args?: SandboxClientCreateArgs<TOptions> | Manifest,
  manifestOptions?: TOptions,
): NormalizedSandboxClientCreateArgs<TOptions> {
  if (args instanceof Manifest) {
    return {
      manifest: args,
      options: manifestOptions,
      snapshot: readSnapshotOption(manifestOptions),
      concurrencyLimits: readConcurrencyLimitsOption(manifestOptions),
      archiveLimits: readArchiveLimitsOption(manifestOptions),
    };
  }

  const manifest = args?.manifest;

  return {
    manifest: manifest
      ? manifest instanceof Manifest
        ? manifest
        : cloneManifest(manifest)
      : new Manifest(),
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
