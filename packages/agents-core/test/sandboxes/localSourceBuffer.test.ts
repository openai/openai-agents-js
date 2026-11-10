import { Buffer } from 'node:buffer';
import { expect, test } from 'vitest';
import { readLocalSourceBuffer } from '../../src/sandbox/shared/localSourceBuffer';

function reader(data: Buffer, short = data.length) {
  let offset = 0;
  return async (target: Buffer) => {
    const count = Math.min(target.length, data.length - offset, short);
    data.copy(target, 0, offset, offset + count);
    offset += count;
    return count;
  };
}

test('fills a known-size result across short reads', async () => {
  const bytes = Buffer.alloc(200_000, 0x5a);
  expect(
    await readLocalSourceBuffer(BigInt(bytes.length), reader(bytes, 17_003)),
  ).toEqual(bytes);
});

test('returns only filled bytes when an acquired file shrinks', async () => {
  expect(
    Buffer.from(
      await readLocalSourceBuffer(100, reader(Buffer.from('SAFE'))),
    ).toString(),
  ).toBe('SAFE');
});

test('matches the initial-size snapshot when an acquired file grows', async () => {
  expect(
    Buffer.from(
      await readLocalSourceBuffer(4, reader(Buffer.from('SAFE appended'))),
    ).toString(),
  ).toBe('SAFE');
});

test.each([undefined, 0, 0n])(
  'streams a pseudo-file without a usable size: %s',
  async (size) => {
    const bytes = Buffer.alloc(130_000, 0x41);
    expect(await readLocalSourceBuffer(size, reader(bytes, 7_123))).toEqual(
      bytes,
    );
  },
);

test.each([-1, -1n, Number.NaN, 1.5])(
  'rejects an invalid size: %s',
  async (size) => {
    await expect(
      readLocalSourceBuffer(size, async () => 0),
    ).rejects.toMatchObject({ code: 'ERR_FS_FILE_TOO_LARGE' });
  },
);

test.each([-1, 2, Number.NaN])(
  'rejects an invalid native read count: %s',
  async (count) => {
    await expect(
      readLocalSourceBuffer(1, async () => count),
    ).rejects.toMatchObject({ code: 'EIO' });
  },
);
