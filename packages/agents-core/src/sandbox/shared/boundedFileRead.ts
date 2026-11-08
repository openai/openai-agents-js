import { UserError } from '../../errors';

// POSIX sh reports only the encoder's pipeline status. Carry the reader status
// inside the encoded output so a failed read cannot become successful content.
export const BOUNDED_FILE_READ_STATUS_BYTES = 5;

/** Read at most maxBytes from the already-open descriptor 3. */
export function boundedFileReadCommand(maxBytes: number): string {
  return `{ if command -p head -c ${maxBytes} <&3; then read_status=0; else read_status=$?; fi; command -p printf '\\n%03d\\n' "$read_status"; } | command -p base64`;
}

export function decodeBoundedFileRead(
  bytes: Uint8Array,
  maxBytes: number,
  error: Error = new UserError('Sandbox file read failed.'),
): Uint8Array {
  const status = bytes.subarray(-BOUNDED_FILE_READ_STATUS_BYTES);
  if (
    bytes.byteLength > maxBytes + BOUNDED_FILE_READ_STATUS_BYTES ||
    status.length !== BOUNDED_FILE_READ_STATUS_BYTES ||
    status[0] !== 10 ||
    status[1] !== 48 ||
    status[2] !== 48 ||
    status[3] !== 48 ||
    status[4] !== 10
  ) {
    throw error;
  }
  return bytes.subarray(0, -BOUNDED_FILE_READ_STATUS_BYTES);
}
