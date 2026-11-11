import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as base64 from '../src/voice/base64';
import { VoiceConversationHistory } from '../src/voice/conversation-history';
import {
  NativeVoiceControl,
  PortableVoiceSession,
} from '../src/voice/portable';

afterEach(() => vi.restoreAllMocks());

function item(id: string, audio: string, transcript = id) {
  return {
    type: 'conversation.item.retrieved',
    item: {
      id,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_audio', audio, transcript }],
    },
  };
}

function content(history: VoiceConversationHistory, id: string) {
  return (history.snapshot().find((row) => row.id === id)!.content as any[])[0];
}

it('decodes and retains only the remaining embedded audio prefix', () => {
  const history = new VoiceConversationHistory({
    storeAudio: true,
    maxAudioBytes: 6,
  });
  history.observe(
    item('first', base64.encodeBase64(Uint8Array.of(1, 2, 3, 4))),
  );
  const decode = vi.spyOn(base64, 'decodeBase64');
  history.observe(
    item('second', base64.encodeBase64(Uint8Array.of(5, 6, 7, 8))),
  );
  expect(decode).toHaveBeenCalledOnce();
  expect(decode.mock.results[0].value).toEqual(Uint8Array.of(5, 6));
  expect(content(history, 'second')).toMatchObject({
    audio: 'BQY=',
    audio_truncated: true,
  });
});

it('marks a zero-byte prefix when embedded audio has no remaining capacity', () => {
  const history = new VoiceConversationHistory({
    storeAudio: true,
    maxAudioBytes: 0,
  });
  const decode = vi.spyOn(base64, 'decodeBase64');
  history.observe(item('zero', 'AQID'));
  expect(
    decode.mock.results.every((result) => result.value.byteLength === 0),
  ).toBe(true);
  expect(content(history, 'zero')).toMatchObject({
    audio: '',
    audio_truncated: true,
  });
});

it('shares remaining capacity across the complete item before decoding', () => {
  const history = new VoiceConversationHistory({
    storeAudio: true,
    maxAudioBytes: 5,
  });
  const event = item('multiple', 'AQID');
  event.item.content.push({
    type: 'output_audio',
    audio: 'BAUG',
    transcript: 'second',
  });
  history.observe(event);
  expect(history.snapshot()[0].content).toEqual([
    { type: 'output_audio', transcript: 'multiple', audio: 'AQID' },
    {
      type: 'output_audio',
      transcript: 'second',
      audio: 'BAU=',
      audio_truncated: true,
    },
  ]);
});

it('clears an authoritative empty replacement after sealing without reopening growth', () => {
  const history = new VoiceConversationHistory({
    storeAudio: true,
    maxAudioBytes: 3,
  });
  history.observe(item('first', 'AQID'));
  history.observe(item('overflow', 'BAUG'));
  history.observe(item('first', '', 'cleared'));
  expect(content(history, 'first')).toMatchObject({
    audio: '',
    transcript: 'cleared',
  });
  expect(content(history, 'first')).not.toHaveProperty('audio_truncated');
  history.observe(item('later', 'BwgJ'));
  expect(content(history, 'later')).toMatchObject({
    audio: '',
    audio_truncated: true,
  });
});

it.each([
  ['conversation.item.done', undefined],
  ['conversation.item.done', '!!!!'],
  ['conversation.item.retrieved', undefined],
  ['conversation.item.retrieved', '!!!!'],
] as const)(
  'preserves truncation across %s with optional audio %s',
  (type, audio) => {
    for (const maxAudioBytes of [0, 2]) {
      const history = new VoiceConversationHistory({
        storeAudio: true,
        maxAudioBytes,
      });
      history.observe(item('known', 'AQID'));
      const followup = {
        ...item('known', '', 'updated transcript'),
        type,
      };
      if (audio === undefined)
        delete (followup.item.content[0] as { audio?: string }).audio;
      else followup.item.content[0].audio = audio;
      history.observe(followup);
      expect(content(history, 'known')).toMatchObject({
        audio: maxAudioBytes ? 'AQI=' : '',
        transcript: 'updated transcript',
        audio_truncated: true,
      });
      history.observe(item('known', maxAudioBytes ? 'AQ==' : ''));
      expect(content(history, 'known')).not.toHaveProperty('audio_truncated');
      history.observe(followup);
      expect(content(history, 'known')).not.toHaveProperty('audio_truncated');
    }
  },
);

it.each(['!!!!', 'A', 'AQ=', 'AQID!!!!'])(
  'ignores malformed embedded audio %s while retaining text and prior valid audio',
  (invalid) => {
    const history = new VoiceConversationHistory({ storeAudio: true });
    history.observe(item('known', 'AQID'));
    expect(() =>
      history.observe(item('known', invalid, 'new transcript')),
    ).not.toThrow();
    expect(content(history, 'known')).toMatchObject({
      audio: 'AQID',
      transcript: 'new transcript',
    });
    expect(() =>
      history.observe(item('new', invalid, 'valid text')),
    ).not.toThrow();
    expect(content(history, 'new')).toEqual({
      type: 'output_audio',
      transcript: 'valid text',
    });
    history.observe(item('following', 'BAUG'));
    expect(content(history, 'following')).toMatchObject({ audio: 'BAUG' });
  },
);

it('clears a delta overflow marker on a valid complete replacement', () => {
  const history = new VoiceConversationHistory({
    storeAudio: true,
    maxAudioBytes: 2,
  });
  history.observe(item('known', 'AQI='));
  history.observeAudio('known', 0, Uint8Array.of(3));
  expect(content(history, 'known').audio_truncated).toBe(true);
  history.observe(item('known', 'AQ=='));
  expect(content(history, 'known')).toMatchObject({ audio: 'AQ==' });
  expect(content(history, 'known')).not.toHaveProperty('audio_truncated');
});

it.runIf(process.env.OPENAI_AGENTS_PORTABLE_TESTS === '1')(
  'keeps the portable session and raw observation live after malformed embedded audio',
  async () => {
    const onProviderEvent = vi.fn();
    const onError = vi.fn();
    const close = vi.fn();
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
          if (event.type === 'session.update')
            queueMicrotask(() =>
              session.receive({
                type: 'session.updated',
                session: event.session,
              }),
            );
        },
        close,
      },
      {
        model: 'test',
        instructions: 'Help.',
        storeAudio: true,
        onProviderEvent,
        onError,
      },
    );
    try {
      await session.start();
      session.receive(item('known', 'AQID'));
      const malformed = item('known', '!!!!', 'valid transcript');
      session.receive(malformed);
      expect(onProviderEvent).toHaveBeenCalledWith(malformed);
      expect((session.history[0].content as any[])[0]).toMatchObject({
        audio: 'AQID',
        transcript: 'valid transcript',
      });
      expect(onError).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(() => session.sendText('still usable')).not.toThrow();
    } finally {
      await session.close();
    }
  },
);
