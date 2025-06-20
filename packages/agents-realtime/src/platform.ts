/**
 * Platform-specific API overrides for WebSocket, WebRTC, and related globals.
 * Users can inject their own implementations (e.g., React Native bindings) by calling
 * `setPlatformAPIs` before using the realtime session or transport layers.
 */
export type PlatformAPIs = Partial<{
  /** Custom WebSocket constructor (e.g., React Native WebSocket). */
  WebSocket: any;
  /** Custom RTCPeerConnection constructor (e.g., from react-native-webrtc). */
  RTCPeerConnection: any;
  /** Custom RTCSessionDescription constructor (if needed). */
  RTCSessionDescription: any;
  /** Custom RTCIceCandidate constructor (if needed). */
  RTCIceCandidate: any;
  /** Custom mediaDevices implementation for getUserMedia. */
  mediaDevices: any;
  /** Optional function to register globals (e.g., react-native-webrtc registerGlobals). */
  registerGlobals: () => void;
}>

let platformAPIs: PlatformAPIs = {};

/**
 * Override default platform implementations. Call this before creating a RealtimeSession
 * or using any transport layer to inject custom WebSocket, WebRTC, or media bindings.
 */
export function setPlatformAPIs(apis: PlatformAPIs): void {
  platformAPIs = { ...platformAPIs, ...apis };
}

/**
 * Retrieve the current platform API overrides.
 */
export function getPlatformAPIs(): PlatformAPIs {
  return platformAPIs;
}