/// <reference lib="dom" />

import { getPlatformAPIs } from '../platform';

const { WebSocket: overrideWebSocket } = getPlatformAPIs();
export const WebSocket = overrideWebSocket ?? globalThis.WebSocket;
export function isBrowserEnvironment(): boolean {
  return true;
}
/**
 * React Native is not a browser environment.
 */
export function isReactNative(): boolean {
  return false;
}
