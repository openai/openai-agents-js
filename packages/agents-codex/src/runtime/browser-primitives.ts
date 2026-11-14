/** Browser primitives used by the portable entry; unsupported Node encodings fail closed. */
const utf8 = new TextEncoder();
export function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues)
    throw new Error('Secure random values are unavailable');
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as ReturnType<
    typeof randomUUID
  >;
}
export const Buffer = Object.freeze({
  byteLength(value: string, encoding = 'utf8'): number {
    if (encoding !== 'utf8' && encoding !== 'utf-8')
      throw new TypeError('Unsupported portable text encoding');
    return utf8.encode(value).byteLength;
  },
  from(value: string, encoding: string) {
    if (encoding !== 'base64')
      throw new TypeError('Unsupported portable byte encoding');
    const binary = atob(value);
    return Object.freeze({
      toString(outputEncoding: string) {
        if (outputEncoding !== 'base64')
          throw new TypeError('Unsupported portable byte encoding');
        return btoa(binary);
      },
    });
  },
});
/** Compare admitted JSON without coercing negative zero, prototypes or object keys. */
export function isDeepStrictEqual(left: unknown, right: unknown): boolean {
  const parents = new WeakMap<object, object>();
  const equal = (a: unknown, b: unknown): boolean => {
    if (Object.is(a, b)) return true;
    if (
      typeof a !== 'object' ||
      a === null ||
      typeof b !== 'object' ||
      b === null
    )
      return false;
    const prototype = Object.getPrototypeOf(a);
    if (prototype !== Object.getPrototypeOf(b)) return false;
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
    } else if (prototype !== Object.prototype && prototype !== null)
      return false;
    const previous = parents.get(a);
    if (previous) return previous === b;
    const keys = Reflect.ownKeys(a).filter((key) =>
      Object.prototype.propertyIsEnumerable.call(a, key),
    );
    const other = Reflect.ownKeys(b).filter((key) =>
      Object.prototype.propertyIsEnumerable.call(b, key),
    );
    if (keys.length !== other.length) return false;
    parents.set(a, b);
    try {
      return keys.every(
        (key) =>
          Object.prototype.propertyIsEnumerable.call(b, key) &&
          equal(Reflect.get(a, key), Reflect.get(b, key)),
      );
    } finally {
      parents.delete(a);
    }
  };
  return equal(left, right);
}
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
function sha256(bytes: Uint8Array): string {
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 128;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  const rotate = (value: number, count: number) =>
    (value >>> count) | (value << (32 - count));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15],
        b = words[i - 2];
      words[i] =
        (words[i - 16] +
          (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) +
          words[i - 7] +
          (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) >>>
        0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const first =
        (h +
          (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
          ((e & f) ^ (~e & g)) +
          K[i] +
          words[i]) >>>
        0;
      const second =
        ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) +
          ((a & b) ^ (a & c) ^ (b & c))) >>>
        0;
      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    const state = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) hash[i] = (hash[i] + state[i]) >>> 0;
  }
  return Array.from(hash, (value) => value.toString(16).padStart(8, '0')).join(
    '',
  );
}
interface BrowserHash {
  update(value: string | Uint8Array, encoding?: string): BrowserHash;
  digest(encoding: string): string;
}
export function createHash(algorithm: string): BrowserHash {
  if (algorithm !== 'sha256')
    throw new TypeError('Portable hashing requires SHA-256');
  const chunks: Uint8Array[] = [];
  let length = 0;
  let finished = false;
  const hash: BrowserHash = {
    update(value: string | Uint8Array, encoding = 'utf8') {
      if (finished) throw new Error('Hash has settled');
      if (encoding !== 'utf8' && encoding !== 'utf-8')
        throw new TypeError('Unsupported portable hash encoding');
      const bytes =
        typeof value === 'string' ? utf8.encode(value) : new Uint8Array(value);
      chunks.push(bytes);
      length += bytes.length;
      return hash;
    },
    digest(encoding: string) {
      if (finished) throw new Error('Hash has settled');
      if (encoding !== 'hex')
        throw new TypeError('Portable hashing requires hexadecimal output');
      finished = true;
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      chunks.length = 0;
      return sha256(bytes);
    },
  };
  return hash;
}
