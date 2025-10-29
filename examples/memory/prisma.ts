import type { AgentInputItem, Session } from '@openai/agents';
import { Agent, protocol, run } from '@openai/agents';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import * as process from 'node:process';

/**
 * Minimal subset of the Prisma client surface we rely on. Defining this shape here keeps the
 * example buildable even when @prisma/client has not been generated yet.
 */
export type PrismaSessionOptions = {
  /**
   * A Prisma client instance that has been generated from the schema in this folder.
   */
  client: PrismaClient;
  /**
   * Optional existing session identifier.
   */
  sessionId?: string;
  /**
   * Disable transactions when using providers that do not support them (e.g., PlanetScale).
   */
  useTransactions?: boolean;
};

/**
 * Stores agent history in a Prisma-backed relational store. The accompanying schema is located in
 * `examples/memory/prisma/schema.prisma`.
 */
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
    if (!items.length) return;
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
      if (payload.length === 0) return;
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
      if (!latest) return undefined;
      await client.sessionItem.delete({ where: { id: latest.id } });
      const raw =
        typeof latest.item === 'string' ? JSON.parse(latest.item) : latest.item;
      return coerceAgentItem(raw) ?? undefined;
    });
  }

  async clearSession(): Promise<void> {
    if (!this.#sessionId) return;
    try {
      await this.#client.session.delete({ where: { id: this.#sessionId } });
    } catch {
      // Ignore missing sessions.
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

function coerceAgentItem(raw: unknown): AgentInputItem | undefined {
  const parsed = protocol.ModelItem.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data as AgentInputItem;
}

async function createSession(): Promise<{
  session: PrismaSession;
  prisma: PrismaClient;
}> {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'file:./dev.db';
    console.warn(
      'DATABASE_URL was not set. Defaulting to sqlite db at file:./dev.db',
    );
  }
  const prisma = new PrismaClient();
  const session = new PrismaSession({ client: prisma });
  return { session, prisma };
}

async function main() {
  const { session, prisma } = await createSession();
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You are a helpful assistant. be VERY concise.',
  });

  try {
    let result = await run(
      agent,
      'What is the largest country in South America?',
      { session },
    );
    console.log(result.finalOutput);

    result = await run(agent, 'What is the capital of that country?', {
      session,
    });
    console.log(result.finalOutput);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

async function mainStream() {
  const { session, prisma } = await createSession();
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You are a helpful assistant. be VERY concise.',
  });

  try {
    let result = await run(
      agent,
      'What is the largest country in South America?',
      {
        stream: true,
        session,
      },
    );

    for await (const event of result) {
      if (
        event.type === 'raw_model_stream_event' &&
        event.data.type === 'output_text_delta'
      ) {
        process.stdout.write(event.data.delta);
      }
    }
    console.log();

    result = await run(agent, 'What is the capital of that country?', {
      stream: true,
      session,
    });

    for await (const chunk of result.toTextStream()) {
      process.stdout.write(chunk);
    }
    console.log();
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

async function promptAndRun() {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const isStream = await rl.question('Run in stream mode? (y/n): ');
  rl.close();
  if (isStream.trim().toLowerCase() === 'y') {
    await mainStream();
  } else {
    await main();
  }
}

promptAndRun().catch((error) => {
  console.error(error);
  process.exit(1);
});
