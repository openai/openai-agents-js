import { NativeVoiceMedia } from './webrtc';
import {
  NativeVoiceControl,
  PortableVoiceSession,
  type PortableVoiceOptions,
} from './portable';
export type { VoiceSdpExchange } from './webrtc';

export interface NativeVoiceWebRTCOptions {
  audioElement?: Pick<HTMLMediaElement, 'play' | 'srcObject'>;
  createPeerConnection?: () => RTCPeerConnection | Promise<RTCPeerConnection>;
  getUserMedia?: () => Promise<MediaStream>;
  onRemoteStream?: (stream: MediaStream) => void;
  onDataChannel?: (channel: RTCDataChannel) => void;
  /** Supplied tracks remain owned by the application after close. */
  mediaStream?: MediaStream;
  /** Provider observations confer no native tool or approval authority. */
  onTransportEvent?: (event: unknown) => void;
  onError?: (error: Error) => void;
}

/** Browser media only; the application server owns native voice control.
 * Each instance owns one connection attempt. Create a new instance after close.
 */
export class NativeVoiceWebRTC extends NativeVoiceMedia<MediaStream> {
  constructor(options: NativeVoiceWebRTCOptions) {
    const captured = { ...options };
    super({
      ...captured,
      acquireMedia: () =>
        captured.getUserMedia?.() ??
        navigator.mediaDevices.getUserMedia({
          audio: {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true,
          },
          video: false,
        }),
      createPeerConnection: () =>
        captured.createPeerConnection?.() ?? new RTCPeerConnection(),
      onDataChannel: (channel) =>
        captured.onDataChannel?.(channel as RTCDataChannel),
      play: async (stream) => {
        captured.onRemoteStream?.(stream);
        if (captured.audioElement) {
          captured.audioElement.srcObject = stream;
          await captured.audioElement.play();
        }
      },
      clear: (stream) => {
        if (captured.audioElement?.srcObject === stream)
          captured.audioElement.srcObject = null;
      },
    });
  }
}

/** Browser-hosted Rust control over the provider's WebRTC data channel.
 * Supply a short-lived client credential and the reviewed native control module.
 */
export async function connectPortableVoiceBrowser(options: {
  control: NativeVoiceControl;
  apiKey: string;
  /** Explicitly allow a regular API key in this browser-owned connection. */
  useInsecureApiKey?: boolean;
  agent: PortableVoiceOptions;
  media: NativeVoiceWebRTCOptions;
  callUrl?: string;
  signal?: AbortSignal;
}): Promise<{ session: PortableVoiceSession; media: NativeVoiceWebRTC }> {
  options.signal?.throwIfAborted();
  const apiKey = options.apiKey;
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
  let channel: RTCDataChannel | undefined;
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
      async send(frame) {
        await opened;
        if (!channel || channel.readyState !== 'open')
          throw new Error('Voice data channel is not open.');
        channel.send(frame);
      },
      close() {
        openReject(new Error('Voice data channel closed.'));
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
  const media = new NativeVoiceWebRTC({
    ...options.media,
    onDataChannel(dataChannel) {
      channel = dataChannel;
      channel.onopen = () => openResolve();
      if (channel.readyState === 'open') openResolve();
      options.media.onDataChannel?.(channel);
    },
    onTransportEvent(event) {
      session.receive(event);
      options.media.onTransportEvent?.(event);
    },
    onError(error) {
      session.fail(error);
      options.media.onError?.(error);
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
