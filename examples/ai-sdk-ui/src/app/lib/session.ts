import { OpenAIConversationsSession } from '@openai/agents-openai';

export type SessionEntry = {
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

export function findSession(sessionId: string): SessionEntry | undefined {
  return sessionStore.get(sessionId);
}

export function saveSession(sessionId: string, entry: SessionEntry): void {
  sessionStore.set(sessionId, entry);
}

export async function createSession(
  sessionId: string,
  options: { activeAgentName?: string } = {},
): Promise<SessionEntry> {
  const session = new OpenAIConversationsSession();
  const conversationId = await session.getSessionId();
  const entry: SessionEntry = {
    conversationId,
    activeAgentName: options.activeAgentName,
  };
  sessionStore.set(sessionId, entry);
  return entry;
}

export async function findOrCreateSession(
  sessionId: string,
  options: { activeAgentName?: string } = {},
): Promise<SessionEntry> {
  const existing = sessionStore.get(sessionId);
  if (existing) {
    if (!existing.activeAgentName && options.activeAgentName) {
      existing.activeAgentName = options.activeAgentName;
    }
    return existing;
  }
  return createSession(sessionId, options);
}
