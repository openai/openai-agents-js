import type { SandboxSkillLease } from './sandbox-skills';
import type {
  SandboxMemoryOwner,
  SandboxMemoryTerminal,
} from './sandbox-memory';
import type { CanonicalHistorySnapshot } from './history';
import type { ManagedWorkspaceBinding } from './managed-workspace';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { Environment } from './environment';

const leaseBrand: unique symbol = Symbol('EnvironmentLease');

/** One application resource scope, created inside the source by Environment.lease(). */
export interface EnvironmentLease<Context = any> extends AsyncDisposable {
  readonly [leaseBrand]: true;
  readonly environment: Environment<Context>;
  /** Dispose an unclaimed lease. A Session owns disposal after claiming it. */
  close(): Promise<void>;
}

/**
 * Acquire a fresh lease per opening; roll back partial acquisition before rejecting.
 * The signal cancels acquisition until handoff. After returning the lease, keep
 * its resource alive until the captured disposer runs after native retirement.
 */
export type EnvironmentSource<Context = any> = (options: {
  readonly signal: AbortSignal;
}) => Promise<EnvironmentLease<Context>>;

export type DisposeGuard = (
  dispose: () => void | Promise<void>,
) => Promise<void>;
type SandboxOperationObserver = (message: Record<string, unknown>) => void;

interface LeaseState {
  claimed: boolean;
  readonly managedWorkspace?: ManagedWorkspaceBinding;
  readonly workspaceInstructions?: string;
  readonly sandboxMemory?: SandboxMemoryOwner;
  readonly observeSandboxOperation?: SandboxOperationObserver;
  readonly skillLease?: SandboxSkillLease;
  readonly signal?: AbortSignal;
  readonly scope: ReturnType<typeof AsyncLocalStorage.snapshot>;
  readonly dispose: (guard: DisposeGuard) => void | Promise<void>;
  disposal?: Promise<void>;
}
const leases = new WeakMap<EnvironmentLease, LeaseState>();

/**
 * @internal Called synchronously inside the acquired resource scope. Internal
 * composed disposers forward the guard when releasing a nested acquisition.
 */
export function createEnvironmentLease<Context>(
  environment: Environment<Context>,
  dispose: (guard: DisposeGuard) => void | Promise<void>,
  sourceSignal?: AbortSignal,
  managedWorkspace?: ManagedWorkspaceBinding,
  workspaceInstructions?: string,
  observeSandboxOperation?: SandboxOperationObserver,
  skillLease?: SandboxSkillLease,
  sandboxMemory?: SandboxMemoryOwner,
): EnvironmentLease<Context> {
  if (!(environment instanceof Environment))
    throw new TypeError('Environment.lease requires an Environment');
  const state: LeaseState = {
    claimed: false,
    scope: AsyncLocalStorage.snapshot(),
    dispose,
    signal: sourceSignal,
    managedWorkspace,
    workspaceInstructions,
    sandboxMemory,
    observeSandboxOperation,
    skillLease,
  };
  const close = () => {
    if (state.claimed)
      return Promise.reject(
        new Error('The Session owns this Environment lease'),
      );
    return disposeLease(state, async (callback) => {
      await callback();
    });
  };
  const lease: EnvironmentLease<Context> = Object.freeze({
    [leaseBrand]: true as const,
    environment,
    close,
    [Symbol.asyncDispose]: close,
  });
  leases.set(lease, state);
  return lease;
}

function disposeLease(state: LeaseState, guard: DisposeGuard): Promise<void> {
  // Restore the resource stores first. The Session guard must be installed inside
  // that scope because snapshot() also restores any captured callback guard.
  return (state.disposal ??= Promise.resolve().then(() =>
    state.scope(() => guard(() => state.dispose(guard))),
  ));
}

/** @internal One current opening owns this source until joined Session retirement. */
export class EnvironmentAcquisition {
  readonly signal: AbortSignal;
  #detachCaller: () => void;
  #detachSession?: () => void;
  #disposal?: Promise<void>;

  constructor(
    readonly environment: Environment | undefined,
    openingController: AbortController,
    detachCaller: () => void,
    private readonly state?: LeaseState,
  ) {
    this.#detachCaller = detachCaller;
    this.signal = state?.signal
      ? AbortSignal.any([openingController.signal, state.signal])
      : openingController.signal;
  }

  /** @internal Mutable capture state belongs to this exact acquired resource. */
  get managedWorkspace(): ManagedWorkspaceBinding | undefined {
    return this.state?.managedWorkspace;
  }

