import * as process from 'node:process';
import { AsyncLocalStorage as BuiltinAsyncLocalStorage } from 'node:async_hooks';
export { EventEmitter as RuntimeEventEmitter } from 'node:events';

import { Timeout, Timer } from './interface';
export { EventEmitter, EventEmitterEvents } from './interface';

declare global {
  interface ImportMeta {
    env?: Record<string, string | undefined>;
  }
}

// Use function instead of exporting the value to prevent
// circular dependency resolution issues caused by other exports in '@openai/agents-core/_shims'
export function loadEnv(): Record<string, string | undefined> {
  if (typeof process === 'undefined' || typeof process.env === 'undefined') {
    // In CommonJS builds, import.meta is not available, so we return empty object
    try {
      // Use eval to avoid TypeScript compilation errors in CommonJS builds
      const importMeta = (0, eval)('import.meta');
      if (
        typeof importMeta === 'object' &&
        typeof importMeta.env === 'object'
      ) {
        return importMeta.env as unknown as Record<string, string | undefined>;
      }
    } catch {
      // import.meta not available (CommonJS build)
    }
    return {};
  }
  return process.env;
}

export { randomUUID } from 'node:crypto';
export { Readable } from 'node:stream';

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
 * Use the Node versions of MCP helpers
 */
export {
  NodeMCPServerStdio as MCPServerStdio,
  NodeMCPServerStreamableHttp as MCPServerStreamableHttp,
  NodeMCPServerSSE as MCPServerSSE,
} from './mcp-server/node';

export { clearTimeout, setTimeout } from 'node:timers';

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
