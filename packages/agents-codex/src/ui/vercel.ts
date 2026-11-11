import type { Observation } from '../runtime/observation';
import type { SessionItem } from '../runtime/history';
import {
  NativeError,
  type Session,
  type Completed,
  type Turn,
} from '../runtime/session';

type ViewTurn<T> = Pick<
  Turn<T, string | null>,
  'sessionId' | 'submissionId' | 'turnId' | 'childId' | 'events'
> & { wait(): Promise<Pick<Completed<T>, 'finalOutput'>> };
type ViewSession = Pick<Session, 'id' | 'items'>;
export type VercelMessageChunk =
  | { type: 'start' | 'finish' | 'abort' }
  | {
      type: 'text-start' | 'text-end' | 'reasoning-start' | 'reasoning-end';
      id: string;
    }
  | { type: 'text-delta' | 'reasoning-delta'; id: string; delta: string }
  | {
      type: 'data-tool-progress';
      data: ReturnType<typeof progress>;
      transient: true;
    }
  | {
      type: 'tool-input-available';
      toolCallId: string;
      toolName: string;
      input: unknown;
      dynamic: true;
    }
  | {
      type: 'tool-output-available';
      toolCallId: string;
      output: unknown;
      dynamic: true;
    }
  | {
      type: 'tool-output-error';
      toolCallId: string;
      errorText: string;
      dynamic: true;
    }
  | { type: 'error'; errorText: string };

export type VercelMessageStreamOptions = {
  includeToolData?: boolean;
  includeReasoningSummaries?: boolean;
};
type ShownText = { text: string; trailingHighSurrogate: boolean };
const utf8 = new TextEncoder();
const stopped = (error: unknown): boolean =>
  error instanceof NativeError && error.name === 'TurnAborted';
const detached = new Error('UI reader detached');

