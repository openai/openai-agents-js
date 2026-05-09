import { describe, expect, it } from 'vitest';

import type { AgentInputItem } from '@openai/agents';
import { PrismaSession } from './prisma';

type StoredSessionItem = {
  id: string;
  sessionId: string;
  position: number;
  item: unknown;
};

class FakePrismaClient {
  items: StoredSessionItem[] = [];
  #nextId = 1;

  session = {
    upsert: async () => ({}),
    delete: async () => ({}),
  };

  sessionItem = {
    findMany: async (args: {
      where: { sessionId: string };
      orderBy: { position: 'asc' | 'desc' };
      take?: number;
    }) => {
      const sorted = this.#query(args.where.sessionId, args.orderBy.position);
      return typeof args.take === 'number'
        ? sorted.slice(0, args.take)
        : sorted;
    },
    findFirst: async (args: {
      where: { sessionId: string };
      orderBy: { position: 'asc' | 'desc' };
    }) => this.#query(args.where.sessionId, args.orderBy.position)[0] ?? null,
    createMany: async (args: {
      data: Array<{ sessionId: string; position: number; item: string }>;
    }) => {
      for (const item of args.data) {
        this.items.push({ id: String(this.#nextId++), ...item });
      }
    },
    delete: async (args: { where: { id: string } }) => {
      this.items = this.items.filter((item) => item.id !== args.where.id);
    },
  };

  $transaction = async <T>(fn: (client: FakePrismaClient) => Promise<T>) =>
    await fn(this);

  $disconnect = async () => {};

  #query(sessionId: string, order: 'asc' | 'desc') {
    return this.items
      .filter((item) => item.sessionId === sessionId)
      .sort((a, b) =>
        order === 'desc' ? b.position - a.position : a.position - b.position,
      );
  }
}

const userItem = (content: string) =>
  ({ role: 'user', content }) as AgentInputItem;

describe('PrismaSession', () => {
  it('skips corrupt records when reading items', async () => {
    const client = new FakePrismaClient();
    const session = new PrismaSession({
      client: client as any,
      sessionId: 's1',
    });
    await session.addItems([userItem('valid')]);
    client.items.push({
      id: 'bad',
      sessionId: 's1',
      position: 2,
      item: 'not valid json {{{',
    });

    const items = await session.getItems();

    expect(items.map((item) => (item as any).content)).toEqual(['valid']);
  });

  it('skips corrupt most-recent records when popping items', async () => {
    const client = new FakePrismaClient();
    const session = new PrismaSession({
      client: client as any,
      sessionId: 's1',
    });
    await session.addItems([userItem('valid')]);
    client.items.push({
      id: 'bad',
      sessionId: 's1',
      position: 999,
      item: 'not valid json {{{',
    });

    const popped = await session.popItem();

    expect((popped as any)?.content).toBe('valid');
    expect(client.items).toEqual([]);
  });

  it('drops every corrupt record before returning undefined', async () => {
    const client = new FakePrismaClient();
    const session = new PrismaSession({
      client: client as any,
      sessionId: 's1',
    });
    client.items.push(
      {
        id: 'bad1',
        sessionId: 's1',
        position: 1,
        item: 'garbage',
      },
      {
        id: 'bad2',
        sessionId: 's1',
        position: 2,
        item: 42,
      },
    );

    await expect(session.popItem()).resolves.toBeUndefined();
    expect(client.items).toEqual([]);
  });
});
