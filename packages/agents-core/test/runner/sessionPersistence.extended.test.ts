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

  it.each([false, true])(
    'persists repeated source occurrences with filter configured as %s',
    (hasCallModelInputFilter) => {
      const session = makeSession();
      const tracker = createSessionPersistenceTracker({
        session,
        hasCallModelInputFilter,
      })!;

      const shared = {
        type: 'message',
        role: 'user',
        content: 'shared',
      } as const;
      tracker.setPreparedItems([shared, shared]);

      const filtered = [{ ...shared }, { ...shared }];
      tracker.recordTurnItems([shared, shared], filtered);

      expect(tracker.getItemsForPersistence()).toEqual(filtered);
    },
  );

  it('uses exact source ownership for equal-content items', () => {
    const session = makeSession();
    const tracker = createSessionPersistenceTracker({
      session,
      hasCallModelInputFilter: true,
    })!;
    const first = {
      type: 'message',
      role: 'user',
      content: 'same',
    } as const;
    const second = { ...first };
    const preparedInput = [first, second];
    tracker.setPreparedItems([second], preparedInput);
    const turnInput = structuredClone(preparedInput);
    tracker.setPreparedTurnItems(turnInput, turnInput);

    tracker.recordTurnItems(
      [turnInput[1], turnInput[0]],
      [
        { ...second, content: 'current' },
        { ...first, content: 'history' },
      ],
    );

    expect(tracker.getItemsForPersistence()).toEqual([
      { ...second, content: 'current' },
    ]);
  });

  it('keeps current input ownership when context processing removes a prefix', () => {
    const session = makeSession();
    const tracker = createSessionPersistenceTracker({
      session,
      hasCallModelInputFilter: true,
    })!;
    const history = {
      type: 'message',
      role: 'user',
      content: 'history',
    } as const;
    const compacted = {
      type: 'compaction',
      encrypted_content: 'summary',
    } as const;
    const current = {
      type: 'message',
      role: 'user',
      content: 'current',
    } as const;
    const preparedInput = [history, compacted, current];
    tracker.setPreparedItems([current], preparedInput);
    const turnInput = structuredClone(preparedInput);
    const processedInput = turnInput.slice(1);
    tracker.setPreparedTurnItems(turnInput, processedInput);

    tracker.recordTurnItems(processedInput, processedInput);

    expect(tracker.getItemsForPersistence()).toEqual([current]);
  });

  it('keeps current input ownership when context processing clones items', () => {
    const session = makeSession();
    const tracker = createSessionPersistenceTracker({
      session,
      hasCallModelInputFilter: true,
    })!;
    const history = {
      type: 'message',
      role: 'user',
      content: 'history',
    } as const;
    const current = {
      type: 'message',
      role: 'user',
      content: 'current',
    } as const;
    const preparedInput = [history, current];
    tracker.setPreparedItems([current], preparedInput);
    const turnInput = structuredClone(preparedInput);
    const processedInput = structuredClone(turnInput);
    tracker.setPreparedTurnItems(turnInput, processedInput);

    tracker.recordTurnItems(processedInput, structuredClone(processedInput));

    expect(tracker.getItemsForPersistence()).toEqual([current]);
  });

  it('keeps reordered equal-content current input ownership after context cloning', () => {
    const session = makeSession();
    const tracker = createSessionPersistenceTracker({
      session,
      hasCallModelInputFilter: true,
    })!;
    const current = {
      type: 'message',
      role: 'user',
      content: 'same',
    } as const;
    const history = { ...current };
    const preparedInput = [current, history];
    tracker.setPreparedItems([current], preparedInput);
    const turnInput = structuredClone(preparedInput);
    const processedInput = structuredClone(turnInput);
    tracker.setPreparedTurnItems(turnInput, processedInput);

    tracker.recordTurnItems(processedInput, [
      { ...current, content: 'current-filtered' },
      { ...history, content: 'history-filtered' },
    ]);

    expect(tracker.getItemsForPersistence()).toEqual([
      { ...current, content: 'current-filtered' },
    ]);
  });

  it('keeps current ownership when an equal-content cloned context removes a suffix', () => {
    const session = makeSession();
    const tracker = createSessionPersistenceTracker({
      session,
      hasCallModelInputFilter: true,
    })!;
    const current = {
      type: 'message',
      role: 'user',
      content: 'same',
    } as const;
    const history = { ...current };
    const preparedInput = [current, history];
    tracker.setPreparedItems([current], preparedInput);
    const turnInput = structuredClone(preparedInput);
    const processedInput = structuredClone(turnInput.slice(0, 1));
    tracker.setPreparedTurnItems(turnInput, processedInput);

    tracker.recordTurnItems(processedInput, [
      { ...current, content: 'current-filtered' },
    ]);

    expect(tracker.getItemsForPersistence()).toEqual([
      { ...current, content: 'current-filtered' },
    ]);
  });

  it('does not guess ownership for an equal-content cloned subset without provenance', () => {
    const session = makeSession();
    const tracker = createSessionPersistenceTracker({
      session,
      hasCallModelInputFilter: true,
    })!;
    const history = {
      type: 'message',
      role: 'user',
      content: 'same',
    } as const;
    const current = { ...history };
    const preparedInput = [history, current];
    tracker.setPreparedItems([current], preparedInput);
    const turnInput = structuredClone(preparedInput);
    const processedInput = structuredClone(turnInput.slice(0, 1));
    tracker.setPreparedTurnItems(turnInput, processedInput);

    tracker.recordTurnItems(processedInput, [
      { ...history, content: 'history-filtered' },
    ]);

    expect(tracker.getItemsForPersistence()).toEqual([]);
  });

  it('remaps cloned current input ownership on a later model call', () => {
    const session = makeSession();
    const tracker = createSessionPersistenceTracker({
      session,
      hasCallModelInputFilter: true,
    })!;
    const current = {
      type: 'message',
      role: 'user',
      content: 'current',
    } as const;
    tracker.setPreparedItems([current], [current]);

    const firstTurnInput = structuredClone([current]);
    const firstProcessedInput = structuredClone(firstTurnInput);
    tracker.setPreparedTurnItems(firstTurnInput, firstProcessedInput);
    tracker.recordTurnItems([], []);

    const secondTurnInput = structuredClone([current]);
    const secondProcessedInput = structuredClone(secondTurnInput);
    tracker.setPreparedTurnItems(secondTurnInput, secondProcessedInput);
    tracker.recordTurnItems(secondProcessedInput, [
      { ...current, content: 'current-filtered' },
    ]);

    expect(tracker.getItemsForPersistence()).toEqual([
      { ...current, content: 'current-filtered' },
    ]);
  });

  it('keeps stable ownership when a later cloned turn retains only a subset', () => {
    const session = makeSession();
    const tracker = createSessionPersistenceTracker({
      session,
      hasCallModelInputFilter: true,
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
    tracker.setPreparedItems([first, second], [first, second]);

    const firstTurnInput = structuredClone([first, second]);
    const firstProcessedInput = structuredClone(firstTurnInput);
    tracker.setPreparedTurnItems(firstTurnInput, firstProcessedInput);
    tracker.recordTurnItems(firstProcessedInput, [
      { ...first, content: 'first-filtered' },
      { ...second, content: 'second-filtered' },
    ]);

    const secondTurnInput = structuredClone([first, second]);
    const secondProcessedInput = structuredClone([secondTurnInput[1]!]);
    tracker.setPreparedTurnItems(secondTurnInput, secondProcessedInput);
    tracker.recordTurnItems(secondProcessedInput, [
      { ...second, content: 'second-refiltered' },
    ]);

    expect(tracker.getItemsForPersistence()).toEqual([
      { ...first, content: 'first-filtered' },
      { ...second, content: 'second-refiltered' },
    ]);
  });

  it('retains captured owned input when a later model call omits it', () => {
    const session = makeSession();
    const tracker = createSessionPersistenceTracker({
      session,
      hasCallModelInputFilter: true,
    })!;
    const current = {
      type: 'message',
      role: 'user',
      content: 'current',
    } as const;
    const preparedInput = [current];
    tracker.setPreparedItems([current], preparedInput);
    const turnInput = structuredClone(preparedInput);
    tracker.setPreparedTurnItems(turnInput, turnInput);
    tracker.recordTurnItems([turnInput[0]], [{ ...current }]);

    const laterCompaction = {
      type: 'compaction',
      encrypted_content: 'later',
    } as const;
    tracker.recordTurnItems([laterCompaction], [laterCompaction]);

    expect(tracker.getItemsForPersistence()).toEqual([current]);
  });

  it('adds later injected items without removing captured owned input', () => {
    const session = makeSession();
    const tracker = createSessionPersistenceTracker({
      session,
      hasCallModelInputFilter: true,
    })!;
    const current = {
      type: 'message',
      role: 'user',
      content: 'current',
    } as const;
    tracker.setPreparedItems([current], [current]);
    const turnInput = structuredClone([current]);
    tracker.setPreparedTurnItems(turnInput, turnInput);
    tracker.recordTurnItems([turnInput[0]], [{ ...current }]);

    const injected = {
      type: 'message',
      role: 'user',
      content: 'injected later',
    } as const;
    tracker.recordTurnItems([undefined], [injected]);

    expect(tracker.getItemsForPersistence()).toEqual([current, injected]);
  });

  it('replaces prior filter injections while preserving current duplicates', () => {
    const session = makeSession();
    const tracker = createSessionPersistenceTracker({
      session,
      hasCallModelInputFilter: true,
    })!;
    const current = {
      type: 'message',
      role: 'user',
      content: 'current',
    } as const;
    const injected = {
      type: 'message',
      role: 'user',
      content: 'guidance',
    } as const;
    tracker.setPreparedItems([current], [current]);
    const turnInput = structuredClone([current]);
    tracker.setPreparedTurnItems(turnInput, turnInput);

    tracker.recordTurnItems(
      [undefined, undefined, turnInput[0]],
      [structuredClone(injected), structuredClone(injected), current],
    );
    tracker.recordTurnItems(
      [undefined, undefined, turnInput[0]],
      [structuredClone(injected), structuredClone(injected), current],
    );

    expect(tracker.getItemsForPersistence()).toEqual([
      injected,
      injected,
      current,
    ]);
  });

  it('keeps normalized prepared input when a later model call injects an item', () => {
    const session = makeSession();
    const tracker = createSessionPersistenceTracker({
      session,
      hasCallModelInputFilter: true,
    })!;
    const oldCall = {
      type: 'function_call',
      callId: 'call_later_injection',
      name: 'lookup',
      arguments: '{"value":"old"}',
    } as const;
    const newCall = {
      ...oldCall,
      arguments: '{"value":"new"}',
    };
    const generated = {
      type: 'function_call_result',
      callId: oldCall.callId,
      name: oldCall.name,
      status: 'completed',
      output: 'done',
    } as const;
    const injected = {
      type: 'message',
      role: 'user',
      content: 'injected',
    } as const;
    tracker.setPreparedItems([oldCall, newCall]);

    tracker.recordTurnItems([newCall], [newCall]);
    tracker.recordTurnItems(
      [undefined, newCall, generated],
      [injected, newCall, generated],
    );

    expect(tracker.getItemsForPersistence()).toEqual([injected, newCall]);
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

    const preparedItems = toAgentInputList('stream me');
    tracker.setPreparedItems(preparedItems);
    tracker.recordTurnItems(preparedItems);

    await ensure?.();
    expect(persist).toHaveBeenCalledTimes(1);

    // Second call is a no-op
    await ensure?.();
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
