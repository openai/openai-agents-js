import { NativeVoiceMedia } from './webrtc';
export type { VoiceSdpExchange } from './webrtc';

export interface NativeVoiceWebRTCOptions {
  audioElement: Pick<HTMLMediaElement, 'play' | 'srcObject'>;
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
        navigator.mediaDevices.getUserMedia({
          audio: {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true,
          },
          video: false,
        }),
      createPeerConnection: () => new RTCPeerConnection(),
      play: async (stream) => {
        captured.audioElement.srcObject = stream;
        await captured.audioElement.play();
      },
      clear: (stream) => {
        if (captured.audioElement.srcObject === stream)
          captured.audioElement.srcObject = null;
      },
    });
  }
}
