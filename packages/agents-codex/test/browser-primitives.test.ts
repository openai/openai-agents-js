import { describe, expect, it } from 'vitest';
import { createHash as nodeHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual as nodeEqual } from 'node:util';
import {
  Buffer as BrowserBuffer,
  createHash,
  isDeepStrictEqual,
  randomUUID,
} from '../src/runtime/browser-primitives';

describe('portable browser primitives', () => {
  it('preserves SHA-256 across padding boundaries and UTF-8 update chunks', () => {
    for (const length of [
      0, 1, 2, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1024, 65536,
    ]) {
      const bytes = randomBytes(length);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        nodeHash('sha256').update(bytes).digest('hex'),
      );
    }
    for (const text of [
      'abc',
      '🧩é'.repeat(500),
      '\ud800',
      'a'.repeat(1_000_000),
    ]) {
      const split = Math.floor(text.length / 2);
      expect(
        createHash('sha256')
          .update(text.slice(0, split))
          .update(text.slice(split))
          .digest('hex'),
      ).toBe(
        nodeHash('sha256')
          .update(text.slice(0, split))
          .update(text.slice(split))
          .digest('hex'),
      );
    }
  });
  it('retains strict admitted JSON identity without negative-zero or prototype coercion', () => {
    const values = [
      null,
      true,
      0,
      -0,
      1,
      'one',
      [],
      [1],
      {},
      Object.create(null),
      { a: 1, b: [true, null] },
      { b: [true, null], a: 1 },
      [undefined],
      Array(1),
    ];
    for (const left of values)
      for (const right of values)
        expect(isDeepStrictEqual(left, right)).toBe(nodeEqual(left, right));
    expect(isDeepStrictEqual(new Map(), new Map())).toBe(false);
  });
  it('charges encoded bytes and canonicalizes base64 without a global Buffer', () => {
    expect(BrowserBuffer.byteLength('é🧩')).toBe(6);
    expect(BrowserBuffer.from('Zg', 'base64').toString('base64')).toBe('Zg==');
    expect(() => BrowserBuffer.from('Zg==', 'utf8')).toThrow();
    expect(() => createHash('sha1')).toThrow();
    expect(() => createHash('sha256').digest('base64')).toThrow();
    expect(randomUUID()).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
  });
});
