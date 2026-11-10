import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import type { SessionStore } from './custom-thread-store';

const format = 'agents.canonical.encrypted.aes256gcm.v1';
interface Envelope {
  format: typeof format;
  revision: number;
  writeId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

/**
 * Encrypt canonical snapshots with a caller-owned 32-byte random master key.
 * The backend keeps its existing fencing and durability guarantees. Revisions,
 * write IDs and ciphertext length remain visible. Operations must remain
 * serialized within each lease, as required by SessionStore.
 *
 * Uses per-session HKDF keys and AES-256-GCM. This format is distinct from
 * Python Fernet and Classic item storage; it does not migrate either format.
 * Snapshot expiration and key rotation are unsupported. Expiring an entire
 * canonical snapshot would discard the conversation rather than filter items.
 */
export function encryptedSessionStore(
  backend: SessionStore,
  options: { encryptionKey: Uint8Array },
): SessionStore {
  if (
    !(options?.encryptionKey instanceof Uint8Array) ||
    options.encryptionKey.length !== 32
  )
    throw new TypeError('encryptionKey must contain 32 random bytes');
  const key = Buffer.from(options.encryptionKey);
  for (const method of ['acquire', 'read', 'commit', 'release'] as const)
    if (typeof backend?.[method] !== 'function')
      throw new TypeError(`Session store requires ${method}`);
  const acquire = backend.acquire.bind(backend);
  const read = backend.read.bind(backend);
  const commit = backend.commit.bind(backend);
  const release = backend.release.bind(backend);
  const flush = backend.flush?.bind(backend);
  const cipherKey = (sessionId: string) =>
    Buffer.from(
      hkdfSync('sha256', key, Buffer.from(sessionId), Buffer.from(format), 32),
    );
  const aad = (sessionId: string, revision: number, writeId: string) =>
    Buffer.from(JSON.stringify([format, sessionId, revision, writeId]));
  function decrypt(
    sessionId: string,
    text: string,
  ): { envelope: Envelope; snapshot: string } {
    try {
      const envelope = JSON.parse(text) as Envelope;
      if (
        envelope.format !== format ||
        !Number.isSafeInteger(envelope.revision) ||
        envelope.revision < 1 ||
        typeof envelope.writeId !== 'string' ||
        !envelope.writeId ||
        typeof envelope.nonce !== 'string' ||
        typeof envelope.ciphertext !== 'string' ||
        typeof envelope.tag !== 'string'
      )
        throw new Error();
      const nonce = Buffer.from(envelope.nonce, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      if (nonce.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv(
        'aes-256-gcm',
        cipherKey(sessionId),
        nonce,
      );
      decipher.setAAD(aad(sessionId, envelope.revision, envelope.writeId));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]);
      return { envelope, snapshot: plaintext.toString('utf8') };
    } catch {
      throw new Error('Encrypted canonical storage authentication failed');
    }
  }
  return {
    acquire,
    async read(sessionId, fence) {
      const stored = await read(sessionId, fence);
      return stored === null ? null : decrypt(sessionId, stored).snapshot;
    },
    async commit(sessionId, fence, writeId, expectedRevision, snapshot) {
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        expectedRevision >= Number.MAX_SAFE_INTEGER ||
        typeof writeId !== 'string' ||
        !writeId ||
        typeof snapshot !== 'string'
      )
        throw new TypeError('Invalid thread commit');
      const stored = await read(sessionId, fence);
      if (stored !== null) {
        const previous = decrypt(sessionId, stored);
        if (previous.envelope.writeId === writeId) {
          if (
            previous.envelope.revision !== expectedRevision + 1 ||
            previous.snapshot !== snapshot
          )
            throw new Error(
              'Write ID was reused with different content or revision',
            );
          // Randomized encryption must reuse the accepted bytes after a lost acknowledgement.
          await commit(sessionId, fence, writeId, expectedRevision, stored);
          return;
        }
      }
      const revision = expectedRevision + 1;
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', cipherKey(sessionId), nonce);
      cipher.setAAD(aad(sessionId, revision, writeId));
      const ciphertext = Buffer.concat([
        cipher.update(snapshot, 'utf8'),
        cipher.final(),
      ]);
      const envelope: Envelope = {
        format,
        revision,
        writeId,
        nonce: nonce.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      };
      await commit(
        sessionId,
        fence,
        writeId,
        expectedRevision,
        JSON.stringify(envelope),
      );
    },
    ...(flush ? { flush } : {}),
    release,
  };
}
