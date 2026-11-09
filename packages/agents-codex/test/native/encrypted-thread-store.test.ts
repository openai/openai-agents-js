import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { SessionStore } from '../../src/runtime/custom-thread-store';
import { encryptedSessionStore } from '../../src/runtime/encrypted-thread-store';
import { fileSessionStore } from '../../src/runtime/file-thread-store';

const directories: string[] = [];
const key = Buffer.alloc(32, 17);
const payload = JSON.stringify({
  revision: 1,
  secret: 'SYNTHETIC_PRIVATE_秘密',
});
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'encrypted-canonical-'));
  directories.push(directory);
  const backend = fileSessionStore(directory);
  return {
    directory,
    backend,
    store: encryptedSessionStore(backend, { encryptionKey: key }),
  };
}

it('reopens encrypted native snapshots while preserving exclusive ownership and stale fences', async () => {
  const { directory, backend, store } = await fixture();
  const fence = await store.acquire('thread');
  expect(await store.read('thread', fence)).toBeNull();
  await expect(store.acquire('thread')).rejects.toThrow();
  await store.commit('thread', fence, 'write-1', 0, payload);
  const raw = await readFile(join(directory, 'thread.json'), 'utf8');
  expect(raw).not.toContain('SYNTHETIC_PRIVATE');
  expect(await store.read('thread', fence)).toBe(payload);
  await store.release('thread', fence);
  await store.release('thread', fence);
  const reopened = encryptedSessionStore(backend, { encryptionKey: key });
  const successor = await reopened.acquire('thread');
  try {
    expect(await reopened.read('thread', successor)).toBe(payload);
    await expect(store.read('thread', fence)).rejects.toThrow('fence');
  } finally {
    await reopened.release('thread', successor);
  }
});

it('reuses accepted ciphertext across lost acknowledgements and a fresh wrapper', async () => {
  const { backend, store } = await fixture();
  const fence = await store.acquire('thread');
  let lost = false;
  const unreliable: SessionStore = {
    ...backend,
    async commit(...args) {
      await backend.commit(...args);
      if (!lost) {
        lost = true;
        throw new Error('synthetic lost acknowledgement');
      }
    },
  };
  const first = encryptedSessionStore(unreliable, { encryptionKey: key });
  try {
    await expect(
      first.commit('thread', fence, 'write-1', 0, payload),
    ).rejects.toThrow('lost acknowledgement');
    const accepted = await backend.read('thread', fence);
    const retry = encryptedSessionStore(unreliable, { encryptionKey: key });
    await retry.commit('thread', fence, 'write-1', 0, payload);
    expect(await backend.read('thread', fence)).toBe(accepted);
    await expect(
      retry.commit('thread', fence, 'write-1', 0, 'changed'),
    ).rejects.toThrow('different content');
    await expect(
      retry.commit('thread', fence, 'another', 0, payload),
    ).rejects.toThrow('revision conflict');
    expect(await retry.read('thread', fence)).toBe(payload);
  } finally {
    await store.release('thread', fence);
  }
});

it.each(['ciphertext', 'revision', 'writeId', 'wrong-key', 'wrong-session'])(
  'authenticates %s before returning any plaintext',
  async (tamper) => {
    const { directory, backend, store } = await fixture();
    const fence = await store.acquire('thread');
    await store.commit('thread', fence, 'write-1', 0, payload);
    try {
      if (tamper === 'wrong-key') {
        const wrong = encryptedSessionStore(backend, {
          encryptionKey: Buffer.alloc(32, 18),
        });
        await expect(wrong.read('thread', fence)).rejects.toThrow(
          'authentication failed',
        );
      } else if (tamper === 'wrong-session') {
        const other = await store.acquire('other');
        try {
          await backend.commit(
            'other',
            other,
            'write-1',
            0,
            (await backend.read('thread', fence))!,
          );
          await expect(store.read('other', other)).rejects.toThrow(
            'authentication failed',
          );
        } finally {
          await store.release('other', other);
        }
      } else {
        const path = join(directory, 'thread.json');
        const record = JSON.parse(await readFile(path, 'utf8'));
        const envelope = JSON.parse(record.snapshot);
        if (tamper === 'ciphertext')
          envelope.ciphertext =
            Buffer.from('SYNTHETIC_PRIVATE').toString('base64');
        else if (tamper === 'revision') envelope.revision++;
        else envelope.writeId = 'changed';
        record.snapshot = JSON.stringify(envelope);
        await writeFile(path, JSON.stringify(record));
        await expect(store.read('thread', fence)).rejects.toThrow(
          'authentication failed',
        );
      }
    } finally {
      await store.release('thread', fence);
    }
  },
);

it('captures key bytes and rejects invalid key sizes before acquiring ownership', async () => {
  const { backend } = await fixture();
  expect(() =>
    encryptedSessionStore(backend, { encryptionKey: Buffer.alloc(31) }),
  ).toThrow('32 random bytes');
  const mutable = Buffer.alloc(32, 23);
  const store = encryptedSessionStore(backend, { encryptionKey: mutable });
  mutable.fill(0);
  const fence = await store.acquire('thread');
  try {
    await store.commit('thread', fence, 'write-1', 0, payload);
    const original = encryptedSessionStore(backend, {
      encryptionKey: Buffer.alloc(32, 23),
    });
    expect(await original.read('thread', fence)).toBe(payload);
  } finally {
    await store.release('thread', fence);
  }
});
