/** Decode UTF-8 from the import-free Rust controllers, including in Hermes. */
export function decodeControlOutput(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined')
    return new TextDecoder().decode(bytes);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return decodeURIComponent(escape(chunks.join('')));
}
