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

/** Mobile media only. Session, tool execution and credentials remain on the server. */
export class NativeVoiceWebRTC<
  Stream extends NativeVoiceMediaStream,
> extends NativeVoiceMedia<Stream> {
  constructor(options: NativeVoiceWebRTCOptions<Stream>) {
    const captured = { ...options };
    super({ ...captured, play: captured.onRemoteStream });
  }
}
