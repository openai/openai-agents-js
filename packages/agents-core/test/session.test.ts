import { describe, expect, it } from 'vitest';
import {
  isOpenAIResponsesCompactionAwareSession,
  isSessionHistoryRewriteAwareSession,
  type OpenAIResponsesCompactionAwareSession,
  type Session,
  type SessionHistoryRewriteAwareSession,
} from '../src/memory/session';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    getSessionId: async () => 'session',
    getItems: async () => [],
    addItems: async () => {},
    popItem: async () => undefined,
    clearSession: async () => {},
    ...overrides,
  };
}

describe('session type guards', () => {
  it('detects OpenAI Responses compaction-aware sessions', () => {
    const compactionSession: OpenAIResponsesCompactionAwareSession = {
      ...makeSession(),
      runCompaction: () => null,
    };

    expect(isOpenAIResponsesCompactionAwareSession(undefined)).toBe(false);
    expect(isOpenAIResponsesCompactionAwareSession(makeSession())).toBe(false);
    expect(isOpenAIResponsesCompactionAwareSession(compactionSession)).toBe(
      true,
    );
  });

  it('detects history rewrite-aware sessions', () => {
    const historyRewriteSession: SessionHistoryRewriteAwareSession = {
      ...makeSession(),
      applyHistoryMutations: () => {},
    };

    expect(isSessionHistoryRewriteAwareSession(undefined)).toBe(false);
    expect(isSessionHistoryRewriteAwareSession(makeSession())).toBe(false);
    expect(isSessionHistoryRewriteAwareSession(historyRewriteSession)).toBe(
      true,
    );
  });
});