  /** @internal Immutable current resource text from this exact acquisition. */
  get workspaceInstructions(): string | undefined {
    return this.state?.workspaceInstructions;
  }

  /** @internal The exact provider lease supplies the sink namespace. */
  get observeSandboxOperation(): SandboxOperationObserver | undefined {
    return this.state?.observeSandboxOperation;
  }

  /** @internal Current resource authority, carried by this exact acquisition. */
  get skillLease(): SandboxSkillLease | undefined {
    return this.state?.skillLease;
  }

  /** @internal Fresh declaration presence; never restored from checkpoint data. */
  get hasSandboxMemory(): boolean {
    return this.state?.sandboxMemory !== undefined;
  }

  /** @internal Keep all resource IO inside the exact acquisition's scope. */
  flushMemory(
    thread: string,
    snapshot: CanonicalHistorySnapshot,
    terminal: SandboxMemoryTerminal,
  ): Promise<void> {
    const owner = this.state?.sandboxMemory;
    if (!owner || !this.state)
      throw new TypeError('This Environment has no native sandbox memory');
    return this.state.scope(() => owner.flush(thread, snapshot, terminal));
  }

  /** @internal Guard active phase callbacks across Sessions sharing this resource. */
  checkMemoryOperation(operation: string): void {
    this.state?.sandboxMemory?.checkOperation(operation);
  }

  /** @internal Session close cancels generation before joining its mutation. */
  cancelMemory(): void {
    this.state?.sandboxMemory?.cancel();
  }

  attachSession(session: { close(): Promise<void> }): void {
    const retire = AsyncResource.bind(() => {
      // Session.close owns and joins retirement; its observers report failures.
      void session.close().catch(() => {});
    });
    this.signal.addEventListener('abort', retire, { once: true });
    this.#detachSession = () =>
      this.signal.removeEventListener('abort', retire);
    if (this.signal.aborted) retire();
  }

  opened(): void {
    this.signal.throwIfAborted();
    // A Session opening signal ends at publication. The source's own signal
    // remains connected until retirement. Agent.run retains its caller separately.
    this.#detachCaller();
  }

  dispose(
    guard: DisposeGuard = async (callback) => {
      await callback();
    },
  ): Promise<void> {
    return (this.#disposal ??= Promise.resolve().then(async () => {
      this.#detachCaller();
      this.#detachSession?.();
      if (this.state) await disposeLease(this.state, guard);
    }));
  }
}

/** @internal Isolate source context changes and join late results after cancellation. */
export async function acquireEnvironment(
  source: Environment | EnvironmentSource | undefined,
  callerSignal?: AbortSignal,
): Promise<EnvironmentAcquisition> {
  callerSignal?.throwIfAborted();
  const controller = new AbortController();
  const acquisitionController = new AbortController();
  let handedOff = false;
  const abort = () => {
    controller.abort(callerSignal!.reason);
    if (!handedOff) acquisitionController.abort(callerSignal!.reason);
  };
  callerSignal?.addEventListener('abort', abort, { once: true });
  const detachCaller = () => callerSignal?.removeEventListener('abort', abort);
  let owner: EnvironmentAcquisition | undefined;
  try {
    if (source === undefined || source instanceof Environment) {
      owner = new EnvironmentAcquisition(source, controller, detachCaller);
    } else {
      const resource = new AsyncResource('AgentsEnvironmentSource');
      let lease: EnvironmentLease;
      try {
        lease = await resource.runInAsyncScope(() =>
          source({ signal: acquisitionController.signal }),
        );
      } finally {
        resource.emitDestroy();
      }
      const state = leases.get(lease);
      if (!state)
        throw new TypeError(
          'Environment sources must return Environment.lease()',
        );
      if (state.claimed || state.disposal)
        throw new TypeError(
          'Environment lease has already been claimed or disposed',
        );
      state.claimed = true;
      handedOff = true;
      owner = new EnvironmentAcquisition(
        lease.environment,
        controller,
        detachCaller,
        state,
      );
    }
    owner.signal.throwIfAborted();
    return owner;
  } catch (error) {
    detachCaller();
    if (owner) {
      try {
        await owner.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Environment acquisition and cleanup failed',
          { cause: error },
        );
      }
    }
    throw error;
  }
}

/** @internal Native transport is already retired; finish both application owners. */
export async function releaseEnvironmentBeforeProvider(
  owner: EnvironmentAcquisition | undefined,
  releaseProvider: () => Promise<void>,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await owner?.dispose();
  } catch (error) {
    errors.push(error);
  }
  try {
    await releaseProvider();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(
      errors,
      'Environment and provider cleanup failed',
      { cause: errors[0] },
    );
}
