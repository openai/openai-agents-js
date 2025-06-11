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

  on<K extends keyof EventTypes>(
    type: K,
    listener: (...args: EventTypes[K]) => void,
  ) {
    this.#target.addEventListener(
      type as string,
      ((event: CustomEvent) =>
        listener(...(event.detail ?? []))) as EventListener,
    );
    return this;
  }

  off<K extends keyof EventTypes>(
    type: K,
    listener: (...args: EventTypes[K]) => void,
  ) {
    this.#target.removeEventListener(
      type as string,
      ((event: CustomEvent) =>
        listener(...(event.detail ?? []))) as EventListener,
    );
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

export const randomUUID = crypto.randomUUID.bind(crypto);
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

export { MCPServerStdio, MCPServerStreamableHttp } from './mcp-server/browser';

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
