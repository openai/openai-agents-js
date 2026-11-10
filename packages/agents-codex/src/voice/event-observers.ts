/** Passive, bounded subscriptions; observers never participate in control completion. */
export class VoiceEventObservers<Event extends { type: string }> {
  private readonly listeners = new Map<
    string,
    Set<(event: Event) => unknown>
  >();
  private count = 0;
  private closed = false;
  constructor(
    private readonly detach: (event: Event) => Event = detachVoiceObservation,
  ) {}

  on(type: string, listener: (event: Event) => unknown): () => void {
    if (this.closed) throw new Error('Voice observers are closed');
    if (typeof listener !== 'function')
      throw new TypeError('Voice observer must be a function');
    let listeners = this.listeners.get(type);
    if (listeners?.has(listener)) return () => this.off(type, listener);
    if (this.count >= 128) throw new Error('Voice observer capacity exceeded');
    if (!listeners) this.listeners.set(type, (listeners = new Set()));
    listeners.add(listener);
    this.count++;
    return () => this.off(type, listener);
  }

  get size(): number {
    return this.count;
  }

  emit(event: Event): void {
    for (const listener of [
      ...(this.listeners.get('event') ?? []),
      ...(this.listeners.get(event.type) ?? []),
    ]) {
      try {
        const result = listener(this.detach(event));
        if (
          result &&
          typeof (result as PromiseLike<unknown>).then === 'function'
        )
          void Promise.resolve(result).catch(() => {});
      } catch {
        // Application observers cannot fail native execution or other listeners.
      }
    }
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.count = 0;
  }

  private off(type: string, listener: (event: Event) => unknown): void {
    const listeners = this.listeners.get(type);
    if (listeners?.delete(listener)) this.count--;
    if (!listeners?.size) this.listeners.delete(type);
  }
}

/** Copy event data while preserving opaque application/capability objects. */
export function detachVoiceObservation<T>(
  value: T,
  seen = new Map<object, unknown>(),
): T {
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Uint8Array) return Uint8Array.from(value) as T;
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    !Array.isArray(value)
  )
    return value;
  if (seen.has(value)) return seen.get(value) as T;
  const copy: any = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value))
    Object.defineProperty(copy, key, {
      value: detachVoiceObservation(item, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return copy;
}

/** Passive callbacks cannot fail control or leave rejected promises unobserved. */
export function notifyVoiceObserver<Value>(
  observer: ((event: Value) => unknown) | undefined,
  event: Value,
): void {
  if (!observer) return;
  try {
    void Promise.resolve(observer(detachVoiceObservation(event))).catch(
      () => {},
    );
  } catch {
    // Application observers do not own voice control.
  }
}
