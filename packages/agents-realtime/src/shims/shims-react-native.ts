/**
 * React Native environment shim for WebSocket and environment detection.
 */
import { getPlatformAPIs } from '../platform';

// Allow override of WebSocket (e.g., custom RN implementation)
const { WebSocket: overrideWebSocket } = getPlatformAPIs();
const RNWebSocket = overrideWebSocket ?? require('react-native').WebSocket;
export const WebSocket = RNWebSocket;

export function isBrowserEnvironment(): boolean {
  return false;
}

/**
 * Indicates a React Native environment.
 */
export function isReactNative(): boolean {
  return true;
}