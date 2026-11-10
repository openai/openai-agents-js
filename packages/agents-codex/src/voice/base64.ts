const alphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 without Node or optional browser globals, including Hermes. */
export function encodeBase64(data: Uint8Array): string {
  const chunks: string[] = [];
  for (let start = 0; start < data.length; start += 12_288) {
    let chunk = '';
    for (
      let index = start;
      index < Math.min(start + 12_288, data.length);
      index += 3
    ) {
      const remaining = data.length - index;
      const bits =
        (data[index] << 16) |
        ((data[index + 1] ?? 0) << 8) |
        (data[index + 2] ?? 0);
      chunk +=
        alphabet[(bits >>> 18) & 63] +
        alphabet[(bits >>> 12) & 63] +
        (remaining > 1 ? alphabet[(bits >>> 6) & 63] : '=') +
        (remaining > 2 ? alphabet[bits & 63] : '=');
    }
    chunks.push(chunk);
  }
  return chunks.join('');
}

export function decodeBase64(value: string): Uint8Array {
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
    value.replace(/=+$/, '').length % 4 === 1 ||
    (value.includes('=') && value.length % 4 !== 0)
  )
    throw new TypeError('Invalid voice audio base64.');
  const text = value.replace(/=+$/, '');
  const output = new Uint8Array(Math.floor((text.length * 6) / 8));
  let bits = 0;
  let available = 0;
  let offset = 0;
  for (const character of text) {
    bits = (bits << 6) | alphabet.indexOf(character);
    available += 6;
    if (available >= 8) {
      available -= 8;
      output[offset++] = (bits >>> available) & 255;
    }
  }
  return output;
}
