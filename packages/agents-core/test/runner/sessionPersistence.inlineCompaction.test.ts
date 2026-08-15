import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../src/memory/session';
import { saveStreamInputToSession } from '../../src/runner/sessionPersistence';
import type { AgentInputItem } from '../../src/types';

function userMessage(text: string): AgentInputItem {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}

const COMPACTION: AgentInputItem = {
  type: 'compaction',
  id: 'cmp_inline',
  encrypted_content: 'ciphertext',
};

class AppendOnlyCompactionSession implements Session {
  items: AgentInputItem[] = [userMessage('stored before run')];
  replacements: AgentInputItem[][] = [];
  clearCalls = 0;

  async getSessionId() {
    return 'append-only';
  }

  async getItems(limit?: number) {
    return limit ? this.items.slice(-limit) : [...this.items];
  }

  async addItems(items: AgentInputItem[]) {
    this.items.push(...structuredClone(items));
  }

  async replaceHistoryWithCompaction(items: AgentInputItem[]) {
    this.replacements.push(structuredClone(items));
    this.items.push(...structuredClone(items));
  }

  async popItem() {
    return this.items.pop();
  }

  async clearSession() {
    this.clearCalls += 1;
    this.items = [];
  }
}

class AcceptedThenRejectedCompactionSession extends AppendOnlyCompactionSession {
  override async replaceHistoryWithCompaction(items: AgentInputItem[]) {
    await super.replaceHistoryWithCompaction(items);
    throw new Error('connection dropped after accept');
  }
}

class RejectedCompactionSession extends AppendOnlyCompactionSession {
  override async replaceHistoryWithCompaction(items: AgentInputItem[]) {
    this.replacements.push(structuredClone(items));
    throw new Error('replacement rejected');
  }
}

class FilteringRejectedCompactionSession extends RejectedCompactionSession {
  private static isFiltered(item: AgentInputItem): boolean {
    return (
      item.type === 'message' &&
      item.role === 'user' &&
      item.content.some(
        (part) => part.type === 'input_text' && part.text === 'filtered prefix',
      )
    );
  }

  override async addItems(items: AgentInputItem[]) {
    await super.addItems(
      items.filter((item) => !FilteringRejectedCompactionSession.isFiltered(item)),
    );
  }

  prepareHistoryItemsForPersistenceComparison(
    items: AgentInputItem[],
  ): AgentInputItem[] {
    return items.filter(
      (item) => !FilteringRejectedCompactionSession.isFiltered(item),
    );
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('inline compaction session persistence', () => {
  it('delivers items before the compaction marker to append-only sessions', async () => {
    const session = new AppendOnlyCompactionSession();
    const before = userMessage('new input before compaction');
    const after = userMessage('input after compaction');

    await saveStreamInputToSession(session, [before, COMPACTION, after]);

    expect(session.items).toEqual([
      userMessage('stored before run'),
      before,
      COMPACTION,
      after,
    ]);
    expect(session.replacements).toEqual([[COMPACTION, after]]);
    expect(session.clearCalls).toBe(0);
  });

  it('keeps session identity when compaction was accepted before an ambiguous failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = new AcceptedThenRejectedCompactionSession();
    const before = userMessage('new input before compaction');
    const after = userMessage('input after compaction');

    await expect(
      saveStreamInputToSession(session, [before, COMPACTION, after]),
    ).resolves.toBeUndefined();

    expect(session.items).toEqual([
      userMessage('stored before run'),
      before,
      COMPACTION,
      after,
    ]);
    expect(session.clearCalls).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('rolls back the prefix without clearing when compaction replacement fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = new RejectedCompactionSession();
    const before = userMessage('new input before compaction');
    const after = userMessage('input after compaction');

    await expect(
      saveStreamInputToSession(session, [before, COMPACTION, after]),
    ).rejects.toThrow('replacement rejected');

    expect(session.items).toEqual([userMessage('stored before run')]);
    expect(session.clearCalls).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('does not pop old history for prefix items filtered by persistence', async () => {
    const session = new FilteringRejectedCompactionSession();
    const filtered = userMessage('filtered prefix');
    const after = userMessage('input after compaction');

    await expect(
      saveStreamInputToSession(session, [filtered, COMPACTION, after]),
    ).rejects.toThrow('replacement rejected');

    expect(session.items).toEqual([userMessage('stored before run')]);
    expect(session.clearCalls).toBe(0);
  });
});
