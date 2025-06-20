import { getPlatformAPIs } from '../platform';

const { WebSocket: overrideWebSocket } = getPlatformAPIs();
export const WebSocket = overrideWebSocket ?? require('ws').WebSocket;
export function isBrowserEnvironment(): boolean {
  return false;
}
/**
 * React Native is not a browser environment.
 */
export function isReactNative(): boolean {
  return false;
}
