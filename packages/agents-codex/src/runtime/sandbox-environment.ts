import type {
  SandboxClient,
  SandboxArchiveLimits,
  SandboxConcurrencyLimits,
  SnapshotSpec,
  SandboxClientOptions,
  SandboxSessionLike,
  SandboxSessionState,
} from '@openai/agents-core/sandbox';
import {
  cloneManifest,
  Manifest,
  cleanupSandboxSession,
  rebindPersistedMountCredentials,
  rebindPersistedPathGrants,
  assertHostPathGrantsRebound,
  assertMountCredentialsRebound,
} from '@openai/agents-core/sandbox/internal';
import type { Environment } from './environment';
import {
  acquireEnvironment,
  createEnvironmentLease,
  type DisposeGuard,
  type EnvironmentAcquisition,
  type EnvironmentLease,
  type EnvironmentSource,
} from './environment-source';

export interface SandboxEnvironmentOptions<
  Context = any,
  Options extends SandboxClientOptions = SandboxClientOptions,
  State extends SandboxSessionState = SandboxSessionState,
> {
  /** A trusted client; provider ownership and cleanup rules apply. */
  client: SandboxClient<Options, State>;
  /** Application-authorized manifest; validate untrusted data before constructing it. */
  manifest: Manifest;
  /** Trusted provider options: plain data is captured; opaque handles/functions remain caller-owned. */
  options?: Options;
  /** Workspace snapshot used only for resource creation. */
  snapshot?: SnapshotSpec;
  /** Live application-owned session. The adapter only closes its gateway. */
  session?: SandboxSessionLike<State>;
  /**
   * Explicitly authorizes ALL provider identity and snapshot fields for resume.
   * Never pass untrusted persisted state without application/provider validation.
   * The current manifest supplies filesystem authority.
   */
  authorizedResumeState?: { backendId: string; state: State };
  concurrencyLimits?: SandboxConcurrencyLimits;
  archiveLimits?: SandboxArchiveLimits | null;
  /** Connect an authenticated native executor to this exact sandbox. */
  connect(
    sandbox: SandboxSessionLike<State>,
    options: { readonly signal: AbortSignal },
  ): Promise<EnvironmentLease<Context>>;
}

/**
 * Use existing sandbox materialization with native execution. Each opening owns
 * a provider session through create() or explicitly authorized resume(). Live
 * sessions remain application-owned. Providers own validation and credentials.
 */
export function sandboxEnvironment<
  Context = any,
  Options extends SandboxClientOptions = SandboxClientOptions,
  State extends SandboxSessionState = SandboxSessionState,
