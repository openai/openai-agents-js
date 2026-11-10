import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const TOKEN_CLOCK_TOLERANCE_SECONDS = 5;

/** An application-owned source for one protected Sign in with ChatGPT profile. */
export interface SignInWithChatGPT {
  /**
   * Called once per Session opening or standalone store reconciliation. Return
   * the current access token and verified OIDC identity from the same protected
   * credential record. The application verifies the ID token's signature,
   * issuer, audience, expiration, and nonce at sign-in. Return its verified
   * issuer and subject and the issued OAuth client ID used as its audience.
   *
   * The application owns profile selection, renewal, and protected VM import.
   * Keep a renewed access token paired with the verified profile. The SDK uses
   * that profile's identity for resume and checks bearer claims only for route
   * eligibility. OpenAI authenticates the bearer on model requests.
   */
  getCredential(): Promise<{
    accessToken: string;
    issuer: string;
    clientId: string;
    subject: string;
  }>;
}

export async function capturePlanCredential(
  getCredential: SignInWithChatGPT['getCredential'],
  signal: AbortSignal,
): Promise<{ bearer: string; identity: string }> {
  signal.throwIfAborted();
  let onAbort: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const source = Promise.resolve()
    .then(() => {
      signal.throwIfAborted();
      return getCredential();
    })
    .catch(() => {
      throw new Error('Sign in with ChatGPT credential callback failed');
    });
  let credential: Awaited<ReturnType<SignInWithChatGPT['getCredential']>>;
  try {
    credential = await Promise.race([source, cancelled]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', onAbort!);
  }

  try {
    if (!credential || typeof credential !== 'object') throw new Error();
    const { accessToken: bearer, issuer, clientId, subject } = credential;
    if (
      issuer !== 'https://auth.openai.com' ||
      typeof clientId !== 'string' ||
      !clientId.trim() ||
      typeof subject !== 'string' ||
      !subject.trim() ||
      typeof bearer !== 'string' ||
      !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(bearer)
    )
      throw new Error();
    const payload = JSON.parse(
      Buffer.from(bearer.split('.')[1]!, 'base64url').toString('utf8'),
    );
    const { iss, aud, scope, client_id, nbf, exp } = payload;
    const scopes = typeof scope === 'string' ? scope.split(' ') : [];
    const now = Date.now() / 1000;
    if (
      iss !== issuer ||
      aud !== 'https://api.openai.com/v1' ||
      client_id !== clientId ||
      !scopes.includes('resource.invoke') ||
      !scopes.includes('chatgpt.tokens.use.direct') ||
      !Number.isSafeInteger(nbf) ||
      nbf > now + TOKEN_CLOCK_TOLERANCE_SECONDS ||
      !Number.isSafeInteger(exp) ||
      exp <= nbf ||
      exp <= now - TOKEN_CLOCK_TOLERANCE_SECONDS
    )
      throw new Error();
    return {
      bearer,
      identity: createHash('sha256')
        .update(JSON.stringify([clientId, subject]))
        .digest('hex'),
    };
  } catch {
    throw new TypeError('Invalid Sign in with ChatGPT credential');
  }
}
