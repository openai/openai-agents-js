import { describe, expect, it, vi } from 'vitest';
import { createRealtimeCall } from '../src/server/realtimeCall';

const audioSdp = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
].join('\r\n');

function createOptions(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: 'server-key',
    hangupCall: vi.fn(async () => {}),
    model: 'gpt-realtime',
    offerSdp: audioSdp,
    safetyIdentifier: 'safe-user-id',
    voice: 'marin',
    ...overrides,
  };
}

describe('createRealtimeCall', () => {
  it('validates the offer before making a remote request', async () => {
    const fetchImpl = vi.fn();
    const options = createOptions({
      fetchImpl,
      offerSdp: `${audioSdp}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel`,
    });

    await expect(createRealtimeCall(options)).rejects.toThrow(
      'exactly one media description',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(options.hangupCall).not.toHaveBeenCalled();
  });

  it('creates an audio-only call with server credentials', async () => {
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toEqual({
        Authorization: 'Bearer server-key',
        'OpenAI-Safety-Identifier': 'safe-user-id',
      });
      const form = init?.body as FormData;
      expect(form.get('sdp')).toBe(audioSdp);
      expect(JSON.parse(String(form.get('session')))).toMatchObject({
        type: 'realtime',
        model: 'gpt-realtime',
        audio: { output: { voice: 'marin' } },
      });
      return new Response(audioSdp, {
        status: 201,
        headers: { Location: '/v1/realtime/calls/rtc_test-123' },
      });
    }) as typeof fetch;

    await expect(
      createRealtimeCall(createOptions({ fetchImpl })),
    ).resolves.toEqual({ answerSdp: audioSdp, callId: 'rtc_test-123' });
  });

  it('hangs up a created call when the answer violates the policy', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          `${audioSdp}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel`,
          {
            status: 201,
            headers: { Location: '/v1/realtime/calls/rtc_invalid-answer' },
          },
        ),
    ) as typeof fetch;
    const options = createOptions({ fetchImpl });

    await expect(createRealtimeCall(options)).rejects.toThrow(
      'exactly one media description',
    );
    expect(options.hangupCall).toHaveBeenCalledOnce();
    expect(options.hangupCall).toHaveBeenCalledWith('rtc_invalid-answer');
  });

  it('rejects an invalid call location', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(audioSdp, {
          status: 201,
          headers: {
            Location: 'https://example.com/v1/realtime/calls/rtc_test',
          },
        }),
    ) as typeof fetch;

    await expect(
      createRealtimeCall(createOptions({ fetchImpl })),
    ).rejects.toThrow('invalid call location');
  });
});