/** Release this local wait without cancelling the underlying owned operation. */
async function localWait<T>(
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

function progress(
  event: Extract<Observation, { type: 'tool_started' | 'tool_finished' }>,
) {
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
const nativeBlank = (text: string): boolean => /^\p{White_Space}*$/u.test(text);

async function completeDisplay(
  session: ViewSession,
  childId: string | null,
  turns: ReadonlySet<string>,
  last: string,
  shown: ReadonlyMap<string, ShownText>,
  plain: boolean,
  output: unknown,
  signal: AbortSignal,
): Promise<boolean> {
  const recorded = new Map<string, { text: string; bytes: number }>();
  let recordedBytes = 0;
  let candidate: string | undefined;
  let fallback: string | undefined;
  const items = session.items({ subagentId: childId ?? undefined });
  try {
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
      const bytes = utf8.encode(text).length;
      recordedBytes += bytes - (recorded.get(item.id)?.bytes ?? 0);
      recorded.set(item.id, { text, bytes });
      if (recorded.size > 256 || recordedBytes > 1_048_576) return false;
      if (item.turnId !== last) continue;
      if (item.phase === 'final_answer') candidate = item.id;
      else if (item.phase === null) {
        fallback = item.id;
        if (!nativeBlank(text)) candidate = item.id;
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
  for (const [id, value] of shown)
    if (recorded.get(id)?.text !== value.text) return false;
  for (const [id, value] of recorded)
    if (value.text && shown.get(id)?.text !== value.text) return false;
  if (!plain) return true;
  if (output === '' && [...shown.values()].every((value) => value.text === ''))
    return true;
  const id = candidate ?? fallback;
  if (!id || !shown.has(id)) return false;
  const text = shown.get(id)!.text;
  return text === output || (output === '' && nativeBlank(text));
}

function remember(
  shown: Map<string, ShownText>,
  id: string,
  delta: string,
  totalBytes: number,
): number | undefined {
  const previous = shown.get(id);
  const first = delta.charCodeAt(0);
  // A pair split across deltas replaces two three-byte surrogate replacements
  // with one four-byte scalar. Other item IDs and empty deltas cannot pair.
  const paired =
    previous?.trailingHighSurrogate && first >= 0xdc00 && first <= 0xdfff;
  const nextBytes = totalBytes + utf8.encode(delta).length - (paired ? 2 : 0);
  if ((!previous && shown.size >= 256) || nextBytes > 1_048_576)
    return undefined;
  const last = delta.charCodeAt(delta.length - 1);
  shown.set(id, {
    text: (previous?.text ?? '') + delta,
    trailingHighSurrogate: delta.length
      ? last >= 0xd800 && last <= 0xdbff
      : (previous?.trailingHighSurrogate ?? false),
  });
  return nextBytes;
}

type ChunkEncoding<Chunk> = {
  frame: (chunk: VercelMessageChunk) => Chunk;
  end?: Chunk;
};

/** Closing a stream releases only its local reader. */
function messageStream<Chunk>({
  events,
  project,
  encoding,
}: {
  events: AsyncIterableIterator<Observation>;
  project: (signal: AbortSignal) => AsyncGenerator<VercelMessageChunk>;
  encoding: ChunkEncoding<Chunk>;
}): ReadableStream<Chunk> {
  const stop = new AbortController();
  const generator = project(stop.signal);
  let closed = false;
  return new ReadableStream<Chunk>({
    async pull(controller) {
      try {
        const next = await generator.next();
        if (closed) return;
        if (next.done) {
          if (encoding.end !== undefined) controller.enqueue(encoding.end);
          closed = true;
          controller.close();
        } else controller.enqueue(encoding.frame(next.value));
      } catch (error) {
        if (!closed) {
          closed = true;
          controller.error(error);
        }
      }
    },
    async cancel() {
      closed = true;
      stop.abort(detached);
      // Detach this reader before joining a generator with a pending next.
      const reader = events.return?.();
      const returned = generator.return(undefined);
      const results = await Promise.allSettled([reader, returned]);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  });
}

class ProjectionError extends Error {}

async function retainedFrames(
  session: ViewSession,
  childId: string | null,
  turnId: string,
  {
    includeToolData,
    includeReasoningSummaries,
  }: Required<VercelMessageStreamOptions>,
  signal: AbortSignal,
): Promise<VercelMessageChunk[]> {
  const calls = new Map<
    string,
    Extract<SessionItem, { type: 'function_call' | 'mcp_call' }>
  >();
  const outputs = new Map<
    string,
    Extract<SessionItem, { type: 'function_call_output' }>
  >();
  const frames: VercelMessageChunk[] = [];
  let size = 0;
  let summaries = 0;
  const items = session.items({ subagentId: childId ?? undefined });
  try {
    for (;;) {
      const next = await localWait(items.next(), signal);
      if (next.done) break;
      const item = next.value;
      if (item.turnId !== turnId) continue;
      if (includeReasoningSummaries && item.type === 'reasoning') {
        const text = item.summary.map((part) => part.text).join('');
        if (!text) continue;
        size += utf8.encode(text).length;
        summaries += 1;
        if (summaries > 256 || size > 1_048_576)
          throw new ProjectionError('UI reasoning summary limit');
        frames.push(
          { type: 'reasoning-start', id: item.id },
          { type: 'reasoning-delta', id: item.id, delta: text },
          { type: 'reasoning-end', id: item.id },
        );
        continue;
      }
      if (
        !includeToolData ||
        !['function_call', 'function_call_output', 'mcp_call'].includes(
          item.type,
        )
      )
        continue;
      size += utf8.encode(JSON.stringify(item)).length;
      if (size > 1_048_576) throw new ProjectionError('UI tool payload limit');
      if (item.type === 'function_call_output') {
        if (outputs.has(item.callId))
          throw new ProjectionError('Ambiguous tool result');
        outputs.set(item.callId, item);
      } else if (item.type === 'function_call' || item.type === 'mcp_call') {
        const id = item.callId ?? item.id;
        const previous = calls.get(id);
        if (previous?.type === item.type)
          throw new ProjectionError('Ambiguous tool call');
        // Native MCP completion enriches its model function-call record.
        if (!previous || item.type === 'mcp_call') calls.set(id, item);
      }
      if (calls.size > 256 || outputs.size > 256)
        throw new ProjectionError('UI tool count limit');
    }
  } finally {
    const closing = items.return(undefined);
    if (signal.aborted) void closing.catch(() => {});
    else await localWait(closing, signal);
  }
  for (const [id, call] of calls) {
    const output = call.type === 'mcp_call' ? call : outputs.get(id);
    outputs.delete(id);
    if (!output || output.status === 'in_progress')
      throw new ProjectionError('Missing completed tool result');
    let input = call.arguments;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        /* Custom tool input may be text. */
      }
    }
    frames.push({
      type: 'tool-input-available',
      toolCallId: id,
      toolName:
        call.type === 'mcp_call'
          ? `${call.serverLabel}.${call.name}`
          : call.name,
      input,
      dynamic: true,
    });
    frames.push(
      output.error !== null || output.status !== 'completed'
        ? {
            type: 'tool-output-error',
            toolCallId: id,
            errorText:
              typeof output.error === 'string'
                ? output.error
                : JSON.stringify(output.error ?? 'Tool did not complete'),
            dynamic: true,
          }
        : {
            type: 'tool-output-available',
            toolCallId: id,
            output: output.output,
            dynamic: true,
          },
    );
  }
  if (outputs.size) throw new ProjectionError('Tool result without call');
  return frames;
}

function createVercelStream<Chunk>(
  turn: ViewTurn<string>,
  session: ViewSession,
  {
    includeToolData = false,
    includeReasoningSummaries = false,
  }: VercelMessageStreamOptions,
  encoding: ChunkEncoding<Chunk>,
): ReadableStream<Chunk> {
  if (typeof includeToolData !== 'boolean')
    throw new TypeError('includeToolData must be a boolean');
  if (typeof includeReasoningSummaries !== 'boolean')
    throw new TypeError('includeReasoningSummaries must be a boolean');
  if (session.id !== turn.sessionId)
    throw new TypeError('Pass the owning Session');
  const events = turn.events();
  return messageStream({
    events,
    encoding,
    async *project(signal) {
      const shown = new Map<string, ShownText>();
      let shownBytes = 0;
      let started: string | undefined;
      let gap = false;
      let lost = false;
      try {
        yield { type: 'start' };
        for (;;) {
          const next = await localWait(events.next(), signal);
          if (next.done) break;
          const event = next.value;
          if (
            event.type === 'turn_started' &&
            !started &&
            event.submissionId === turn.submissionId
          ) {
            started = event.turnId;
            continue;
          }
          if (event.type === 'gap' && !started) {
            gap = true;
            continue;
          }
          if (
            !started ||
            event.type === 'gap' ||
            event.type === 'turn_started'
          ) {
            lost = true;
            break;
          }
          if (event.type === 'output_text_delta') {
            const opened = shown.has(event.itemId);
            const nextBytes = remember(
              shown,
              event.itemId,
              event.delta,
              shownBytes,
            );
            if (nextBytes === undefined) {
              lost = true;
              break;
            }
            shownBytes = nextBytes;
            if (!opened) yield { type: 'text-start', id: event.itemId };
            yield { type: 'text-delta', id: event.itemId, delta: event.delta };
          } else if (
            event.type === 'tool_started' ||
            event.type === 'tool_finished'
          )
            yield {
              type: 'data-tool-progress',
              data: progress(event),
              transient: true,
            };
        }
        for (const id of shown.keys()) yield { type: 'text-end', id };
        let terminal: VercelMessageChunk = {
          type: 'error',
          errorText: 'resync_required',
        };
        if (!lost && !(!started && gap && turn.turnId !== null)) {
          try {
            const result = await localWait(turn.wait(), signal);
            if (typeof result.finalOutput !== 'string')
              throw new ProjectionError('Plain text output required');
            if (
              started &&
              (await completeDisplay(
                session,
                turn.childId,
                new Set([started]),
                started,
                shown,
                true,
                result.finalOutput,
                signal,
              ))
            ) {
              if (includeToolData || includeReasoningSummaries)
                for (const frame of await retainedFrames(
                  session,
                  turn.childId,
                  started,
                  { includeToolData, includeReasoningSummaries },
                  signal,
                ))
                  yield frame;
              terminal = { type: 'finish' };
            }
          } catch (error) {
            signal.throwIfAborted();
            terminal = stopped(error)
              ? { type: 'abort' }
              : {
                  type: 'error',
                  errorText:
                    error instanceof ProjectionError
                      ? 'resync_required'
                      : 'turn_failed',
                };
          }
        }
        yield terminal;
      } catch {
        signal.throwIfAborted();
        for (const id of shown.keys()) yield { type: 'text-end', id };
        yield { type: 'error', errorText: 'turn_failed' };
      } finally {
        await events.return?.();
      }
    },
  });
}

/**
 * Project a fresh, plain-text native turn as UI Message Stream v1 chunks.
 * Submit with the default plain-text output declaration.
 * Missing observations fail with resync_required. Use an authorized history view
 * to recover. Closing the reader leaves execution running.
 *
 * Opt in to tool data or provider reasoning summaries at settlement. Tool data
 * is sensitive, and bounded native retention may omit parts of remote output.
 */
export function vercelMessageStream(
  turn: ViewTurn<string>,
  session: ViewSession,
  options: VercelMessageStreamOptions = {},
): ReadableStream<VercelMessageChunk> {
  return createVercelStream(turn, session, options, {
    frame: (chunk) => chunk,
  });
}

/** Serve {@link vercelMessageStream} as a server-sent event response. */
export function vercelResponse(
  turn: ViewTurn<string>,
  session: ViewSession,
  options: VercelMessageStreamOptions = {},
): Response {
  const body = createVercelStream(turn, session, options, {
    frame: (chunk) => utf8.encode(`data: ${JSON.stringify(chunk)}\n\n`),
    end: utf8.encode('data: [DONE]\n\n'),
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'x-vercel-ai-ui-message-stream': 'v1',
    },
  });
}
