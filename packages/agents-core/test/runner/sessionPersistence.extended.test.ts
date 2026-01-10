import { describe, expect, it, vi } from 'vitest';

import {
  createSessionPersistenceTracker,
  PreparedInputWithSessionResult,
} from '../../src/runner/sessionPersistence';
import type { Session } from '../../src/memory/session';
import { toAgentInputList } from '../../src/runner/items';

function makeSession(): Session {
  return {
    getSessionId: async () => 'sess',
    getItems: async () => [],
    addItems: async () => {},
    popItem: async () => undefined,
    clearSession: async () => {},
  };
}

describe('sessionPersistence tracker (extended)', () => {
  it('ignores filtered snapshot when callModelInputFilter was applied', () => {
    const session = makeSession();
    const tracker = createSessionPersistenceTracker({
      session,
      hasCallModelInputFilter: true,
    })!;

    tracker.notePreparedSessionItems(toAgentInputList('hi'));
    tracker.recordSessionItems([], toAgentInputList('filtered'));

    expect(tracker.resolveSessionItems()).toEqual(toAgentInputList('filtered'));
  });

  it('persists filtered items when pending counts are satisfied', () => {
    const session = makeSession();
    const tracker = createSessionPersistenceTracker({
      session,
      hasCallModelInputFilter: false,
    })!;

    const prepared: PreparedInputWithSessionResult = {
      preparedInput: toAgentInputList('keep'),
      sessionItems: toAgentInputList('keep'),
    };

    tracker.notePreparedSessionItems(prepared.sessionItems);

    const filtered = toAgentInputList('keep');
    tracker.recordSessionItems(prepared.sessionItems ?? [], filtered);

    expect(tracker.resolveSessionItems()).toEqual(filtered);
  });

  it('deduplicates multiple references to the same source item when filtering', () => {
    const session = makeSession();
    const tracker = createSessionPersistenceTracker({
      session,
      hasCallModelInputFilter: false,
    })!;

    const shared = {
      type: 'message',
      role: 'user',
      content: 'shared',
    } as const;
    tracker.notePreparedSessionItems([shared, shared]);

    const filtered = toAgentInputList('shared');
    tracker.recordSessionItems([shared, shared], filtered);

    const resolved = tracker.resolveSessionItems();
    expect(resolved).toEqual([]);
  });

  it('buildEnsureStreamInputPersisted writes once and skips empty payloads', async () => {
    const persist = vi.fn();
    const session = makeSession();
    const tracker = createSessionPersistenceTracker({
      session,
      hasCallModelInputFilter: false,
      persistInput: persist,
    })!;

    // No prepared items → resolves undefined
    const ensure = tracker.buildEnsureStreamInputPersisted(false);
    expect(ensure).toBeDefined();
    await ensure?.();
    expect(persist).not.toHaveBeenCalled();

    tracker.notePreparedSessionItems(toAgentInputList('stream me'));
    tracker.recordSessionItems(toAgentInputList('stream me'));

    await ensure?.();
    expect(persist).toHaveBeenCalledTimes(1);

    // Second call is a no-op
    await ensure?.();
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