>(
  options: SandboxEnvironmentOptions<Context, Options, State>,
): EnvironmentSource<Context> {
  const { client, connect } = options;
  const create = client.create?.bind(client);
  const borrowed = options.session;
  const resume = options.authorizedResumeState;
  if (
    [borrowed, resume, options.snapshot].filter((value) => value !== undefined)
      .length > 1
  )
    throw new TypeError(
      'session, authorizedResumeState and snapshot are mutually exclusive',
    );
  if (!borrowed && !resume && !create)
    throw new TypeError('sandboxEnvironment requires SandboxClient.create()');
  if (resume && (resume.backendId !== client.backendId || !client.resume))
    throw new TypeError(
      'authorized resume requires a matching backend and client.resume()',
    );
  if (
    borrowed &&
    (options.concurrencyLimits !== undefined ||
      options.archiveLimits !== undefined)
  )
    throw new TypeError(
      'configure borrowed session budgets before supplying the session',
    );
  const deleteResource = client.delete?.bind(client);
  const providerOptions =
    options.options === undefined ? undefined : captureOptions(options.options);
  const capturedManifest = cloneManifest(requireManifest(options.manifest));
  const manifest =
    resume && client.resolveTrustedManifestForResume
      ? client.resolveTrustedManifestForResume(
          capturedManifest,
          providerOptions,
        )
      : capturedManifest;
  if (resume && options.concurrencyLimits !== undefined)
    throw new TypeError('concurrencyLimits applies only to resource creation');
  const concurrencyLimits = captureOptions(options.concurrencyLimits);
  const archiveLimits = captureOptions(options.archiveLimits);
  const snapshot = captureOptions(options.snapshot);
  // Explicit authorization covers provider identity. Current config is the sole
  // source of mount/path authority, using the provider's existing rebind rules.
  const resumeState = resume
    ? rebindPersistedPathGrants(
        rebindPersistedMountCredentials(captureOptions(resume.state), manifest),
        manifest,
        { replaceWithTrustedManifest: true },
      )
    : undefined;
  if (resumeState) {
    assertMountCredentialsRebound(resumeState);
    assertHostPathGrantsRebound(resumeState);
  }
  for (const { entry } of manifest.mountTargets()) {
    if (!entry.mountStrategy)
      throw new TypeError(
        'sandboxEnvironment mounts require an explicit mountStrategy',
      );
  }

  return async ({ signal }) => {
    signal.throwIfAborted();
    let sandbox: SandboxSessionLike<State> | undefined;
    let gateway: EnvironmentAcquisition | undefined;
    let disposal: Promise<void> | undefined;
    const dispose = (guard?: DisposeGuard) =>
      (disposal ??= Promise.resolve().then(async () => {
        const errors: unknown[] = [];
        for (const release of [
          // The gateway restores its own scope before reinstalling this guard.
          () => gateway?.dispose(guard),
          () =>
            !borrowed &&
            sandbox &&
            cleanupSandboxSession(sandbox, { preserveOwnedSessions: false }),
          () => !borrowed && sandbox && deleteResource?.(sandbox.state),
        ]) {
          try {
            await release();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length)
          throw new AggregateError(
            errors,
            'Sandbox Environment cleanup failed',
          );
      }));
    try {
      // Providers prepare and mount through their existing create pipeline.
      const currentOptions =
        providerOptions === undefined
          ? undefined
          : captureOptions(providerOptions);
      if (resumeState) {
        const state = captureOptions(resumeState);
        const resumeOptions = {
          clientOptions: currentOptions,
          trustedManifest: cloneManifest(manifest),
          archiveLimits,
        };
        client.validateSessionStateForResume?.(
          { source: 'explicit', state },
          resumeOptions,
        );
        if (
          client.serializedSessionStateRequiresFreshCreation ||
          (await client.serializedSessionStateRequiresFreshCreationForOptions?.(
            state,
            resumeOptions,
          ))
        )
          throw new TypeError(
            'provider requires fresh resource creation for this resume state',
          );
        sandbox = await client.resume!(state, resumeOptions);
      } else {
        sandbox =
          borrowed ??
          (await create!({
            manifest: cloneManifest(manifest),
            options: currentOptions,
            snapshot,
            concurrencyLimits,
            archiveLimits,
          }));
      }
      if (
        !borrowed &&
        !sandbox.close &&
        !sandbox.stop &&
        !sandbox.shutdown &&
        !sandbox.delete &&
        !deleteResource
      )
        throw new TypeError(
          'sandboxEnvironment requires a sandbox cleanup route',
        );
      signal.throwIfAborted();
      if (!borrowed && archiveLimits !== undefined)
        sandbox.setArchiveLimits?.(archiveLimits);
      if (!borrowed && sandbox.start && !(await sandbox.running?.())) {
        signal.throwIfAborted();
        await sandbox.start({ reason: 'native session opening' });
      }
      signal.throwIfAborted();
      const created = sandbox;
      gateway = await acquireEnvironment(
        ({ signal }) => connect(created, { signal }),
        signal,
      );
      gateway.opened();
      signal.throwIfAborted();
      return createEnvironmentLease(
        gateway.environment! as Environment<Context>,
        dispose,
        gateway.signal,
      );
    } catch (error) {
      try {
        await dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Sandbox Environment opening and cleanup failed',
          { cause: error },
        );
      }
      throw error;
    }
  };
}

/** Render only paths, access and caller descriptions, never provider config or environment values. */
export function renderStorageLayout(input: Manifest): string {
  const manifest = requireManifest(input);
  const storage = manifest.mountTargets().map(({ mountPath, entry }) => {
    const readOnly =
      entry.mountStrategy?.type === 'blaxel_drive'
        ? (entry.driveReadOnly ?? entry.readOnly)
        : entry.readOnly;
    return {
      path: mountPath,
      access: readOnly === false ? 'read_write' : 'read_only',
      ...(entry.description === undefined
        ? {}
        : { description: entry.description }),
    };
  });
  return JSON.stringify({ workspace: manifest.root, storage }, null, 2);
}

function requireManifest(value: Manifest): Manifest {
  if (!(value instanceof Manifest)) {
    throw new TypeError('manifest must be a trusted Manifest instance');
  }
  return value;
}

// Copy configuration containers without cloning provider SDK handles or callbacks.
function captureOptions<T>(value: T, seen = new WeakMap<object, object>()): T {
  if (value === null || typeof value !== 'object') return value;
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  )
    return value;
  const previous = seen.get(value);
  if (previous) return previous as T;
  const captured = Array.isArray(value) ? [] : Object.create(prototype);
  seen.set(value, captured);
  for (const key of Object.keys(value)) {
    Object.defineProperty(captured, key, {
      value: captureOptions((value as Record<string, unknown>)[key], seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return captured as T;
}
