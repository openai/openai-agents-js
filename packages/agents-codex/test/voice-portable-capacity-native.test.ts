import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NativeVoiceControl,
  PortableVoiceSession,
} from '@openai/agents/voice/portable';

const enabled = process.env.OPENAI_AGENTS_PORTABLE_TESTS === '1';
const sessions: PortableVoiceSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});
async function fixture(active?: 'default' | 'detached') {
  const frames: any[] = [];
  const observed: any[] = [];
  const errors: Error[] = [];
  let closed = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let responseCount = 0;
  const session: PortableVoiceSession = new PortableVoiceSession(
    new NativeVoiceControl(
      new WebAssembly.Module(
        Uint8Array.from(
          readFileSync(process.env.OPENAI_AGENTS_PORTABLE_CONTROL_WASM!),
        ),
      ),
    ),
    {
      send(frame) {
        const event = JSON.parse(frame);
        frames.push(event);
        if (event.type === 'session.update')
          queueMicrotask(() =>
            session.receive({
              type: 'session.updated',
              session: event.session,
            }),
          );
        if (event.type === 'input_audio_buffer.append') return held;
        if (event.type === 'response.create') {
          const id =
            ++responseCount === 1 && active
              ? 'active-😀-"\\'
              : `complete-${responseCount}`;
          queueMicrotask(() => {
            const response = { ...event.response, id };
            session.receive({ type: 'response.created', response });
            if (!(responseCount === 1 && active))
              session.receive({
                type: 'response.done',
                response: { ...response, status: 'completed', output: [] },
              });
          });
        }
        if (event.type === 'response.cancel')
          queueMicrotask(() =>
            session.receive({
              type: 'response.done',
              response: {
                id: event.response_id,
                status: 'cancelled',
                output: [],
              },
            }),
          );
      },
      close() {
        release();
        closed++;
      },
    },
    {
      model: 'test-realtime',
      instructions: 'Help.',
      onEvent: (event) => observed.push(event),
      onError: (error) => errors.push(error),
    },
  );
  sessions.push(session);
  await session.start();
  await vi.waitFor(() =>
    expect(frames.some((event) => event.type === 'session.update')).toBe(true),
  );
  // The configuration receipt has to leave the host queue before pressure starts.
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (active) {
    session.createResponse(
      active === 'detached' ? { conversation: 'none' } : undefined,
    );
    await vi.waitFor(() =>
      expect(observed.some((event) => event.type === 'response.created')).toBe(
        true,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { session, frames, observed, errors, release, closed: () => closed };
}
function fill(
  session: PortableVoiceSession,
  boundary: 'count' | 'bytes',
  leave = 0,
) {
  if (boundary === 'count') {
    for (let i = 0; i < 256; i++) session.sendAudio('AAAA');
    return 256;
  }
  const overhead =
    JSON.stringify({ type: 'input_audio_buffer.append', audio: '' }).length * 2;
  let remaining = 8 * 1024 * 1024 - leave;
  let count = 0;
  while (remaining >= 256 * 1024 * 2 + overhead) {
    session.sendAudio('A'.repeat(256 * 1024));
    remaining -= 256 * 1024 * 2 + overhead;
    count++;
  }
  const length = Math.floor((remaining - overhead) / 8) * 4;
  session.sendAudio('A'.repeat(length));
  return count + 1;
}
describe.runIf(enabled)('actual native portable egress admission', () => {
  it.each(
    (['commitAudio', 'clearAudio', 'createResponse'] as const).flatMap(
      (method) =>
        (['count', 'bytes'] as const).map((boundary) => ({ method, boundary })),
    ),
  )(
    'keeps $method rejection nonfatal at $boundary pressure',
    async ({ method, boundary }) => {
      const f = await fixture();
      const count = fill(f.session, boundary);
      expect(() => f.session[method]()).toThrow(RangeError);
      expect(f.errors).toEqual([]);
      expect(f.closed()).toBe(0);
      f.release();
      await vi.waitFor(() =>
        expect(
          f.frames.filter(
            (event) => event.type === 'input_audio_buffer.append',
          ),
        ).toHaveLength(count),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      f.session[method]();
      const type =
        method === 'commitAudio'
          ? 'input_audio_buffer.commit'
          : method === 'clearAudio'
            ? 'input_audio_buffer.clear'
            : 'response.create';
      await vi.waitFor(() =>
        expect(f.frames.filter((event) => event.type === type)).toHaveLength(1),
      );
      if (method !== 'createResponse') f.session.createResponse();
      await vi.waitFor(() =>
        expect(
          f.observed.some(
            (event) =>
              event.type === 'response.done' &&
              event.response.status === 'completed',
          ),
        ).toBe(true),
      );
      expect(f.errors).toEqual([]);
      expect(f.closed()).toBe(0);
    },
  );
  it.each(
    (['default', 'detached'] as const).flatMap((owner) =>
      (['count', 'bytes'] as const).map((boundary) => ({ owner, boundary })),
    ),
  )(
    'keeps $owner cancel rejection nonfatal at $boundary pressure',
    async ({ owner, boundary }) => {
      const f = await fixture(owner);
      const count = fill(f.session, boundary);
      const cancel = () =>
        f.session.cancel(owner === 'detached' ? 'active-😀-"\\' : undefined);
      expect(cancel).toThrow(RangeError);
      expect(f.errors).toEqual([]);
      expect(f.closed()).toBe(0);
      f.release();
      await vi.waitFor(() =>
        expect(
          f.frames.filter(
            (event) => event.type === 'input_audio_buffer.append',
          ),
        ).toHaveLength(count),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      cancel();
      await vi.waitFor(() =>
        expect(
          f.frames.filter((event) => event.type === 'response.cancel'),
        ).toHaveLength(1),
      );
      await vi.waitFor(() =>
        expect(
          f.observed.some(
            (event) =>
              event.type === 'response.done' &&
              event.response.status === 'cancelled',
          ),
        ).toBe(true),
      );
      f.session.createResponse();
      await vi.waitFor(() =>
        expect(
          f.observed.some(
            (event) =>
              event.type === 'response.done' &&
              event.response.status === 'completed',
          ),
        ).toBe(true),
      );
      expect(f.errors).toEqual([]);
      expect(f.closed()).toBe(0);
    },
  );
  it.each(['text', 'message'] as const)(
    'rejects oversized %s before native mutation and permits a valid retry',
    async (kind) => {
      const f = await fixture();
      const text = 'x'.repeat(32 * 1024 * 1024);
      expect(() =>
        kind === 'text'
          ? f.session.sendText(text)
          : f.session.sendMessage({
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_image',
                  image_url: `data:image/png;base64,${text}`,
                },
              ],
            }),
      ).toThrow(RangeError);
      expect(f.errors).toEqual([]);
      expect(f.closed()).toBe(0);
      f.session.sendText('valid retry');
      await vi.waitFor(() =>
        expect(f.observed.some((event) => event.type === 'response.done')).toBe(
          true,
        ),
      );
    },
  );
  it('rechecks transport pressure after caller JSON capture without retiring the owner', async () => {
    const f = await fixture();
    const capture = vi.fn(() => {
      fill(f.session, 'count');
      return {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'outer' }],
      };
    });
    expect(() => f.session.sendMessage({ toJSON: capture })).toThrow(
      RangeError,
    );
    expect(capture).toHaveBeenCalledOnce();
    expect(f.errors).toEqual([]);
    expect(f.closed()).toBe(0);
    f.release();
    await vi.waitFor(() =>
      expect(
        f.frames.filter((event) => event.type === 'input_audio_buffer.append'),
      ).toHaveLength(256),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.session.sendMessage({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'retry' }],
    });
    f.session.createResponse();
    await vi.waitFor(() =>
      expect(f.observed.some((event) => event.type === 'response.done')).toBe(
        true,
      ),
    );
    expect(f.errors).toEqual([]);
  });

  it.each(['count', 'bytes'] as const)(
    'reserves both sendMessage frames at %s pressure and permits retry',
    async (boundary) => {
      const f = await fixture();
      const item = {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'pressure' }],
      };
      let count: number;
      if (boundary === 'count') {
        count = 255;
        for (let i = 0; i < count; i++) f.session.sendAudio('AAAA');
      } else {
        const bytes =
          2 *
            JSON.stringify({ type: 'conversation.item.create', item }).length +
          2 * JSON.stringify({ type: 'response.create' }).length;
        count = fill(f.session, 'bytes', bytes - 8);
      }
      expect(() => f.session.sendMessage(item)).toThrow(RangeError);
      expect(f.errors).toEqual([]);
      expect(f.closed()).toBe(0);
      f.release();
      await vi.waitFor(() =>
        expect(
          f.frames.filter(
            (event) => event.type === 'input_audio_buffer.append',
          ),
        ).toHaveLength(count),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      f.session.sendMessage(item);
      await vi.waitFor(() =>
        expect(f.observed.some((event) => event.type === 'response.done')).toBe(
          true,
        ),
      );
      expect(
        f.frames.filter((event) => event.type === 'conversation.item.create'),
      ).toHaveLength(1);
      expect(
        f.frames.filter((event) => event.type === 'response.create'),
      ).toHaveLength(1);
      expect(f.errors).toEqual([]);
      expect(f.closed()).toBe(0);
    },
  );
});
