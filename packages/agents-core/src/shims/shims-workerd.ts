import * as process from 'process';
import { AsyncLocalStorage as BuiltinAsyncLocalStorage } from 'async_hooks';
export { EventEmitter as RuntimeEventEmitter } from 'events';

import { Timeout, Timer } from './interface';
export { EventEmitter, EventEmitterEvents } from './interface';

declare global {
  interface ImportMeta {
    env?: Record<string, string | undefined>;
  }
}

// Use function instead of exporting the value to prevent
// circular dependency resolution issues caused by other exports in '@chollier/agents-core/_shims'
export function loadEnv(): Record<string, string | undefined> {
  if (typeof process === 'undefined' || typeof process.env === 'undefined') {
    if (
      typeof import.meta === 'object' &&
      typeof import.meta.env === 'object'
    ) {
      return import.meta.env as unknown as Record<string, string | undefined>;
    }
    return {};
  }
  return process.env;
}

export { randomUUID } from 'crypto';
export { Readable } from 'stream';

export const ReadableStream = globalThis.ReadableStream;
export const ReadableStreamController =
  globalThis.ReadableStreamDefaultController;
export const TransformStream = globalThis.TransformStream;

export class AsyncLocalStorage<T> extends BuiltinAsyncLocalStorage<T> {
  enterWith(context: T) {
    // Cloudflare workers does not support enterWith, so we need to use run instead
    super.run(context, () => {});
  }
}

export function isBrowserEnvironment(): boolean {
  return false;
}

export function isTracingLoopRunningByDefault(): boolean {
  // Cloudflare workers does not support triggering things like setTimeout outside of the
  // request context. So we don't run the trace export loop by default.
  return false;
}

/**
 * Right now Cloudflare Workers does not support MCP
 */
export { MCPServerStdio, MCPServerStreamableHttp } from './mcp-server/browser';

export { clearTimeout, setTimeout } from 'timers';

class NodeTimer implements Timer {
  constructor() {}
  setTimeout(callback: () => any, ms: number): Timeout {
    return setTimeout(callback, ms);
  }
  clearTimeout(timeoutId: Timeout | string | number | undefined) {
    clearTimeout(timeoutId as NodeJS.Timeout);
  }
}
const timer = new NodeTimer();
export { timer };
