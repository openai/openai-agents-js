import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const COOKIE_NAME = 'realtime_demo_session';
const SESSION_TTL_SECONDS = 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;

export type DemoPrincipal = {
  csrfToken: string;
  ownerId: string;
  safetyIdentifier: string;
};

type StoredPrincipal = DemoPrincipal & {
  expiresAt: number;
  token: string;
};

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator < 1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    cookies.set(name, value);
  }
  return cookies;
}

export class DemoAuthStore {
  readonly #principals = new Map<string, StoredPrincipal>();
  readonly #secureCookie: boolean;
  readonly #now: () => number;

  constructor(options: { secureCookie: boolean; now?: () => number }) {
    this.#secureCookie = options.secureCookie;
    this.#now = options.now ?? Date.now;
  }

  getOrCreate(request: IncomingMessage): {
    principal: DemoPrincipal;
    setCookie?: string;
  } {
    const existing = this.#findStoredPrincipal(request);
    if (existing) {
      existing.expiresAt = this.#now() + SESSION_TTL_MS;
      return {
        principal: existing,
        setCookie: this.#serializeCookie(existing.token),
      };
    }

    const token = randomBytes(32).toString('base64url');
    const ownerId = randomUUID();
    const principal: StoredPrincipal = {
      csrfToken: randomBytes(32).toString('base64url'),
      expiresAt: this.#now() + SESSION_TTL_MS,
      ownerId,
      safetyIdentifier: createHash('sha256').update(ownerId).digest('hex'),
      token,
    };
    this.#principals.set(token, principal);

    return {
      principal,
      setCookie: this.#serializeCookie(token),
    };
  }

  authenticate(request: IncomingMessage): DemoPrincipal | null {
    return this.#findStoredPrincipal(request);
  }

  #findStoredPrincipal(request: IncomingMessage): StoredPrincipal | null {
    const token = parseCookies(request.headers.cookie).get(COOKIE_NAME);
    if (!token) {
      return null;
    }

    const principal = this.#principals.get(token);
    if (!principal) {
      return null;
    }
    if (principal.expiresAt <= this.#now()) {
      this.#principals.delete(token);
      return null;
    }
    return principal;
  }

  #serializeCookie(token: string): string {
    const attributes = [
      `${COOKIE_NAME}=${token}`,
      'HttpOnly',
      `Max-Age=${SESSION_TTL_SECONDS}`,
      'Path=/',
      'SameSite=Strict',
    ];
    if (this.#secureCookie) {
      attributes.push('Secure');
    }
    return attributes.join('; ');
  }

  verifyCsrf(request: IncomingMessage, principal: DemoPrincipal): boolean {
    return request.headers['x-csrf-token'] === principal.csrfToken;
  }
}
