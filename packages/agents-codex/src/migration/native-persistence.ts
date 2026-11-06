import {
  captureThreadStore,
  type SessionStore,
} from '../runtime/custom-thread-store';
import {
  captureReconciledCalls,
  type ReconciledCall,
} from '../runtime/local-recovery';
import { localStoragePath, type LocalStorage } from '../runtime/local-storage';
import {
  isManualSessionState,
  sessionStateSchema,
  type SessionState,
} from '../runtime/state';
import type { ThreadHistory } from '../runtime/history';
import type { SessionOptions } from '../runtime/session';

/** Native persistence for an SDKRunner invocation. */
export interface MigrationNativePersistence {
  /** Restore an idle native checkpoint using the current application bindings. */
  state?: SessionState;
  /** Persist native history in a local profile or an application-owned canonical store. */
  storage?: LocalStorage | SessionStore;
  /** Reopen this native session ID in storage. */
  resume?: string;
  /** Confirm outcomes for unresolved effects before reopening a local profile. */
  reconciledCalls?: readonly ReconciledCall[];
  /** Include the completed idle native checkpoint in the result. */
  returnState?: boolean;
}

/** Capture application declarations before any asynchronous work. */
export function captureNativePersistence(options: MigrationNativePersistence) {
  const { storage, resume, returnState } = options;
  const persistent = storage !== undefined;
  if (returnState !== undefined && typeof returnState !== 'boolean')
    throw new TypeError('returnState must be a boolean');
  if (persistent && (options.state !== undefined || returnState))
    throw new TypeError(
      'Portable state cannot be combined with native storage',
    );
  if (
    resume !== undefined &&
    (!persistent || typeof resume !== 'string' || !resume)
  )
    throw new TypeError(
      'resume requires native storage and a nonempty session ID',
    );
  const customStore =
    storage != null && typeof storage === 'object' && 'acquire' in storage
      ? captureThreadStore(storage)
      : undefined;
  const localPath =
    persistent && !customStore
      ? localStoragePath(storage as LocalStorage)
      : undefined;
  const reconciledCalls = captureReconciledCalls(options.reconciledCalls);
  if (
    reconciledCalls !== undefined &&
    (localPath === undefined || resume === undefined)
  )
    throw new TypeError('reconciledCalls requires local storage and resume');
  const state =
    options.state === undefined
      ? undefined
      : sessionStateSchema.parse(options.state);
  if (
    state &&
    (isManualSessionState(state) ||
      state.pending_actions.length ||
      state.interrupted_thread_ids.length ||
      state.root_turn_budget != null)
  )
    throw new TypeError('Migration requires an idle native checkpoint');
  if (state?.descendants.length)
    throw new TypeError('Migration requires a root-only native checkpoint');
  const restore = state
    ? ('checkpoint' as const)
    : resume
      ? ('storage' as const)
      : undefined;
  const sessionOptions: Pick<
    SessionOptions,
    'state' | 'localStorage' | 'customStore' | 'localResume'
  > = {
    state,
    localStorage: persistent,
    customStore,
    localResume: resume !== undefined,
  };
  return {
    restore,
    enabled: persistent || state !== undefined || returnState === true,
    returnState,
    runtime: {
      ...(persistent ? { ephemeral: false } : {}),
      ...(localPath === undefined ? {} : { native_thread_store: localPath }),
      ...(resume === undefined ? {} : { _sdk_resume_thread_id: resume }),
    },
    threadOptions: {
      ...(resume === undefined ? {} : { _sdk_resume_thread_id: resume }),
      ...(reconciledCalls?.length
        ? { _sdk_reconciled_calls: reconciledCalls }
        : {}),
    },
    sessionOptions,
  };
}

/** Seed the invocation guard from native root records, including compacted context. */
export function recordedCallIds(history: ThreadHistory): Set<string> {
  const ids = new Set<string>();
  for (const { type, payload } of history) {
    const items =
      type === 'response_item'
        ? [payload]
        : type === 'compacted' && Array.isArray(payload.replacement_history)
          ? payload.replacement_history
          : [];
    for (const item of items) {
      if (
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        (item.type === 'function_call' ||
          item.type === 'function_call_output' ||
          item.type === 'custom_tool_call' ||
          item.type === 'custom_tool_call_output') &&
        typeof item.call_id === 'string'
      )
        ids.add(item.call_id);
    }
  }
  return ids;
}
