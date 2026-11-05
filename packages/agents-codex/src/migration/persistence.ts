import { isDeepStrictEqual } from 'node:util';
import { prepareInputItemsWithSession } from '@openai/agents-core/utils/internal';
import { nativeCarrier } from './input';
import {
  isRunContextAwareSession,
  type RunContext,
  type Session,
  type SessionInputCallback,
  type ModelRequest,
  type ModelResponse,
} from '@openai/agents-core';
import type { AgentInputItem } from '@openai/agents-core/types';
import { captureCompletedHistory } from './history';

/** Read and snapshot supported settled history before starting runtime work. */
export async function readCompletedSessionHistory(
  session: Session,
  context?: RunContext,
): Promise<AgentInputItem[]> {
  const items =
    context && isRunContextAwareSession(session)
      ? await session.getItems(undefined, context)
      : await session.getItems();
  return captureCompletedHistory(items);
}

/**
 * Append the caller's actual completed input/output delta after admission.
 * The completion owner supplies this delta; this helper never creates output,
 * infers completion from final text, retries a failed write or rolls it back.
 * A rejection can follow a committed append. Cancellation cannot undo it.
 */
export async function appendCompletedSessionItems(
  session: Session,
  items: readonly AgentInputItem[],
  context?: RunContext,
): Promise<void> {
  const snapshot = captureCompletedHistory(items);
  if (context && isRunContextAwareSession(session)) {
    await session.addItems(snapshot, context);
  } else {
    await session.addItems(snapshot);
  }
}

/** Admit callback-selected items without replacing canonical delta classification. */
export function completedSessionInputCallback(
  callback?: SessionInputCallback,
): SessionInputCallback {
  return async (history, fresh) => {
    captureCompletedHistory(history);
    captureCompletedHistory(fresh);
    const combined = callback
      ? await callback(history, fresh)
      : [...history, ...fresh];
    captureCompletedHistory(combined);
    // Canonical preparation uses item identities to recognize changed history.
    return combined;
  };
}

/** Per-invocation Model input mapping; no native checkpoint is created or saved. */
export function sessionModelInput(
  prepared: readonly AgentInputItem[],
  stored: readonly AgentInputItem[],
) {
  const input = captureCompletedHistory(prepared);
  const calls = new Set(
    [...captureCompletedHistory(stored), ...input]
      .filter((item) => item.type === 'function_call')
      .map((item) => item.callId),
  );
  let initial: AgentInputItem[] | undefined;
  return {
    request(current: ModelRequest['input']): AgentInputItem[] {
      if (!Array.isArray(current))
        throw new TypeError('Migration Session requires full Model input');
      // modelRequest already validates this native prefix. Core may prepare a
      // carrier image with a different detail; only the SDK projection is input.
      const snapshot = structuredClone(current);
      initial ??= structuredClone(snapshot);
      if (!isDeepStrictEqual(snapshot.slice(0, initial.length), initial))
        throw new TypeError('Migration Session Model input prefix changed');
      return captureCompletedHistory([
        ...input,
        ...snapshot.slice(initial.length),
      ]);
    },
    response(output: ModelResponse['output']): void {
      for (const item of output) {
        if (item.type !== 'function_call') continue;
        if (calls.has(item.callId))
          throw new TypeError(
            'Migration Session cannot replay an existing function call; pending or unknown effects require MIG.8',
          );
        calls.add(item.callId);
      }
    },
  };
}

/** Canonical Session callback selection and fresh-item classification stay in Core. */
export async function loadCompletedSessionInput(
  session: Session,
  input: string | AgentInputItem[],
  callback: SessionInputCallback | undefined,
  context: RunContext,
) {
  let stored: AgentInputItem[] = [];
  // Capture canonical identities from detached reads, and keep optional methods
  // bound to the real store. A separate target also permits frozen stores.
  const historySession = new Proxy(Object.create(session) as Session, {
    get(_target, key) {
      if (key === 'getItems')
        return () => readCompletedSessionHistory(session, context);
      const value = Reflect.get(session, key, session);
      return typeof value === 'function' ? value.bind(session) : value;
    },
  });
  const prepared = await prepareInputItemsWithSession(
    input,
    historySession,
    completedSessionInputCallback((history, fresh) => {
      stored = captureCompletedHistory(history);
      return callback ? callback(history, fresh) : [...history, ...fresh];
    }),
    undefined,
    context,
  );
  if (!Array.isArray(prepared.preparedInput))
    throw new TypeError('Migration Session requires prepared items');
  const modelInput = captureCompletedHistory(prepared.preparedInput);
  const sessionItems = captureCompletedHistory(prepared.sessionItems ?? []);
  const nativeInput = nativeCarrier(sessionItems);
  return {
    nativeInput,
    modelInput,
    sessionItems,
    bridge: sessionModelInput(modelInput, stored),
  };
}
