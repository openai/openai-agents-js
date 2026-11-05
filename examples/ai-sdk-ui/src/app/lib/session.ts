import { cookies } from 'next/headers';
import { OpenAIConversationsSession } from '@openai/agents-openai';

const hour = 60 * 60 * 1000;
const maxSessions = 32;
const maxRunsPerSession = 20;
const maxRunsPerHour = 60;
const maxConcurrentRuns = 4;
export const maxChatBytes = 64 * 1024;

export async function readLimitedJson(
  req: Request,
): Promise<{ value: unknown } | { status: 400 | 413 }> {
  if (Number(req.headers.get('content-length')) > maxChatBytes) {
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
    if (size > maxChatBytes) {
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

export function ownerCookieName(sessionId: string): string {
  return `ai-sdk-ui-owner-${sessionId}`;
}

export async function getOwnerId(
  sessionId: string,
): Promise<string | undefined> {
  return (await cookies()).get(ownerCookieName(sessionId))?.value;
}

export type SessionEntry = {
  ownerId: string;
  conversationId: string;
  activeAgentName?: string;
  expiresAt: number;
  runs: number;
  activeRuns: number;
  activeReads: number;
};

type SessionStoreGlobal = typeof globalThis & {
  __aiSdkUiSessionStore?: Map<string, SessionEntry>;
  __aiSdkUiUsage?: {
    pendingCreations: number;
    creationAttempts: number;
    creationResetAt: number;
    cleanup?: Promise<void>;
    retryCleanupAfter: number;
    globalRuns: number;
    globalResetAt: number;
    activeRuns: number;
  };
};

// NOTE: This in-memory session store is for demo purposes only.
// It resets on server restarts and does not sync across instances.
const globalStore = globalThis as SessionStoreGlobal;
const sessionStore =
  globalStore.__aiSdkUiSessionStore ?? new Map<string, SessionEntry>();

if (!globalStore.__aiSdkUiSessionStore) {
  globalStore.__aiSdkUiSessionStore = sessionStore;
}
const usage = (globalStore.__aiSdkUiUsage ??= {
  pendingCreations: 0,
  creationAttempts: 0,
  creationResetAt: Date.now() + hour,
  retryCleanupAfter: 0,
  globalRuns: 0,
  globalResetAt: Date.now() + hour,
  activeRuns: 0,
});

async function removeExpiredSessions(): Promise<void> {
  if (usage.cleanup) return usage.cleanup;
  if (Date.now() < usage.retryCleanupAfter) return;
  const expired = [...sessionStore].filter(
    ([, entry]) =>
      entry.expiresAt <= Date.now() &&
      entry.activeRuns === 0 &&
      entry.activeReads === 0,
  );
  const cleanup = Promise.allSettled(
    expired.map(async ([id, entry]) => {
      try {
        await new OpenAIConversationsSession({
          conversationId: entry.conversationId,
        }).clearSession();
      } catch (error) {
        // A lost DELETE response can leave an already deleted conversation returning 404.
        if (!(
          error instanceof Error &&
          'status' in error &&
          error.status === 404
        ))
          throw error;
      }
      if (sessionStore.get(id) === entry) sessionStore.delete(id);
    }),
  ).then((results) => {
    if (results.some((result) => result.status === 'rejected')) {
      usage.retryCleanupAfter = Date.now() + 60 * 1000;
    }
  });
  usage.cleanup = cleanup;
  try {
    await cleanup;
  } finally {
    usage.cleanup = undefined;
  }
}

export async function readSessionHistory(
  sessionId: string,
  entry: SessionEntry,
) {
  if (sessionStore.get(sessionId) !== entry || entry.expiresAt <= Date.now()) {
    return [];
  }
  entry.activeReads++;
  try {
    return await new OpenAIConversationsSession({
      conversationId: entry.conversationId,
    }).getItems(10);
  } finally {
    entry.activeReads--;
  }
}

export function findSession(
  sessionId: string,
  ownerId: string | undefined,
): SessionEntry | undefined {
  const entry = sessionStore.get(sessionId);
  return ownerId && entry?.ownerId === ownerId && entry.expiresAt > Date.now()
    ? entry
    : undefined;
}

export function reserveModelRun(
  sessionId: string,
  entry: SessionEntry,
): { status: 404 | 429 } | { release: () => void } {
  const now = Date.now();
  if (sessionStore.get(sessionId) !== entry || entry.expiresAt <= now) {
    return { status: 404 };
  }
  if (now >= usage.globalResetAt) {
    usage.globalRuns = 0;
    usage.globalResetAt = now + hour;
  }
  if (
    entry.runs >= maxRunsPerSession ||
    usage.globalRuns >= maxRunsPerHour ||
    entry.activeRuns > 0 ||
    usage.activeRuns >= maxConcurrentRuns
  ) {
    return { status: 429 };
  }
  entry.runs += 1;
  entry.activeRuns += 1;
  usage.globalRuns += 1;
  usage.activeRuns += 1;
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      entry.activeRuns -= 1;
      usage.activeRuns -= 1;
    },
  };
}

export async function createSession(
  sessionId: string,
  ownerId: string,
): Promise<SessionEntry | undefined> {
  const now = Date.now();
  if (now >= usage.creationResetAt) {
    usage.creationAttempts = 0;
    usage.creationResetAt = now + hour;
  }
  if (usage.creationAttempts >= maxSessions) return undefined;
  usage.creationAttempts++;
  await removeExpiredSessions();
  if (sessionStore.size + usage.pendingCreations >= maxSessions) {
    return undefined;
  }
  usage.pendingCreations += 1;
  try {
    const session = new OpenAIConversationsSession();
    const conversationId = await session.getSessionId();
    const entry: SessionEntry = {
      conversationId,
      ownerId,
      expiresAt: Date.now() + hour,
      runs: 0,
      activeRuns: 0,
      activeReads: 0,
    };
    sessionStore.set(sessionId, entry);
    return entry;
  } finally {
    usage.pendingCreations -= 1;
  }
}
