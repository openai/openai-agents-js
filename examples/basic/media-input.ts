import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

// Only the examples fetch their fixed public URLs. The SDK never downloads a
// model-supplied URL or guesses which local file it should read.
export function mediaOptions(remote = false) {
  const { values } = parseArgs({
    options: { codex: { type: 'boolean' }, file: { type: 'string' } },
  });
  if (values.file !== undefined && (!values.codex || !remote)) {
    throw new Error(
      '--file is for a local copy of a remote input with --codex.',
    );
  }
  return values;
}

export async function readSample(url: string, file?: string): Promise<Buffer> {
  if (file !== undefined) return readFileSync(file);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok)
    throw new Error(`Could not fetch sample: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export function jpegDataUrl(bytes: Buffer): string {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new Error(
      'Expected a JPEG. For offline use, pass --file with a local JPEG.',
    );
  }
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

// Plain text preserves the words on these pages, not embedded images or layout.
export function pdfText(bytes: Buffer): string {
  let text: string;
  try {
    text = execFileSync('pdftotext', ['-enc', 'UTF-8', '-nopgbrk', '-', '-'], {
      input: bytes,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error(
      'Install Poppler (pdftotext) to read PDF text with --codex.',
    );
  }
  if (!text) throw new Error('This PDF has no extractable text.');
  return text;
}
