import type { Observation } from './observation';
import { NativeError } from './native-error';

/** An irrevocable application-approved prefix, independent of final output acceptance. */
export type AcceptedTextChunk = Readonly<{
  sessionId: string;
  submissionId: string;
  turnId: string;
  itemId: string;
  text: string;
}>;

/** Return an exact pending prefix to publish; undefined or empty text waits. */
export type AcceptText = (
  pending: string,
) => string | undefined | Promise<string | undefined>;

/** Passive approval never blocks native generation or changes its final result. */
export async function* acceptedText(
  events: AsyncIterable<Observation>,
  accept: AcceptText,
  owns: (event: AcceptedTextChunk) => boolean,
): AsyncGenerator<AcceptedTextChunk> {
  let identity = '';
  let pending = '';
  for await (const event of events) {
    if (event.type === 'gap')
      throw new NativeError('Accepted text observations contain a gap');
    if (event.type !== 'output_text_delta') continue;
    const chunk: AcceptedTextChunk = {
      sessionId: event.sessionId,
      submissionId: event.submissionId,
      turnId: event.turnId,
      itemId: event.itemId,
      text: event.delta,
    };
    if (!owns(chunk)) continue;
    const next = JSON.stringify([
      chunk.sessionId,
      chunk.submissionId,
      chunk.turnId,
      chunk.itemId,
    ]);
    if (next !== identity) {
      identity = next;
      pending = '';
    }
    pending += chunk.text;
    if (new TextEncoder().encode(pending).byteLength > 64 * 1024)
      throw new NativeError(
        'Accepted text pending content exceeds 65536 bytes',
      );
    const approved = await accept(pending);
    if (!owns(chunk)) return;
    if (approved === undefined || approved === '') continue;
    if (typeof approved !== 'string' || !pending.startsWith(approved))
      throw new NativeError('Accepted text must be an exact pending prefix');
    const last = approved.charCodeAt(approved.length - 1);
    const nextCode = pending.charCodeAt(approved.length);
    if (
      last >= 0xd800 &&
      last <= 0xdbff &&
      nextCode >= 0xdc00 &&
      nextCode <= 0xdfff
    )
      throw new NativeError('Accepted text prefix splits a Unicode code point');
    pending = pending.slice(approved.length);
    yield Object.freeze({ ...chunk, text: approved });
  }
}
