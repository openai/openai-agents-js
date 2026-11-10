import type {
  PortableVoiceControl,
  PortableVoiceEffect,
} from './portable-session';

/** The import-free Rust controller's C ABI, shared by Wasm and lowered JavaScript. */
export interface PortableVoiceControlExports {
  memory: { readonly buffer: ArrayBufferLike };
  input_buffer(length: number): number;
  apply(): void;
  output_pointer(): number;
  output_length(): number;
}

/** One native or lowered Rust instance owns one control generation. */
export class PortableVoiceControlBinding implements PortableVoiceControl {
  constructor(private readonly exports: PortableVoiceControlExports) {
    if (
      !exports.memory?.buffer ||
      ['input_buffer', 'apply', 'output_pointer', 'output_length'].some(
        (name) =>
          typeof exports[name as keyof PortableVoiceControlExports] !==
          'function',
      )
    )
      throw new Error('Invalid native voice control module.');
  }

  apply(command: unknown): PortableVoiceEffect[] {
    // URI conversion uses standard ECMAScript globals available in Hermes.
    // JSON.stringify escapes isolated surrogates before UTF-8 conversion.
    const json = JSON.stringify(command);
    if (json.length > 8 * 1024 * 1024)
      throw new Error('Native voice command exceeds capacity.');
    const bytes = unescape(encodeURIComponent(json));
    const pointer = this.exports.input_buffer(bytes.length);
    if (!pointer) throw new Error('Native voice command exceeds capacity.');
    const input = new Uint8Array(
      this.exports.memory.buffer,
      pointer,
      bytes.length,
    );
    for (let index = 0; index < bytes.length; index++)
      input[index] = bytes.charCodeAt(index);
    this.exports.apply();
    const outputBytes = new Uint8Array(
      this.exports.memory.buffer,
      this.exports.output_pointer(),
      this.exports.output_length(),
    );
    const chunks: string[] = [];
    for (let offset = 0; offset < outputBytes.length; offset += 8192)
      chunks.push(
        String.fromCharCode(...outputBytes.subarray(offset, offset + 8192)),
      );
    const output = JSON.parse(decodeURIComponent(escape(chunks.join('')))) as {
      effects?: PortableVoiceEffect[];
      error?: string;
    };
    if (output.error) throw new Error(output.error);
    if (!Array.isArray(output.effects))
      throw new Error('Invalid native voice control response.');
    return output.effects;
  }
}
