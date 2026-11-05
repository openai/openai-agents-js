import { randomBytes, timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';

export const sessionCookieName = 'nextjs-demo-session';
const hour = 60 * 60 * 1000;
type DemoStore = {
  sessions: Map<string, { expiresAt: number; runs: number }>;
  globalRuns: number;
  globalResetAt: number;
};
const globalStore = globalThis as typeof globalThis & {
  __nextjsDemoStore?: DemoStore;
};
const store = (globalStore.__nextjsDemoStore ??= {
  sessions: new Map(),
  globalRuns: 0,
  globalResetAt: Date.now() + hour,
});

export function sameOrigin(req: NextRequest): boolean {
  return req.headers.get('origin') === req.nextUrl.origin;
}

export function accessTokenConfigured(): boolean {
  return (process.env.NEXTJS_DEMO_ACCESS_TOKEN?.length ?? 0) >= 32;
}

export function validAccessToken(provided: string): boolean {
  const configured = process.env.NEXTJS_DEMO_ACCESS_TOKEN;
  if (!configured || !accessTokenConfigured()) return false;
  const expected = Buffer.from(configured);
  const actual = Buffer.from(provided);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createDemoSession(): string | undefined {
  const now = Date.now();
  for (const [id, session] of store.sessions) {
    if (session.expiresAt <= now) store.sessions.delete(id);
  }
  if (store.sessions.size >= 100) return undefined;
  const id = randomBytes(32).toString('base64url');
  store.sessions.set(id, { expiresAt: now + hour, runs: 0 });
  return id;
}

export function getDemoSession(req: NextRequest): string | undefined {
  const id = req.cookies.get(sessionCookieName)?.value;
  if (!id) return undefined;
  const session = store.sessions.get(id);
  if (!session) return undefined;
  if (session.expiresAt <= Date.now()) {
    store.sessions.delete(id);
    return undefined;
  }
  return id;
}

export function reserveModelRun(
  id: string,
): 'reserved' | 'expired' | 'limited' {
  const session = store.sessions.get(id);
  const now = Date.now();
  if (!session || session.expiresAt <= now) return 'expired';
  if (now >= store.globalResetAt) {
    store.globalRuns = 0;
    store.globalResetAt = now + hour;
  }
  if (session.runs >= 20 || store.globalRuns >= 60) return 'limited';
  session.runs += 1;
  store.globalRuns += 1;
  return 'reserved';
}

export async function readLimitedJson(
  req: NextRequest,
  maxBytes: number,
): Promise<{ value: unknown } | { status: 400 | 413 }> {
  if (Number(req.headers.get('content-length')) > maxBytes) {
    return { status: 413 };
  }
  if (!req.body) return { status: 400 };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { status: 413 };
    }
    chunks.push(value);
  }
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { status: 400 };
  }
}
