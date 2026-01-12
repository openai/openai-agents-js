import { describe, expect, it, vi } from 'vitest';

import {
  createSessionPersistenceTracker,
  PreparedInputWithSessionResult,
} from '../../src/runner/sessionPersistence';
import type { Session } from '../../src/memory/session';
import type { AgentInputItem } from '../../src/types';
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

    tracker.setPreparedItems(toAgentInputList('hi'));
    tracker.recordTurnItems([], toAgentInputList('filtered'));

    expect(tracker.getItemsForPersistence()).toEqual(
      toAgentInputList('filtered'),
    );
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

    tracker.setPreparedItems(prepared.sessionItems);

    const filtered = toAgentInputList('keep');
    tracker.recordTurnItems(prepared.sessionItems ?? [], filtered);

    expect(tracker.getItemsForPersistence()).toEqual(filtered);
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
    tracker.setPreparedItems([shared, shared]);

    const filtered = toAgentInputList('shared');
    tracker.recordTurnItems([shared, shared], filtered);

    const resolved = tracker.getItemsForPersistence();
    expect(resolved).toEqual([]);
  });

  it('persists injected filtered items alongside mapped originals', () => {
    const session = makeSession();
    const tracker = createSessionPersistenceTracker({
      session,
      hasCallModelInputFilter: false,
    })!;

    const first = {
      type: 'message',
      role: 'user',
      content: 'first',
    } as const;
    const second = {
      type: 'message',
      role: 'user',
      content: 'second',
    } as const;

    tracker.setPreparedItems([first, second]);

    const filtered: AgentInputItem[] = [
      { ...first, content: 'first filtered' },
      { ...second, content: 'second filtered' },
      { type: 'message', role: 'user', content: 'injected' },
    ];

    tracker.recordTurnItems([first, second, undefined], filtered);

    expect(tracker.getItemsForPersistence()).toEqual(filtered);
  });

  it('buildPersistInputOnce writes once and skips empty payloads', async () => {
    const persist = vi.fn();
    const session = makeSession();
    const tracker = createSessionPersistenceTracker({
      session,
      hasCallModelInputFilter: false,
      persistInput: persist,
    })!;

    // No prepared items → resolves undefined
    const ensure = tracker.buildPersistInputOnce(false);
    expect(ensure).toBeDefined();
    await ensure?.();
    expect(persist).not.toHaveBeenCalled();

    tracker.setPreparedItems(toAgentInputList('stream me'));
    tracker.recordTurnItems(toAgentInputList('stream me'));

    await ensure?.();
    expect(persist).toHaveBeenCalledTimes(1);

    // Second call is a no-op
    await ensure?.();
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
