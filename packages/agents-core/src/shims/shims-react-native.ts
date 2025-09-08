/// <reference lib="dom" />
export { EventEmitter, EventEmitterEvents } from './interface';
import type { EventEmitterEvents, Timeout, Timer } from './interface';

import { EventEmitter as NodeEventEmitter } from 'events';
import structuredClone from '@ungap/structured-clone';
import uuid from 'react-native-uuid';

if (!('structuredClone' in globalThis)) {
  // @ts-expect-error - This is the recommended approach from ungap/structured-clone
  globalThis.structuredClone = structuredClone;
}
export const randomUUID = (): string => uuid.v4();

export function loadEnv(): Record<string, string | undefined> {
  return {};
}

export class ReactNativeEventEmitter<
  Events extends EventEmitterEvents = Record<string, any[]>,
> extends NodeEventEmitter {
  override on<K extends keyof Events & (string | symbol)>(
    type: K,
    listener: (...args: Events[K]) => void,
  ): this {
    // Node's typings accept string | symbol; cast is safe.
    return super.on(type as string | symbol, listener);
  }

  override off<K extends keyof Events & (string | symbol)>(
    type: K,
    listener: (...args: Events[K]) => void,
  ): this {
    return super.off(type as string | symbol, listener);
  }

  override emit<K extends keyof Events & (string | symbol)>(
    type: K,
    ...args: Events[K]
  ): boolean {
    return super.emit(type as string | symbol, ...args);
  }

  override once<K extends keyof Events & (string | symbol)>(
    type: K,
    listener: (...args: Events[K]) => void,
  ): this {
    return super.once(type as string | symbol, listener);
  }
}

export { ReactNativeEventEmitter as RuntimeEventEmitter };

// Streams – placeholders (unused by the SDK on RN)
export const Readable = class {};
export const ReadableStream = globalThis.ReadableStream;
export const ReadableStreamController =
  globalThis.ReadableStreamDefaultController;
export const TransformStream = globalThis.TransformStream;

export class AsyncLocalStorage {
  #ctx: unknown = null;

  run<T>(store: T, fn: () => unknown) {
    this.#ctx = store;
    return fn();
  }
  getStore<T>() {
    return this.#ctx as T;
  }
  enterWith<T>(store: T) {
    this.#ctx = store;
  }
}

export function isBrowserEnvironment(): boolean {
  return true;
}

export function isTracingLoopRunningByDefault(): boolean {
  return false;
}

/* MCP not supported on mobile; export browser stubs */
export { MCPServerStdio, MCPServerStreamableHttp } from './mcp-server/browser';

class RNTimer implements Timer {
  setTimeout(cb: () => void, ms: number): Timeout {
    const id: any = setTimeout(cb, ms);
    // RN timers don’t expose ref/unref; shim them
    id.ref ??= () => id;
    id.unref ??= () => id;
    id.hasRef ??= () => true;
    id.refresh ??= () => id;
    return id;
  }

  clearTimeout(id: Timeout | string | number | undefined) {
    clearTimeout(id as number);
  }
}

const timer = new RNTimer();
export { timer };
