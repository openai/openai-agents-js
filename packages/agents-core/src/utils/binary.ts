import { encodeUint8ArrayToBase64 } from './base64';
import {
  isArrayBufferView,
  isNodeBuffer,
  isSerializedBufferSnapshot,
} from './smartString';

export type SerializedBinary = {
  __type: string;
  data: string;
};

export function serializeBinary(value: unknown): SerializedBinary | undefined {
  if (value instanceof ArrayBuffer) {
    return {
      __type: 'ArrayBuffer',
      data: encodeUint8ArrayToBase64(new Uint8Array(value)),
    };
  }

  if (isArrayBufferView(value)) {
    const view = value as ArrayBufferView;
    return {
      __type: view.constructor.name,
      data: encodeUint8ArrayToBase64(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      ),
    };
  }

  if (isNodeBuffer(value)) {
    const view = value as Uint8Array;
    return {
      __type: 'Buffer',
      data: encodeUint8ArrayToBase64(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      ),
    };
  }

  if (isSerializedBufferSnapshot(value)) {
    return {
      __type: 'Buffer',
      data: encodeUint8ArrayToBase64(Uint8Array.from(value.data)),
    };
  }

  return undefined;
}

export function toUint8ArrayFromBinary(value: unknown): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (isArrayBufferView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (isNodeBuffer(value)) {
    const view = value as Uint8Array;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (isSerializedBufferSnapshot(value)) {
    return Uint8Array.from(value.data);
  }
  return undefined;
}
