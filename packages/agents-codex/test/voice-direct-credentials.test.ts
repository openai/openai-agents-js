import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectPortableVoiceBrowser } from '@openai/agents/voice/browser';
import { connectPortableVoiceReactNative } from '@openai/agents/voice/react-native';
import { connectPortableVoiceWorker } from '@openai/agents/voice/workerd';
import {
  connectPortableVoiceWebSocket,
  type PortableVoiceApiKey,
} from '@openai/agents/voice/portable';

const hosts = ['browser', 'mobile', 'worker', 'socket'] as const;
function fixture(host: (typeof hosts)[number]) {
  const failure = new Error('Transport acquisition boundary');
  const acquire = vi.fn(() => {
    throw failure;
  });
  const apply = vi.fn(() => []);
  const control = { apply };
  const agent = { model: 'test', instructions: 'Help' };
  const track = Object.assign(new EventTarget(), {
    readyState: 'live',
    enabled: true,
    stop: vi.fn(),
  });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  vi.stubGlobal('fetch', acquire);
  return {
    failure,
    acquire,
    apply,
    open(apiKey: PortableVoiceApiKey, signal?: AbortSignal) {
      const options = { control, agent, apiKey, signal };
      if (host === 'browser')
        return connectPortableVoiceBrowser({
          ...options,
          media: {
            mediaStream: stream as unknown as MediaStream,
            createPeerConnection: acquire,
          },
        });
      if (host === 'mobile')
        return connectPortableVoiceReactNative({
          ...options,
          media: {
            mediaStream: stream,
            createPeerConnection: acquire,
            onRemoteStream() {},
          },
        });
      if (host === 'worker') return connectPortableVoiceWorker(options);
      return connectPortableVoiceWebSocket({
        ...options,
        createWebSocket: acquire,
      });
    },
  };
}

afterEach(() => vi.unstubAllGlobals());
describe.each(hosts)('direct %s per-connection credentials', (host) => {
  it.each([false, true])(
    'resolves one credential callback before transport acquisition (async=%s)',
    async (async) => {
      const test = fixture(host);
      const signal = new AbortController().signal;
      const credential = vi.fn(() =>
        async ? Promise.resolve('ek_synthetic-client') : 'ek_synthetic-client',
      );
      await expect(test.open(credential, signal)).rejects.toBe(test.failure);
      expect(credential).toHaveBeenCalledExactlyOnceWith(signal);
      expect(test.acquire).toHaveBeenCalledOnce();
    },
  );

  it('preserves credential rejection before any native, transport or media acquisition', async () => {
    const test = fixture(host);
    const rejection = new Error('Credential resolver failed');
    const credential = vi.fn(async () => {
      throw rejection;
    });
    await expect(test.open(credential)).rejects.toBe(rejection);
    expect(credential).toHaveBeenCalledOnce();
    expect(test.acquire).not.toHaveBeenCalled();
    expect(test.apply).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)(
    'retires a pending credential wait and ignores late %s after abort',
    async (settlement) => {
      const test = fixture(host);
      const controller = new AbortController();
      const pending = Promise.withResolvers<string>();
      const credential = vi.fn(() => pending.promise);
      const opening = test.open(credential, controller.signal);
      await vi.waitFor(() => expect(credential).toHaveBeenCalledOnce());
      const reason = new Error('Credential acquisition aborted');
      controller.abort(reason);
      await expect(opening).rejects.toBe(reason);
      if (settlement === 'resolve') pending.resolve('ek_synthetic-late');
      else pending.reject(new Error('Late credential failure'));
      await Promise.resolve();
      expect(test.acquire).not.toHaveBeenCalled();
      expect(test.apply).not.toHaveBeenCalled();
    },
  );

  it('does not invoke a resolver after cancellation', async () => {
    const test = fixture(host);
    const controller = new AbortController();
    controller.abort(new Error('Already aborted'));
    const credential = vi.fn(() => 'ek_synthetic-client');
    await expect(test.open(credential, controller.signal)).rejects.toThrow(
      'Already aborted',
    );
    expect(credential).not.toHaveBeenCalled();
    expect(test.acquire).not.toHaveBeenCalled();
  });
});

it.each(['browser', 'mobile'] as const)(
  'preserves %s ephemeral-key validation after callback resolution',
  async (host) => {
    const test = fixture(host);
    const credential = vi.fn(async () => 'sk_synthetic-private');
    await expect(test.open(credential)).rejects.toThrow(/ephemeral client key/);
    expect(credential).toHaveBeenCalledOnce();
    expect(test.acquire).not.toHaveBeenCalled();
    expect(test.apply).not.toHaveBeenCalled();
  },
);
