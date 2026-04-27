import type {
  SandboxPreStopHook,
  SandboxSessionLifecycleOptions,
  SandboxSessionLike,
  SandboxSessionState,
} from '../session';

type ManagedHookState = {
  hooks: Set<SandboxPreStopHook>;
  ran: boolean;
  installed: boolean;
  unregisterProviderHook?: () => void;
};

const managedHookStateBySession = new WeakMap<
  SandboxSessionLike<SandboxSessionState>,
  ManagedHookState
>();

export function registerSandboxPreStopHook(
  session: SandboxSessionLike<SandboxSessionState>,
  hook: SandboxPreStopHook,
): () => void {
  const state = getManagedHookState(session);
  state.hooks.add(hook);
  state.ran = false;

  if (session.registerPreStopHook) {
    registerProviderManagedPreStopHook(session, state);
    return () => {
      unregisterManagedHook(state, hook);
    };
  }

  installManagedPreStopHooks(session, state);
  return () => {
    unregisterManagedHook(state, hook);
  };
}

export function hasSessionCleanup(
  session: SandboxSessionLike<SandboxSessionState>,
): boolean {
  return Boolean(
    session.runPreStopHooks ||
    hasManagedPreStopHooks(session) ||
    session.preStop ||
    session.stop ||
    session.shutdown ||
    session.delete ||
    session.close,
  );
}

export async function runSandboxSessionPreStopHooks(
  session: SandboxSessionLike<SandboxSessionState>,
): Promise<void> {
  await runManagedPreStopHooksForSession(session);
  await session.runPreStopHooks?.();
}

export async function runSandboxSessionPreStop(
  session: SandboxSessionLike<SandboxSessionState>,
): Promise<void> {
  let preStopError: unknown;
  const runPreStop = async (preStop: () => Promise<void>) => {
    try {
      await preStop();
    } catch (error) {
      preStopError ??= error;
    }
  };

  if (session.runPreStopHooks || hasManagedPreStopHooks(session)) {
    await runPreStop(async () => {
      await runSandboxSessionPreStopHooks(session);
    });
  }
  if (session.preStop) {
    await runPreStop(async () => {
      await session.preStop!({ reason: 'cleanup' });
    });
  }
  if (preStopError) {
    throw preStopError;
  }
}

export async function cleanupSandboxSession(
  session: SandboxSessionLike<SandboxSessionState>,
): Promise<void> {
  let cleanupError: unknown;
  let usedStandardLifecycle = false;
  const runCleanup = async (cleanup: () => Promise<void>) => {
    try {
      await cleanup();
    } catch (error) {
      cleanupError ??= error;
    }
  };
  if (
    session.runPreStopHooks ||
    hasManagedPreStopHooks(session) ||
    session.preStop
  ) {
    await runCleanup(async () => {
      await runSandboxSessionPreStop(session);
    });
  }
  if (session.stop) {
    await runCleanup(async () => {
      await session.stop!({ reason: 'cleanup' });
    });
    usedStandardLifecycle = true;
  }
  if (session.shutdown) {
    await runCleanup(async () => {
      await session.shutdown!({ reason: 'cleanup' });
    });
    usedStandardLifecycle = true;
  }
  if (session.delete) {
    await runCleanup(async () => {
      await session.delete!({ reason: 'cleanup' });
    });
    usedStandardLifecycle = true;
  }
  if (!usedStandardLifecycle) {
    await runCleanup(async () => {
      await session.close?.();
    });
  }
  if (cleanupError) {
    throw cleanupError;
  }
}

function getManagedHookState(
  session: SandboxSessionLike<SandboxSessionState>,
): ManagedHookState {
  const existing = managedHookStateBySession.get(session);
  if (existing) {
    return existing;
  }
  const state: ManagedHookState = {
    hooks: new Set(),
    ran: false,
    installed: false,
  };
  managedHookStateBySession.set(session, state);
  return state;
}

function hasManagedPreStopHooks(
  session: SandboxSessionLike<SandboxSessionState>,
): boolean {
  return (managedHookStateBySession.get(session)?.hooks.size ?? 0) > 0;
}

function registerProviderManagedPreStopHook(
  session: SandboxSessionLike<SandboxSessionState>,
  state: ManagedHookState,
): void {
  if (state.unregisterProviderHook) {
    return;
  }
  const unregister = session.registerPreStopHook!(async () => {
    await runManagedPreStopHooks(session, state);
  });
  state.unregisterProviderHook =
    typeof unregister === 'function' ? unregister : () => {};
}

function unregisterManagedHook(
  state: ManagedHookState,
  hook: SandboxPreStopHook,
): void {
  state.hooks.delete(hook);
  if (state.hooks.size > 0 || !state.unregisterProviderHook) {
    return;
  }
  state.unregisterProviderHook();
  state.unregisterProviderHook = undefined;
}

function installManagedPreStopHooks(
  session: SandboxSessionLike<SandboxSessionState>,
  state: ManagedHookState,
): void {
  if (state.installed) {
    return;
  }
  state.installed = true;

  const originalRunPreStopHooks = session.runPreStopHooks?.bind(session);
  const originalPreStop = session.preStop?.bind(session);
  const originalStop = session.stop?.bind(session);
  const originalShutdown = session.shutdown?.bind(session);
  const originalDelete = session.delete?.bind(session);
  const originalClose = session.close?.bind(session);
  let originalRunPreStopHooksRan = false;

  const runHooks = async () => {
    await runManagedPreStopHooks(session, state);
    if (originalRunPreStopHooks && !originalRunPreStopHooksRan) {
      originalRunPreStopHooksRan = true;
      await originalRunPreStopHooks();
    }
  };

  session.runPreStopHooks = runHooks;
  session.preStop = async (options?: SandboxSessionLifecycleOptions) => {
    await runHooks();
    await originalPreStop?.(options);
  };
  if (originalStop) {
    session.stop = async (options?: SandboxSessionLifecycleOptions) => {
      await runHooks();
      await originalStop(options);
    };
  }
  if (originalShutdown) {
    session.shutdown = async (options?: SandboxSessionLifecycleOptions) => {
      await runHooks();
      await originalShutdown(options);
    };
  }
  if (originalDelete) {
    session.delete = async (options?: SandboxSessionLifecycleOptions) => {
      await runHooks();
      await originalDelete(options);
    };
  }
  if (originalClose) {
    session.close = async () => {
      await runHooks();
      await originalClose();
    };
  }
}

async function runManagedPreStopHooksForSession(
  session: SandboxSessionLike<SandboxSessionState>,
): Promise<void> {
  const state = managedHookStateBySession.get(session);
  if (!state) {
    return;
  }
  await runManagedPreStopHooks(session, state);
}

async function runManagedPreStopHooks(
  _session: SandboxSessionLike<SandboxSessionState>,
  state: ManagedHookState,
): Promise<void> {
  if (state.ran || state.hooks.size === 0) {
    return;
  }
  state.ran = true;
  let firstError: unknown;
  for (const hook of state.hooks) {
    try {
      await hook();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) {
    throw firstError;
  }
}
