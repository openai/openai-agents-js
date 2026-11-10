/** Copy this helper into a React Native application with react-native-webrtc.
 * The application installs its native module and handles microphone permission,
 * speaker routing and mobile audio-session activation. No global shim is needed.
 *
 * import { RTCPeerConnection, mediaDevices } from 'react-native-webrtc';
 * const call = await connectReactNativeVoice({
 *   webRTC: { RTCPeerConnection, mediaDevices },
 *   endpoint: 'https://your-app.example/voice/sdp',
 *   appToken: applicationSessionToken,
 *   onRemoteStream: (stream) => setRemoteStream(stream),
 * });
 * // On screen teardown, call.close() closes media and releases its microphone.
 *
 * The authenticated Node endpoint must keep its native Session/control alive and
 * return answer SDP only after Session.realtime({transport:{type:'webrtc',offerSdp}})
 * resolves. Provider credentials and tool execution stay on that server.
 */
import {
  NativeVoiceWebRTC,
  type NativeVoiceMediaStream,
  type NativeVoicePeerConnection,
} from '@openai/agents/voice/react-native';

export async function connectReactNativeVoice<
  Stream extends NativeVoiceMediaStream,
>(options: {
  webRTC: {
    RTCPeerConnection: new () => NativeVoicePeerConnection;
    mediaDevices: {
      getUserMedia(constraints: { audio: true; video: false }): Promise<Stream>;
    };
  };
  endpoint: string;
  appToken: string;
  onRemoteStream: (stream: Stream) => void | Promise<void>;
}) {
  const microphone = await options.webRTC.mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });
  const media = new NativeVoiceWebRTC({
    mediaStream: microphone,
    createPeerConnection: () => new options.webRTC.RTCPeerConnection(),
    onRemoteStream: options.onRemoteStream,
    onError: () => {
      for (const track of microphone.getTracks()) track.stop();
    },
  });
  const close = () => {
    try {
      media.close();
    } finally {
      for (const track of microphone.getTracks()) track.stop();
    }
  };
  try {
    await media.connect({
      exchangeSdp: async (offerSdp, signal) => {
        const response = await fetch(options.endpoint, {
          method: 'POST',
          signal,
          headers: {
            Authorization: `Bearer ${options.appToken}`,
            'Content-Type': 'application/sdp',
          },
          body: offerSdp,
        });
        if (!response.ok)
          throw new Error(`Voice SDP exchange failed (${response.status})`);
        return response.text();
      },
    });
    return { media, close };
  } catch (error) {
    try {
      close();
    } catch {
      /* Preserve the connection error. */
    }
    throw error;
  }
}
