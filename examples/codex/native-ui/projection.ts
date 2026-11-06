import {
  NativeError,
  type Observation,
  type Session,
  type SessionItem,
  type Completed,
  type Turn,
} from '@openai/agents';

export type ViewTurn<T> = Pick<
  Turn<T, string | null>,
  'sessionId' | 'submissionId' | 'turnId' | 'childId' | 'events'
> & { wait(): Promise<Pick<Completed<T>, 'finalOutput'>> };
export type ViewSession = Pick<Session, 'id' | 'items'>;
export type Frame = Record<string, unknown>;
export const stopped = (error: unknown): boolean =>
  error instanceof NativeError && error.name === 'TurnAborted';
const detached = new Error('UI reader detached');

/** Release this local wait without cancelling the underlying owned operation. */
export async function localWait<T>(
  promise: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  const observed = Promise.resolve(promise);
  if (signal.aborted) {
    void observed.catch(() => {});
    signal.throwIfAborted();
  }
  let remove = () => {};
  const stopped = new Promise<never>((_, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    remove = () => signal.removeEventListener('abort', stop);
  });
  try {
    return await Promise.race([observed, stopped]);
  } finally {
    remove();
  }
}

export function progress(
  event: Extract<Observation, { type: 'tool_started' | 'tool_finished' }>,
): Frame {
  return {
    type: event.type,
    call_id: event.callId,
    name: event.name,
    namespace: event.namespace,
    family: event.family,
    ...(event.type === 'tool_finished' ? { status: event.status } : {}),
  };
}

/** Rust Unicode White_Space differs from JavaScript trim, notably for BOM. */
export const nativeBlank = (text: string): boolean =>
  /^\p{White_Space}*$/u.test(text);

export async function completeDisplay(
  session: ViewSession,
  childId: string | null,
  turns: ReadonlySet<string>,
  last: string,
  shown: ReadonlyMap<string, string>,
  plain: boolean,
  output: unknown,
  signal: AbortSignal,
): Promise<boolean> {
  const recorded = new Map<string, string>();
  let candidate: string | undefined;
  let fallback: string | undefined;
  const items = session.items({ subagentId: childId ?? undefined });
  try {
    if (shown.size || (plain && output)) {
      for (;;) {
        const next = await localWait(items.next(), signal);
        if (next.done) break;
        const item: SessionItem = next.value;
        if (
          item.type !== 'message' ||
          item.role !== 'assistant' ||
          item.status !== 'completed' ||
          !turns.has(item.turnId)
        )
          continue;
        const text =
          item.displayText ??
          item.content
            .map((part) => (part.type === 'input_image' ? '' : part.text))
            .join('');
        recorded.set(item.id, text);
        if (item.turnId !== last) continue;
        if (item.phase === 'final_answer') candidate = item.id;
        else if (item.phase === null) {
          fallback = item.id;
          if (!nativeBlank(text)) candidate = item.id;
        }
      }
    }
  } catch (error) {
    if (signal.aborted) throw error;
    return false;
  } finally {
    const closing = items.return(undefined);
    if (signal.aborted) void closing.catch(() => {});
    else await localWait(closing, signal);
  }
  for (const [id, text] of shown) if (recorded.get(id) !== text) return false;
  if (!plain) return true;
  if (output === '' && [...shown.values()].every((text) => text === ''))
    return true;
  const id = candidate ?? fallback;
  if (!id || !shown.has(id)) return false;
  const text = shown.get(id)!;
  return text === output || (output === '' && nativeBlank(text));
}

export function remember(
  shown: Map<string, string>,
  id: string,
  delta: string,
): boolean {
  // This copyable view deliberately bounds memory independently of native history.
  const total = [...shown.values()].reduce((n, text) => n + text.length, 0);
  if ((!shown.has(id) && shown.size >= 256) || total + delta.length > 1_048_576)
    return false;
  shown.set(id, (shown.get(id) ?? '') + delta);
  return true;
}

/** Reader ownership stays local; the optional cleanup owns only its own Session. */
export function responseStream(
  events: AsyncIterableIterator<Observation>,
  project: (signal: AbortSignal) => AsyncGenerator<Frame | '[DONE]'>,
  headers: Record<string, string>,
  closeOwned?: () => Promise<void>,
): Response {
  const stop = new AbortController();
  const generator = project(stop.signal);
  const encoder = new TextEncoder();
  let closed = false;
  let cleanup: Promise<void> | undefined;
  const close = () => (cleanup ??= closeOwned?.() ?? Promise.resolve());
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await generator.next();
        if (closed) return;
        if (next.done) {
          await close();
          if (!closed) {
            closed = true;
            controller.close();
          }
        } else
          controller.enqueue(
            encoder.encode(
              `data: ${next.value === '[DONE]' ? next.value : JSON.stringify(next.value)}\n\n`,
            ),
          );
      } catch (error) {
        if (!closed) {
          closed = true;
          try {
            await close();
          } finally {
            controller.error(error);
          }
        }
      }
    },
    async cancel() {
      closed = true;
      stop.abort(detached);
      // Initiate owned cleanup before joining a generator with a pending next.
      const owned = close();
      const reader = events.return?.();
      const returned = generator.return(undefined);
      const results = await Promise.allSettled([owned, reader, returned]);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}
