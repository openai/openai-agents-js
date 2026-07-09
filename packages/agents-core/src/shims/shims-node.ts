import { Timeout, Timer } from './interface';

export { EventEmitter, EventEmitterEvents } from './interface';
export { EventEmitter as RuntimeEventEmitter } from 'node:events';
export { isBrowserEnvironment, loadEnv } from './config-node';

export { randomUUID } from 'node:crypto';
export { Readable } from 'node:stream';
export {
  ReadableStream,
  ReadableStreamController,
  TransformStream,
} from 'node:stream/web';
export { AsyncLocalStorage } from 'node:async_hooks';

export function isTracingLoopRunningByDefault(): boolean {
  return true;
}

export {
  NodeMCPServerStdio as MCPServerStdio,
  NodeMCPServerStreamableHttp as MCPServerStreamableHttp,
  NodeMCPServerSSE as MCPServerSSE,
} from './mcp-server/node';

export { clearTimeout } from 'node:timers';

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
