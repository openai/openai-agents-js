import { describe, expect, it } from 'vitest';
import { createSessionPersistenceTracker } from '../../src/runner/sessionPersistence';
import { matchesOwnedHistory } from '../../src/shims/inputOrder-node';
import type { AgentInputItem } from '../../src/types';

function message(text: string): AgentInputItem {
  return {
    role: 'assistant',
    content: [{ type: 'output_text', text }],
    status: 'completed',
  };
}

function begin(input: AgentInputItem[]) {
  const tracker = createSessionPersistenceTracker({
    hasCallModelInputFilter: false,
  })!;
  tracker.setPreparedItems(undefined, input);
  return tracker;
}

describe('ownership of a complete input history', () => {
  it('preserves distinct occurrences on a subsequent rewrite', () => {
    const input = [message('equal'), message('equal')];
    const tracker = begin(input);
    const prepared = structuredClone(input);
    expect(matchesOwnedHistory(input, prepared, prepared.slice())).toBe(true);
    tracker.setPreparedTurnItems(prepared, prepared.slice());
    tracker.recordTurnItems(prepared, [message('first'), message('second')]);
    const held = tracker.getItemsForPersistence()!;
    held[0] = message('caller edit');
    tracker.recordTurnItems([prepared[1]], [message('updated')]);
    expect(tracker.getItemsForPersistence()).toEqual([
      message('first'),
      message('updated'),
    ]);
    expect(held[0]).toEqual(message('caller edit'));
  });

  it('keeps a reused root ahead of an equal clone', () => {
    const input = [message('equal'), message('equal')];
    const tracker = begin(input);
    const next = [input[1], structuredClone(input[1])];
    tracker.setPreparedTurnItems(next, next.slice());
    tracker.recordTurnItems(next, [message('second'), message('first')]);
    tracker.setPreparedTurnItems(input, input);
    tracker.recordTurnItems([input[1]], [message('updated')]);
    expect(tracker.getItemsForPersistence()).toEqual([
      message('first'),
      message('updated'),
    ]);
  });

  it('rechecks the live originals after preparation', () => {
    const input = [message('prior'), message('other')];
    const tracker = begin(input);
    const prepared = structuredClone(input);
    input[0] = message('later edit');
    tracker.setPreparedTurnItems(prepared, prepared);
    tracker.recordTurnItems(prepared, prepared);
    expect(tracker.getItemsForPersistence()).toEqual([message('other')]);
  });

  it('keeps serialization errors from hidden hooks', () => {
    const input = [message('prior'), message('other')];
    const tracker = begin(input);
    const prepared = structuredClone(input);
    Object.defineProperty(input[0], 'toJSON', {
      value() {
        throw Error('history hook');
      },
    });
    expect(() => tracker.setPreparedTurnItems(prepared, prepared)).toThrow(
      'history hook',
    );
  });

  it('declines getter and proxy inputs before invoking them', () => {
    const fail = () => {
      throw Error('unexpected read');
    };
    const prepared = [{ value: 'value' }];
    expect(
      matchesOwnedHistory(
        [
          {
            get value() {
              return fail();
            },
          },
        ],
        prepared,
        prepared,
      ),
    ).toBe(false);
    expect(
      matchesOwnedHistory(
        [new Proxy({}, { ownKeys: fail })],
        prepared,
        prepared,
      ),
    ).toBe(false);
  });
});
