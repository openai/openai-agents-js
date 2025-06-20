/// <reference lib="dom" />

export { EventEmitter, EventEmitterEvents } from './interface';
import { EventEmitter, Timeout, Timer } from './interface';

// Use function instead of exporting the value to prevent
// circular dependency resolution issues caused by other exports in '@chollier/agents-core/_shims'
export function loadEnv(): Record<string, string | undefined> {
  // In React Native, use global environment variables if available
  if (typeof global !== 'undefined' && global.process && global.process.env) {
    return global.process.env;
  }
  return {};
}

type EventMap = Record<string, any[]>;

export class ReactNativeEventEmitter<
  EventTypes extends EventMap = Record<string, any[]>,
> implements EventEmitter<EventTypes>
{
  #listeners = new Map<keyof EventTypes, Set<(...args: any[]) => void>>();

  on<K extends keyof EventTypes>(
    type: K,
    listener: (...args: EventTypes[K]) => void,
  ) {
    if (!this.#listeners.has(type)) {
      this.#listeners.set(type, new Set());
    }
    this.#listeners.get(type)!.add(listener);
    return this;
  }

  off<K extends keyof EventTypes>(
    type: K,
    listener: (...args: EventTypes[K]) => void,
  ) {
    const listeners = this.#listeners.get(type);
    if (listeners) {
      listeners.delete(listener);
    }
    return this;
  }

  emit<K extends keyof EventTypes>(type: K, ...args: EventTypes[K]) {
    const listeners = this.#listeners.get(type);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(...args);
        } catch (error) {
          console.error('Error in event listener:', error);
        }
      }
      return listeners.size > 0;
    }
    return false;
  }

  once<K extends keyof EventTypes>(
    type: K,
    listener: (...args: EventTypes[K]) => void,
  ) {
    const handler = (...args: EventTypes[K]) => {
      this.off(type, handler);
      listener(...args);
    };
    this.on(type, handler);
    return this;
  }
}

export { ReactNativeEventEmitter as RuntimeEventEmitter };

// React Native crypto support
export const randomUUID = (() => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID.bind(crypto);
  }
  // Fallback implementation for React Native
  return () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(
      /[xy]/g,
      function (c) {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      },
    );
  };
})();

// Basic Readable stream implementation for React Native
export const Readable = class Readable {
  constructor() {}
  pipeTo(
    _destination: WritableStream,
    _options?: {
      preventClose?: boolean;
      preventAbort?: boolean;
      preventCancel?: boolean;
    },
  ) {}
  pipeThrough(
    _transform: TransformStream,
    _options?: {
      preventClose?: boolean;
      preventAbort?: boolean;
      preventCancel?: boolean;
    },
  ) {}
};

// Use global streams if available
export const ReadableStream = globalThis.ReadableStream;
export const ReadableStreamController =
  globalThis.ReadableStreamDefaultController;
export const TransformStream = globalThis.TransformStream;

// AsyncLocalStorage implementation for React Native
export class AsyncLocalStorage<T = any> {
  private context: T | null = null;

  constructor() {}

  run<R>(context: T, fn: () => R): R {
    const previousContext = this.context;
    this.context = context;
    try {
      return fn();
    } finally {
      this.context = previousContext;
    }
  }

  getStore(): T | undefined {
    return this.context ?? undefined;
  }

  enterWith(context: T) {
    this.context = context;
  }
}

export function isBrowserEnvironment(): boolean {
  return false;
}

export function isTracingLoopRunningByDefault(): boolean {
  return false;
}

/**
 * Indicates a React Native environment.
 */
export function isReactNative(): boolean {
  return true;
}

// React Native doesn't typically use MCP servers, so provide stub implementations
export class MCPServerStdio {
  constructor(_params: any) {
    throw new Error(
      'MCP Server functionality is not available in React Native environment',
    );
  }
}

export class MCPServerStreamableHttp {
  constructor(_params: any) {
    throw new Error(
      'MCP Server functionality is not available in React Native environment',
    );
  }
}

class ReactNativeTimer implements Timer {
  constructor() {}
  setTimeout(callback: () => void, ms: number): Timeout {
    const timeout = setTimeout(callback, ms) as any;
    // Add Node.js-like methods to the timeout object for compatibility
    timeout.ref = () => timeout;
    timeout.unref = () => timeout;
    timeout.hasRef = () => true;
    timeout.refresh = () => timeout;
    return timeout;
  }
  clearTimeout(timeoutId: Timeout | string | number | undefined) {
    clearTimeout(timeoutId as number);
  }
}
const timer = new ReactNativeTimer();
export { timer };
