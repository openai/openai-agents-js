export {
  backgroundResult,
  type BackgroundResult,
} from '../runtime/background-result';
import type { PortableVoiceApiKey } from './portable-credentials';
export type { PortableVoiceApiKey } from './portable-credentials';
import { NativeVoiceMedia } from './webrtc';
import { connectPortableVoiceWebRTC } from './portable-webrtc';
import type {
  PortableVoiceControl,
  PortableVoiceOptions,
  PortableVoiceSession,
} from './portable-session';
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

/** Browser media and peer ownership; voice control is supplied separately.
 * Each instance owns one connection attempt. Create a new instance after close.
 */
export class NativeVoiceWebRTC extends NativeVoiceMedia<MediaStream> {
  constructor(options: NativeVoiceWebRTCOptions) {
    const captured = { ...options };
    // An explicit remote-stream handler owns playback; otherwise provide audio.
    let audio = captured.audioElement;
    let playbackRevision = 0;
    let attachedStream: MediaStream | undefined;
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
        const revision = ++playbackRevision;
        try {
          if (captured.onRemoteStream) await captured.onRemoteStream(stream);
          if (this.status === 'closed' || revision !== playbackRevision) return;
          if (!audio && !captured.onRemoteStream)
            audio = document.createElement('audio');
          if (audio) {
            audio.srcObject = stream;
            attachedStream = stream;
            await audio.play();
          }
        } catch (error) {
          if (revision === playbackRevision) throw error;
        }
      },
      clear: () => {
        playbackRevision++;
        if (audio && audio.srcObject === attachedStream) audio.srcObject = null;
        attachedStream = undefined;
      },
    });
  }
}

/** Browser-hosted Rust control over the provider's WebRTC data channel.
 * Supply a short-lived client credential and the reviewed native control module.
 */
export function connectPortableVoiceBrowser(options: {
  control: PortableVoiceControl;
  apiKey: PortableVoiceApiKey;
  /** Explicitly allow a regular API key in this browser-owned connection. */
  useInsecureApiKey?: boolean;
  agent: PortableVoiceOptions;
  media: NativeVoiceWebRTCOptions;
  callUrl?: string;
  signal?: AbortSignal;
}): Promise<{ session: PortableVoiceSession; media: NativeVoiceWebRTC }> {
  return connectPortableVoiceWebRTC(
    {
      ...options,
      media: {
        ...options.media,
        onDataChannel: (channel) =>
          options.media.onDataChannel?.(channel as RTCDataChannel),
      },
    },
    (callbacks) => new NativeVoiceWebRTC({ ...options.media, ...callbacks }),
  );
}
