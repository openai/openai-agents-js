import type { AgentInputItem, Session } from '@openai/agents';
import { protocol } from '@openai/agents';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import * as process from 'node:process';

export type PrismaSessionOptions = {
  client: PrismaClient;
  sessionId?: string;
  useTransactions?: boolean;
};

export class PrismaSession implements Session {
  #client: PrismaClient;
  #sessionId?: string;
  #useTransactions: boolean;

  constructor(options: PrismaSessionOptions) {
    this.#client = options.client;
    this.#sessionId = options.sessionId;
    this.#useTransactions = options.useTransactions ?? true;
  }

  async getSessionId(): Promise<string> {
    if (!this.#sessionId) {
      this.#sessionId = randomUUID().replace(/-/g, '').slice(0, 24);
    }
    const sessionId = this.#sessionId;
    await this.#client.session.upsert({
      where: { id: sessionId },
      create: { id: sessionId },
      update: {},
    });
    return sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const sessionId = await this.getSessionId();
    const take = typeof limit === 'number' && limit >= 0 ? limit : undefined;
    const records = await this.#client.sessionItem.findMany({
      where: { sessionId },
      orderBy: { position: take ? 'desc' : 'asc' },
      take,
    });
    const ordered = take ? [...records].reverse() : records;
    const result: AgentInputItem[] = [];
    for (const record of ordered) {
      const raw =
        typeof record.item === 'string' ? JSON.parse(record.item) : record.item;
      const item = coerceAgentItem(raw);
      if (item) {
        result.push(item);
      }
    }
    return result;
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (!items.length) {
      return;
    }
    const sessionId = await this.getSessionId();
    await this.#withClient(async (client) => {
      const last = await client.sessionItem.findFirst({
        where: { sessionId },
        select: { position: true },
        orderBy: { position: 'desc' },
      });
      let position = last?.position ?? 0;
      const payload: Prisma.SessionItemCreateManyInput[] = [];
      for (const raw of items) {
        const item = coerceAgentItem(raw);
        if (!item) continue;
        position += 1;
        payload.push({
          sessionId,
          position,
          item: JSON.stringify(item),
        });
      }
      if (payload.length === 0) {
        return;
      }
      await client.sessionItem.createMany({ data: payload });
    });
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const sessionId = await this.getSessionId();
    return await this.#withClient(async (client) => {
      const latest = await client.sessionItem.findFirst({
        where: { sessionId },
        select: { id: true, item: true },
        orderBy: { position: 'desc' },
      });
      if (!latest?.id) {
        return undefined;
      }
      await client.sessionItem.delete({ where: { id: latest.id } });
      const raw =
        typeof latest.item === 'string' ? JSON.parse(latest.item) : latest.item;
      return coerceAgentItem(raw) ?? undefined;
    });
  }

  async clearSession(): Promise<void> {
    if (!this.#sessionId) {
      return;
    }
    try {
      await this.#client.session.delete({ where: { id: this.#sessionId } });
    } catch {
      // ignore missing sessions
    }
    this.#sessionId = undefined;
  }

  async #withClient<T>(
    fn: (client: PrismaClient | Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (
      this.#useTransactions &&
      typeof this.#client.$transaction === 'function'
    ) {
      return this.#client.$transaction((tx) => fn(tx));
    }
    return fn(this.#client);
  }
}

export async function createPrismaSession(
  options: {
    sessionId?: string;
    useTransactions?: boolean;
    client?: PrismaClient;
    databaseUrl?: string;
  } = {},
): Promise<{ session: PrismaSession; prisma: PrismaClient }> {
  if (!options.client) {
    if (!process.env.DATABASE_URL && options.databaseUrl) {
      process.env.DATABASE_URL = options.databaseUrl;
    }
    if (!process.env.DATABASE_URL) {
      process.env.DATABASE_URL = 'file:./dev.db';
      console.warn(
        'DATABASE_URL was not set. Defaulting to sqlite db at file:./dev.db',
      );
    }
  }
  const prisma = options.client ?? new PrismaClient();
  const session = new PrismaSession({
    client: prisma,
    sessionId: options.sessionId,
    useTransactions: options.useTransactions,
  });
  return { session, prisma };
}

function coerceAgentItem(raw: unknown): AgentInputItem | undefined {
  const parsed = protocol.ModelItem.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data as AgentInputItem;
}

export type { PrismaClient } from '@prisma/client';
