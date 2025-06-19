/// <reference lib="dom" />

export const WebSocket = globalThis.WebSocket;
export function isBrowserEnvironment(): boolean {
  return true;
}
export const useWebSocketProtocols = true;
