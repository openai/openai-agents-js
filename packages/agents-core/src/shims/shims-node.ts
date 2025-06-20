import { Timeout, Timer } from './interface';

export { EventEmitter, EventEmitterEvents } from './interface';
export { EventEmitter as RuntimeEventEmitter } from 'events';

declare global {
  interface ImportMeta {
    env?: Record<string, string | undefined>;
  }
}

// Use function instead of exporting the value to prevent
// circular dependency resolution issues caused by other exports in '@chollier/agents-core/_shims'
export function loadEnv(): Record<string, string | undefined> {
  // Check if we're in a Node.js environment
  if (typeof process !== 'undefined' && typeof process.env !== 'undefined') {
    return process.env;
  }

  if (typeof import.meta === 'object' && typeof import.meta.env === 'object') {
    return import.meta.env as unknown as Record<string, string | undefined>;
  }
  return {};
}

export { randomUUID } from 'crypto';
export { Readable } from 'stream';
export {
  ReadableStream,
  ReadableStreamController,
  TransformStream,
} from 'stream/web';
export { AsyncLocalStorage } from 'async_hooks';

export function isTracingLoopRunningByDefault(): boolean {
  return true;
}

export function isBrowserEnvironment(): boolean {
  return false;
}
export {
  NodeMCPServerStdio as MCPServerStdio,
  NodeMCPServerStreamableHttp as MCPServerStreamableHttp,
} from './mcp-server/node';

export { clearTimeout } from 'timers';

class NodeTimer implements Timer {
  constructor() {}
  setTimeout(callback: () => void, ms: number): Timeout {
    return setTimeout(callback, ms);
  }
  clearTimeout(timeoutId: Timeout | string | number | undefined) {
    clearTimeout(timeoutId as NodeJS.Timeout);
  }
}
const timer = new NodeTimer();
export { timer };
