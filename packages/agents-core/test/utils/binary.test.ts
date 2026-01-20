import { describe, it, expect } from 'vitest';

import {
  serializeBinary,
  toUint8ArrayFromBinary,
} from '../../src/utils/binary';

describe('utils/binary', () => {
  it('serializes array buffers, typed views, node buffers, and snapshots', () => {
    const arrayBuffer = new Uint8Array([1, 2, 3]).buffer;
    const typedView = new Uint16Array([256, 512]);
    const nodeBuffer = Buffer.from([9, 8, 7]);
    const snapshot = { type: 'Buffer', data: [5, 6, 7] };

    expect(serializeBinary(arrayBuffer)).toEqual({
      __type: 'ArrayBuffer',
      data: Buffer.from(arrayBuffer).toString('base64'),
    });

    expect(serializeBinary(typedView)).toEqual({
      __type: 'Uint16Array',
      data: Buffer.from(
        new Uint8Array(
          typedView.buffer,
          typedView.byteOffset,
          typedView.byteLength,
        ),
      ).toString('base64'),
    });

    expect(serializeBinary(nodeBuffer)).toEqual({
      __type: 'Buffer',
      data: Buffer.from(nodeBuffer).toString('base64'),
    });

    expect(serializeBinary(snapshot)).toEqual({
      __type: 'Buffer',
      data: Buffer.from(Uint8Array.from(snapshot.data)).toString('base64'),
    });

    expect(serializeBinary(42)).toBeUndefined();
  });

  it('round-trips to Uint8Array for supported inputs', () => {
    const arrayBuffer = new Uint8Array([1, 2, 3]).buffer;
    const typedView = new Uint16Array([256, 512]);
    const nodeBuffer = Buffer.from([9, 8, 7]);
    const snapshot = { type: 'Buffer', data: [5, 6, 7] };

    expect(toUint8ArrayFromBinary(arrayBuffer)).toEqual(
      new Uint8Array(arrayBuffer),
    );
    expect(toUint8ArrayFromBinary(typedView)).toEqual(
      new Uint8Array(
        typedView.buffer,
        typedView.byteOffset,
        typedView.byteLength,
      ),
    );
    expect(toUint8ArrayFromBinary(nodeBuffer)).toEqual(
      new Uint8Array(
        nodeBuffer.buffer,
        nodeBuffer.byteOffset,
        nodeBuffer.byteLength,
      ),
    );
    expect(toUint8ArrayFromBinary(snapshot)).toEqual(
      Uint8Array.from(snapshot.data),
    );
    expect(toUint8ArrayFromBinary('nope')).toBeUndefined();
  });

  it('supports node buffer paths when view detection is bypassed', () => {
    const nodeBuffer = Buffer.from([9, 8, 7]);
    const originalIsView = ArrayBuffer.isView;

    ArrayBuffer.isView = ((value: any): value is ArrayBufferView =>
      value === nodeBuffer
        ? false
        : originalIsView(value)) as typeof ArrayBuffer.isView;

    try {
      expect(serializeBinary(nodeBuffer)).toEqual({
        __type: 'Buffer',
        data: Buffer.from(nodeBuffer).toString('base64'),
      });
      expect(toUint8ArrayFromBinary(nodeBuffer)).toEqual(
        new Uint8Array(
          nodeBuffer.buffer,
          nodeBuffer.byteOffset,
          nodeBuffer.byteLength,
        ),
      );
    } finally {
      ArrayBuffer.isView = originalIsView;
    }
  });
});
