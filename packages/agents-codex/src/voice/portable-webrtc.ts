import {
  resolvePortableVoiceApiKey,
  type PortableVoiceApiKey,
} from './portable-credentials';
import {
  PortableVoiceSession,
  type PortableVoiceControl,
  type PortableVoiceOptions,
} from './portable-session';
import {
  listenVoiceChannel,
  type NativeVoiceDataChannel,
  type VoiceSdpExchange,
} from './webrtc';

interface PortableVoiceDataChannel extends NativeVoiceDataChannel {
  readonly readyState: string;
  send(frame: string): void;
}
interface MediaCallbacks {
  onDataChannel(channel: NativeVoiceDataChannel): void;
  onTransportEvent(event: unknown): void;
  onError(error: Error): void;
}
interface MediaConnection {
  connect(options: { exchangeSdp: VoiceSdpExchange }): Promise<void>;
  close(): void;
}
/** Shared direct-client connection; media and Rust control stay application-owned. */
export async function connectPortableVoiceWebRTC<Media extends MediaConnection>(
  options: {
    control: PortableVoiceControl;
    apiKey: PortableVoiceApiKey;
    useInsecureApiKey?: boolean;
    agent: PortableVoiceOptions;
    media: {
      enableAudio?: false;
      onDataChannel?: (channel: NativeVoiceDataChannel) => void;
      onTransportEvent?: (event: unknown) => void;
      onError?: (error: Error) => void;
    };
    callUrl?: string;
    signal?: AbortSignal;
  },
  createMedia: (callbacks: MediaCallbacks) => Media,
): Promise<{ session: PortableVoiceSession; media: Media }> {
  if (options.signal?.aborted)
    throw options.signal.reason ?? new Error('Voice connection aborted.');
  const apiKey = await resolvePortableVoiceApiKey(
    options.apiKey,
    options.signal,
  );
  if (options.signal?.aborted)
    throw options.signal.reason ?? new Error('Voice connection aborted.');
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]+$/.test(apiKey))
    throw new TypeError(
      'Voice credential must be nonempty text without whitespace or control characters.',
    );
  const isClientKey = apiKey.startsWith('ek_') && apiKey.length > 3;
  if (!isClientKey && options.useInsecureApiKey !== true)
    throw new TypeError(
      'Browser voice requires an ephemeral client key. To explicitly use a regular API key, set useInsecureApiKey: true.',
    );
  const sessionConfig = isClientKey
    ? undefined
    : JSON.stringify({ type: 'realtime', model: options.agent.model });
  const endpoint = new URL(
    options.callUrl ?? 'https://api.openai.com/v1/realtime/calls',
  );
  if (endpoint.protocol !== 'https:')
    throw new TypeError('Provider call URL must use https.');
  let channel: PortableVoiceDataChannel | undefined;
  let removeOpenListener: (() => void) | undefined;
  let openResolve!: () => void;
  let openReject!: (error: unknown) => void;
  const opened = new Promise<void>((resolve, reject) => {
    openResolve = resolve;
    openReject = reject;
  });
  void opened.catch(() => {});
  const session = new PortableVoiceSession(
    options.control,
    {
      clearOutputAudioOnInterrupt: options.media.enableAudio !== false,
      async send(frame) {
        await opened;
        if (!channel || channel.readyState !== 'open')
          throw new Error('Voice data channel is not open.');
        channel.send(frame);
      },
      close() {
        openReject(new Error('Voice data channel closed.'));
        removeOpenListener?.();
        removeOpenListener = undefined;
        options.signal?.removeEventListener('abort', abort);
        media.close();
      },
    },
    options.agent,
  );
  const abort = () =>
    session.fail(
      options.signal?.reason ?? new Error('Voice connection aborted.'),
    );
  const media = createMedia({
    onDataChannel(dataChannel) {
      channel = dataChannel as PortableVoiceDataChannel;
      removeOpenListener = listenVoiceChannel(channel, 'open', openResolve);
      if (channel.readyState === 'open') openResolve();
      options.media.onDataChannel?.(channel);
    },
    onTransportEvent(event) {
      session.receive(event);
      return options.media.onTransportEvent?.(event);
    },
    onError(error) {
      session.fail(error);
      return options.media.onError?.(error);
    },
  });
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    await media.connect({
      exchangeSdp: async (offer, signal) => {
        let body: string | FormData = offer;
        if (!isClientKey) {
          body = new FormData();
          body.set('sdp', offer);
          body.set('session', sessionConfig!);
        }
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            ...(isClientKey ? { 'Content-Type': 'application/sdp' } : {}),
          },
          body,
          signal,
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Voice SDP exchange failed (${response.status}).`);
        }
        return response.text();
      },
    });
    await session.start();
    return { session, media };
  } catch (error) {
    try {
      await session.close();
    } catch {
      // Preserve the opening error while releasing the acquired media.
    }
    throw error;
  }
}
