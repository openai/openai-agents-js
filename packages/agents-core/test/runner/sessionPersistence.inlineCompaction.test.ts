import { describe, expect, it } from 'vitest';

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
    this.items = [];
  }
}

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
  });
});
