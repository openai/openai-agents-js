/// <reference lib="dom" />

export { EventEmitter, EventEmitterEvents } from './interface';
import { EventEmitter, Timeout, Timer } from './interface';

// Use function instead of exporting the value to prevent
// circular dependency resolution issues caused by other exports in '@openai/agents-core/_shims'
export function loadEnv(): Record<string, string | undefined> {
  return {};
}

type EventMap = Record<string, any[]>;

export class BrowserEventEmitter<
  EventTypes extends EventMap = Record<string, any[]>,
> implements EventEmitter<EventTypes>
{
  #target = new EventTarget();
  #listenerWrappers = new Map<
    string,
    Map<(...args: EventTypes[any]) => void, Set<EventListener>>
  >();

  on<K extends keyof EventTypes>(
    type: K,
    listener: (...args: EventTypes[K]) => void,
  ) {
    const eventType = type as string;
    let listenersForType = this.#listenerWrappers.get(eventType);
    if (!listenersForType) {
      listenersForType = new Map();
      this.#listenerWrappers.set(eventType, listenersForType);
    }
    let wrappers = listenersForType.get(listener);
    if (!wrappers) {
      wrappers = new Set();
      listenersForType.set(listener, wrappers);
    }
    const wrapper = ((event: CustomEvent) =>
      listener(...(event.detail ?? []))) as EventListener;
    wrappers.add(wrapper);
    this.#target.addEventListener(eventType, wrapper);
    return this;
  }

  off<K extends keyof EventTypes>(
    type: K,
    listener: (...args: EventTypes[K]) => void,
  ) {
    const eventType = type as string;
    const listenersForType = this.#listenerWrappers.get(eventType);
    const wrappers = listenersForType?.get(listener);
    if (wrappers?.size) {
      for (const wrapper of wrappers) {
        this.#target.removeEventListener(eventType, wrapper);
      }
      listenersForType?.delete(listener);
      if (listenersForType?.size === 0) {
        this.#listenerWrappers.delete(eventType);
      }
    }
    return this;
  }

  emit<K extends keyof EventTypes>(type: K, ...args: EventTypes[K]) {
    const event = new CustomEvent(type as string, { detail: args });
    return this.#target.dispatchEvent(event);
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

export { BrowserEventEmitter as RuntimeEventEmitter };

export const randomUUID: () => `${string}-${string}-${string}-${string}-${string}` =
  () => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(
      /[xy]/g,
      function (c) {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      },
    ) as `${string}-${string}-${string}-${string}-${string}`;
  };
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
export const ReadableStream = globalThis.ReadableStream;
export const ReadableStreamController =
  globalThis.ReadableStreamDefaultController;
export const TransformStream = globalThis.TransformStream;

export class AsyncLocalStorage {
  context = null;
  constructor() {}
  run(context: any, fn: () => any) {
    this.context = context;
    return fn();
  }
  getStore() {
    return this.context;
  }
  enterWith(context: any) {
    this.context = context;
  }
}

export function isBrowserEnvironment(): boolean {
  return true;
}

export function isTracingLoopRunningByDefault(): boolean {
  return false;
}

export {
  MCPServerStdio,
  MCPServerStreamableHttp,
  MCPServerSSE,
} from './mcp-server/browser';

class BrowserTimer implements Timer {
  constructor() {}
  setTimeout(callback: () => void, ms: number): Timeout {
    const timeout = setTimeout(callback, ms);
    timeout.ref =
      typeof timeout.ref === 'function' ? timeout.ref : () => timeout;
    timeout.unref =
      typeof timeout.unref === 'function' ? timeout.unref : () => timeout;
    timeout.hasRef =
      typeof timeout.hasRef === 'function' ? timeout.hasRef : () => true;
    timeout.refresh =
      typeof timeout.refresh === 'function' ? timeout.refresh : () => timeout;
    return timeout;
  }
  clearTimeout(timeoutId: Timeout | string | number | undefined) {
    window.clearTimeout(timeoutId as number);
  }
}
const timer = new BrowserTimer();
export { timer };
