import { Manifest } from './manifest';
import type { SandboxSessionLike, SandboxSessionState } from './session';
import { isRecord } from './shared/typeGuards';
import type { SnapshotSpec } from './snapshot';

export type SandboxConcurrencyLimits = {
  manifestEntries?: number;
  localDirFiles?: number;
};

export type SandboxClientOptions = Record<string, unknown>;

export type SandboxClientCreateArgs<
  TOptions extends SandboxClientOptions = SandboxClientOptions,
> = {
  snapshot?: SnapshotSpec;
  manifest?: Manifest;
  options?: TOptions;
  concurrencyLimits?: SandboxConcurrencyLimits;
};

export type NormalizedSandboxClientCreateArgs<
  TOptions extends SandboxClientOptions = SandboxClientOptions,
> = {
  snapshot?: SnapshotSpec;
  manifest: Manifest;
  options?: TOptions;
  concurrencyLimits?: SandboxConcurrencyLimits;
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
  resume?(state: TSessionState): Promise<SandboxSessionLike<TSessionState>>;
}

export type SandboxRunConfig<
  TOptions extends SandboxClientOptions = SandboxClientOptions,
  TSessionState extends SandboxSessionState = SandboxSessionState,
> = {
  client?: SandboxClient<TOptions, TSessionState>;
  options?: TOptions;
  session?: SandboxSessionLike<TSessionState>;
  sessionState?: TSessionState;
  manifest?: Manifest;
  snapshot?: SnapshotSpec;
  concurrencyLimits?: SandboxConcurrencyLimits;
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
    };
  }

  return {
    manifest: args?.manifest ?? new Manifest(),
    options: args?.options,
    snapshot: args?.snapshot,
    concurrencyLimits: args?.concurrencyLimits,
  };
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
