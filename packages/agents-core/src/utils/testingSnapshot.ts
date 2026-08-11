const objectConstructorSource = Function.prototype.toString.call(Object);

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) {
    return true;
  }

  const constructor = Object.prototype.hasOwnProperty.call(
    prototype,
    'constructor',
  )
    ? (prototype as { constructor?: unknown }).constructor
    : undefined;
  return (
    typeof constructor === 'function' &&
    Function.prototype.toString.call(constructor) === objectConstructorSource
  );
}

function isCloneableBuffer(value: object): value is ArrayBuffer {
  const tag = Object.prototype.toString.call(value);
  return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]';
}

/**
 * Copies mutable data containers used by public testing call records while
 * preserving runtime identities such as signals, callbacks, and class
 * instances. Cycles and shared references are preserved within the snapshot.
 *
 */
export function snapshotTestingValue<T>(
  value: T,
  seen: WeakMap<object, unknown> = new WeakMap(),
): T {
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const existing = seen.get(value);
  if (typeof existing !== 'undefined') {
    return existing as T;
  }

  if (isCloneableBuffer(value)) {
    const snapshot = value.slice(0);
    seen.set(value, snapshot);
    return snapshot as T;
  }

  if (ArrayBuffer.isView(value)) {
    const buffer = snapshotTestingValue(value.buffer, seen);
    let snapshot: ArrayBufferView;
    if (Object.prototype.toString.call(value) === '[object DataView]') {
      snapshot = new DataView(buffer, value.byteOffset, value.byteLength);
    } else {
      const TypedArray = value.constructor as new (
        buffer: ArrayBufferLike,
        byteOffset: number,
        length: number,
      ) => ArrayBufferView;
      const length = (value as unknown as { length: number }).length;
      snapshot = new TypedArray(buffer, value.byteOffset, length);
    }
    seen.set(value, snapshot);
    return snapshot as T;
  }

  if (Array.isArray(value)) {
    const snapshot: unknown[] = [];
    seen.set(value, snapshot);
    for (const entry of value) {
      snapshot.push(snapshotTestingValue(entry, seen));
    }
    return snapshot as T;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const snapshot = Object.create(Object.getPrototypeOf(value)) as Record<
    PropertyKey,
    unknown
  >;
  seen.set(value, snapshot);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) {
      continue;
    }
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value: snapshotTestingValue(
        (value as Record<PropertyKey, unknown>)[key],
        seen,
      ),
      writable: true,
    });
  }
  return snapshot as T;
}
