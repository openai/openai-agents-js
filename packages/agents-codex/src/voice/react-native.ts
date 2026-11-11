export {
  backgroundResult,
  type BackgroundResult,
} from '../runtime/background-result';
import type { PortableVoiceApiKey } from './portable-credentials';
export type { PortableVoiceApiKey } from './portable-credentials';
export {
  PortableVoiceControlBinding,
  type PortableVoiceControlExports,
} from './portable-binding';
import { connectPortableVoiceWebRTC } from './portable-webrtc';
import type {
  PortableVoiceControl,
  PortableVoiceOptions,
  PortableVoiceSession,
} from './portable-session';
export type {
  PortableVoiceControl,
  PortableVoiceOptions,
  PortableVoiceTool,
  PortableVoiceContext,
  PortableVoiceToolContext,
  PortableVoiceHandoff,
  PortableHistoryUpdate,
} from './portable-session';
export { PortableVoiceSession } from './portable-session';
import { NativeVoiceMedia } from './webrtc';
import type {
  NativeVoiceMediaStream,
  NativeVoicePeerConnection,
} from './webrtc';
export type {
  VoiceSdpExchange,
  NativeVoiceMediaStream,
  NativeVoiceMediaTrack,
  NativeVoicePeerConnection,
} from './webrtc';

export interface NativeVoiceWebRTCOptions<
  Stream extends NativeVoiceMediaStream,
> {
  /** The application acquires, owns and stops its microphone tracks. */
  mediaStream: Stream;
  /** Supply the application's react-native-webrtc peer; no global shim is needed. */
  createPeerConnection: () => NativeVoicePeerConnection;
  /** Native WebRTC handles audio; the application owns routing and audio sessions. */
  onRemoteStream: (stream: Stream) => void | Promise<void>;
  onTransportEvent?: (event: unknown) => void;
  onError?: (error: Error) => void;
}

export type NativeVoiceTextWebRTCOptions = Omit<
  NativeVoiceWebRTCOptions<NativeVoiceMediaStream>,
  'mediaStream' | 'onRemoteStream'
> & {
  /** Use the WebRTC data channel without acquiring or playing audio. */
  enableAudio: false;
};

/** Mobile media with app-owned microphone tracks and audio routing. */
export class NativeVoiceWebRTC<
  Stream extends NativeVoiceMediaStream,
> extends NativeVoiceMedia<Stream> {
  constructor(
    options: NativeVoiceWebRTCOptions<Stream> | NativeVoiceTextWebRTCOptions,
  ) {
    const captured = { ...options };
    super(
      'onRemoteStream' in captured
        ? { ...captured, play: captured.onRemoteStream }
        : captured,
    );
  }
}

/** Direct voice with an app-owned WebRTC peer and Rust control.
 * createHermesVoiceControl() from voice/control.hermes supplies the SDK's bundled
 * lowering on hosts without WebAssembly; an on-device binding also implements control.
 * For text-only sessions, set media.enableAudio to false and set
 * agent.settings.output_modalities to ['text'].
 */
export function connectPortableVoiceReactNative<
  Stream extends NativeVoiceMediaStream,
>(options: {
  control: PortableVoiceControl;
  apiKey: PortableVoiceApiKey;
  useInsecureApiKey?: boolean;
  agent: PortableVoiceOptions;
  media: NativeVoiceWebRTCOptions<Stream> | NativeVoiceTextWebRTCOptions;
  callUrl?: string;
  signal?: AbortSignal;
}): Promise<{
  session: PortableVoiceSession;
  media: NativeVoiceWebRTC<Stream>;
}> {
  return connectPortableVoiceWebRTC(
    options,
    (callbacks) => new NativeVoiceWebRTC({ ...options.media, ...callbacks }),
  );
}
