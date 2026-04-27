export type TarFixtureEntry = {
  name: string;
  type?: '0' | '1' | '2' | '5';
  content?: string | Uint8Array;
  linkName?: string;
};

const BLOCK_SIZE = 512;

export function makeTarArchive(entries: TarFixtureEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const content =
      typeof entry.content === 'string'
        ? new TextEncoder().encode(entry.content)
        : (entry.content ?? new Uint8Array());
    chunks.push(makeTarHeader(entry, content.byteLength));
    chunks.push(padToBlock(content));
  }
  chunks.push(new Uint8Array(BLOCK_SIZE));
  chunks.push(new Uint8Array(BLOCK_SIZE));
  return concatBytes(chunks);
}

function makeTarHeader(entry: TarFixtureEntry, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE);
  writeField(header, 0, 100, entry.name);
  writeField(header, 100, 8, '0000644');
  writeField(header, 108, 8, '0000000');
  writeField(header, 116, 8, '0000000');
  writeField(header, 124, 12, toOctal(size, 11));
  writeField(header, 136, 12, '00000000000');
  for (let index = 148; index < 156; index += 1) {
    header[index] = 0x20;
  }
  writeField(header, 156, 1, entry.type ?? '0');
  if (entry.linkName) {
    writeField(header, 157, 100, entry.linkName);
  }
  writeField(header, 257, 6, 'ustar');
  writeField(header, 263, 2, '00');

  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeField(header, 148, 8, `${toOctal(checksum, 6)}\0 `);
  return header;
}

function writeField(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = new TextEncoder().encode(value);
  target.set(bytes.subarray(0, length), offset);
}

function toOctal(value: number, width: number): string {
  return value.toString(8).padStart(width, '0');
}

function padToBlock(bytes: Uint8Array): Uint8Array {
  const padded = new Uint8Array(
    Math.ceil(bytes.byteLength / BLOCK_SIZE) * BLOCK_SIZE,
  );
  padded.set(bytes);
  return padded;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
