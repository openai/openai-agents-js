import { cookies } from 'next/headers';
import { OpenAIConversationsSession } from '@openai/agents-openai';

export const OWNER_COOKIE = 'ai-sdk-ui-owner';

export async function getOwnerId(): Promise<string | undefined> {
  return (await cookies()).get(OWNER_COOKIE)?.value;
}

export type SessionEntry = {
  ownerId: string;
  conversationId: string;
  activeAgentName?: string;
};

type SessionStoreGlobal = typeof globalThis & {
  __aiSdkUiSessionStore?: Map<string, SessionEntry>;
};

// NOTE: This in-memory session store is for demo purposes only.
// It resets on server restarts and does not sync across instances.
const globalStore = globalThis as SessionStoreGlobal;
const sessionStore =
  globalStore.__aiSdkUiSessionStore ?? new Map<string, SessionEntry>();

if (!globalStore.__aiSdkUiSessionStore) {
  globalStore.__aiSdkUiSessionStore = sessionStore;
}

export function findSession(
  sessionId: string,
  ownerId: string | undefined,
): SessionEntry | undefined {
  const entry = sessionStore.get(sessionId);
  return ownerId && entry?.ownerId === ownerId ? entry : undefined;
}

export function saveSession(sessionId: string, entry: SessionEntry): void {
  sessionStore.set(sessionId, entry);
}

export async function createSession(
  sessionId: string,
  ownerId: string,
): Promise<SessionEntry> {
  const session = new OpenAIConversationsSession();
  const conversationId = await session.getSessionId();
  const entry: SessionEntry = {
    conversationId,
    ownerId,
  };
  sessionStore.set(sessionId, entry);
  return entry;
}
