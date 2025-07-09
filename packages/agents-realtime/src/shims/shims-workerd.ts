export const WebSocket = globalThis.WebSocket;
export function isBrowserEnvironment(): boolean {
  return false;
}
export const useWebSocketProtocols = true;

export const RTCPeerConnection =
  undefined as unknown as typeof globalThis.RTCPeerConnection;
export const RTCIceCandidate =
  undefined as unknown as typeof globalThis.RTCIceCandidate;
export const RTCSessionDescription =
  undefined as unknown as typeof globalThis.RTCSessionDescription;
export const MediaStream =
  undefined as unknown as typeof globalThis.MediaStream;
export const MediaStreamTrack =
  undefined as unknown as typeof globalThis.MediaStreamTrack;
export const mediaDevices = undefined as unknown as MediaDevices;
