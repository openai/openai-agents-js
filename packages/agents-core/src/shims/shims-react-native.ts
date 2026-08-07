import type { EventEmitter, Timeout, Timer } from './interface';

export type { EventEmitter, EventEmitterEvents } from './interface';
export { isBrowserEnvironment, loadEnv } from './config-browser';
export {
  AsyncLocalStorage,
  MCPServerSSE,
  MCPServerStdio,
  MCPServerStreamableHttp,
  Readable,
  ReadableStream,
  ReadableStreamController,
  TransformStream,
  isTracingLoopRunningByDefault,
  randomUUID,
  supportsProcessLifecycleEvents,
} from './shims-browser';

type EventMap = Record<string, any[]>;

/**
 * An event emitter that does not depend on DOM EventTarget or CustomEvent globals.
 */
export class ReactNativeEventEmitter<
  EventTypes extends EventMap = Record<string, any[]>,
> implements EventEmitter<EventTypes> {
  #listeners = new Map<keyof EventTypes, Array<(...args: any[]) => void>>();

  on<K extends keyof EventTypes>(
    type: K,
    listener: (...args: EventTypes[K]) => void,
  ) {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
    return this;
  }

  off<K extends keyof EventTypes>(
    type: K,
    listener: (...args: EventTypes[K]) => void,
  ) {
    const listeners = this.#listeners.get(type);
    if (!listeners) {
      return this;
    }

    const remaining = listeners.filter((candidate) => candidate !== listener);
    if (remaining.length > 0) {
      this.#listeners.set(type, remaining);
    } else {
      this.#listeners.delete(type);
    }
    return this;
  }

  emit<K extends keyof EventTypes>(type: K, ...args: EventTypes[K]) {
    const listeners = [...(this.#listeners.get(type) ?? [])];
    for (const listener of listeners) {
      listener(...args);
    }
    return true;
  }

  once<K extends keyof EventTypes>(
    type: K,
    listener: (...args: EventTypes[K]) => void,
  ) {
    const handler = (...args: EventTypes[K]) => {
      this.off(type, handler);
      listener(...args);
    };
    return this.on(type, handler);
  }
}

export { ReactNativeEventEmitter as RuntimeEventEmitter };

class ReactNativeTimer implements Timer {
  setTimeout(callback: () => void, ms: number): Timeout {
    return new ReactNativeTimeout(callback, ms);
  }

  clearTimeout(timeoutId: Timeout | string | number | undefined) {
    if (timeoutId instanceof ReactNativeTimeout) {
      timeoutId.clear();
      return;
    }
    globalThis.clearTimeout(timeoutId as number);
  }
}

class ReactNativeTimeout implements Timeout {
  #id: ReturnType<typeof setTimeout>;

  constructor(
    private readonly callback: () => void,
    private readonly ms: number,
  ) {
    this.#id = setTimeout(callback, ms);
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  hasRef(): boolean {
    return true;
  }

  refresh(): this {
    globalThis.clearTimeout(this.#id);
    this.#id = setTimeout(this.callback, this.ms);
    return this;
  }

  clear(): void {
    globalThis.clearTimeout(this.#id);
  }
}

export const timer = new ReactNativeTimer();
