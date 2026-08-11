import { describe, expect, it } from 'vitest';
import {
  isOpenAIResponsesCompactionAwareSession,
  isSessionHistoryExpectedRewriteAwareSession,
  isSessionHistoryRewriteAwareSession,
  isSessionHistoryTransactionAwareSession,
  type OpenAIResponsesCompactionAwareSession,
  type Session,
  type SessionHistoryExpectedRewriteAwareSession,
  type SessionHistoryRewriteAwareSession,
  type SessionHistoryTransactionAwareSession,
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

  it('detects expected history rewrite-aware sessions explicitly', () => {
    const legacyRewriteSession: SessionHistoryRewriteAwareSession = {
      ...makeSession(),
      applyHistoryMutations: () => {},
    };
    const expectedRewriteSession: SessionHistoryExpectedRewriteAwareSession = {
      ...legacyRewriteSession,
      supportsExpectedHistoryMutations: true,
    };

    expect(isSessionHistoryExpectedRewriteAwareSession(undefined)).toBe(false);
    expect(
      isSessionHistoryExpectedRewriteAwareSession(legacyRewriteSession),
    ).toBe(false);
    expect(
      isSessionHistoryExpectedRewriteAwareSession(expectedRewriteSession),
    ).toBe(true);
  });

  it('detects history transaction-aware sessions', () => {
    const historyTransactionSession: SessionHistoryTransactionAwareSession = {
      ...makeSession(),
      applyHistoryTransaction: () => {},
    };

    expect(isSessionHistoryTransactionAwareSession(undefined)).toBe(false);
    expect(isSessionHistoryTransactionAwareSession(makeSession())).toBe(false);
    expect(
      isSessionHistoryTransactionAwareSession(historyTransactionSession),
    ).toBe(true);
  });
});
