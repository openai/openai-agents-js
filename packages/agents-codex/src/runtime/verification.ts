import type {
  ElicitationRequest,
  NativeQuestionReply,
} from './native-questions';
import {
  isHostedRegistration,
  type ChatGPTAppsMCP,
  type HostedVerificationMCP,
} from './mcp';

/** A signer's protocol proof. Only the registered service can accept it. */
export interface VerificationProof {
  readonly credentialId: string;
  /** Canonical unpadded base64url encoding of at most 128 signature bytes. */
  readonly signature: string;
}

/**
 * One live challenge from the application's original host registration.
 * Return its reply through the owning interaction callback or Session.respond.
 * Delivery acknowledges enqueue, not verifier acceptance. Do not persist it.
 */
export interface UserVerificationRequest extends Pick<
  ElicitationRequest,
  | 'sessionId'
  | 'subagentId'
  | 'submissionId'
  | 'turnId'
  | 'description'
  | 'call'
> {
  readonly type: 'user_verification_request';
  readonly title: string;
  readonly serverName: string;
  /** A fresh copy of the exact opaque bytes to sign, on each read. */
  readonly challenge: Uint8Array;
  reply(proof: VerificationProof | null): NativeQuestionReply;
}

/** @internal Presentation and encoding plug into the existing Session reply owner. */
export interface PreparedUserVerification {
  readonly description: string;
  registrationMatches(current: unknown): boolean;
  decorate(request: object): void;
  encodeReply(value: unknown): string;
}

function proofContent(value: unknown): {
  credentialId: string;
  signature: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid verification proof');
  const { credentialId, signature } = value as VerificationProof;
  if (
    typeof credentialId !== 'string' ||
    !credentialId ||
    Buffer.byteLength(credentialId, 'utf8') > 1024 ||
    Buffer.from(credentialId, 'utf8').toString('utf8') !== credentialId ||
    typeof signature !== 'string' ||
    signature.length > 172 ||
    !/^[A-Za-z0-9_-]+$/.test(signature)
  )
    throw new TypeError('Invalid verification proof');
  const bytes = Buffer.from(signature, 'base64url');
  if (
    !bytes.length ||
    bytes.length > 128 ||
    bytes.toString('base64url') !== signature
  )
    throw new TypeError('Invalid verification proof');
  return { credentialId, signature };
}

// Keep presentation closures separate from live registration ownership. An
// expired request retains only detached display text and challenge bytes.
function presentation(title: string, serverName: string, bytes: Uint8Array) {
  const captured = new Uint8Array(bytes);
  return (target: object) => {
    Object.defineProperties(target, {
      title: { value: title },
      serverName: { value: serverName },
      challenge: { get: () => new Uint8Array(captured) },
    });
  };
}

function replyEncoder(serverName: string, exactRequestIdToken: string) {
  const identity = {
    server_name: serverName,
    request_id: JSON.rawJSON(exactRequestIdToken),
  };
  return (proof: unknown) => {
    if (proof === null)
      return JSON.stringify({ kind: 'decline_elicitation', ...identity });
    const content = proofContent(proof);
    return JSON.stringify({ kind: 'accept_elicitation', ...identity, content });
  };
}

/**
 * @internal Requires the original captured registration and native-owned request ID.
 * This validates protocol syntax, never cryptographic or backend acceptance.
 */
export function prepareUserVerification(
  registration: HostedVerificationMCP | ChatGPTAppsMCP,
  serverName: string,
  exactRequestIdToken: string,
  value: unknown,
): PreparedUserVerification {
  if (!isHostedRegistration(registration) || registration.name !== serverName)
    throw new TypeError('Verification requires the original host registration');
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid user verification request');
  const request = value as Record<string, unknown>;
  const { mode, title, description, challenge } = request;
  if (
    mode !== 'openai/userVerification' ||
    typeof title !== 'string' ||
    typeof description !== 'string' ||
    typeof challenge !== 'string' ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(challenge)
  )
    throw new TypeError('Invalid user verification request');
  const captured = Buffer.from(challenge, 'base64url');
  if (
    !captured.length ||
    captured.toString('base64url') !== challenge.replace(/=+$/, '')
  )
    throw new TypeError('Invalid user verification challenge');
  return Object.freeze({
    description,
    registrationMatches: (current: unknown) => current === registration,
    decorate: presentation(title, serverName, captured),
    encodeReply: replyEncoder(serverName, exactRequestIdToken),
  });
}
