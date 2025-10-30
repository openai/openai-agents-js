// Minimal fallback types so the example can compile when @prisma/client has not
// been generated yet (e.g., in CI where Prisma migrations are not run). When the
// real client is available, these declarations merge with the generated ones.

declare module '@prisma/client' {
  export namespace Prisma {
    interface SessionItemCreateManyInput {
      sessionId: string;
      position: number;
      item: string;
    }

    type TransactionClient = PrismaClient;
  }

  type UpsertArgs = {
    where: { id: string };
    create: { id: string };
    update: Record<string, never>;
  };

  type SessionItemSelect = { id?: true; position?: true; item?: true };

  type SessionItemQueryArgs = {
    where: { sessionId: string };
    orderBy: { position: 'asc' | 'desc' };
    select?: SessionItemSelect;
    take?: number;
  };

  interface SessionDelegate {
    upsert(args: UpsertArgs): Promise<unknown>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  }

  interface SessionItemDelegate {
    findMany(
      args: SessionItemQueryArgs,
    ): Promise<Array<{ id?: string; position?: number; item?: unknown }>>;
    findFirst(
      args: SessionItemQueryArgs,
    ): Promise<{ id?: string; position?: number; item?: unknown } | null>;
    createMany(args: {
      data: Prisma.SessionItemCreateManyInput[];
    }): Promise<unknown>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  }

  export class PrismaClient {
    session: SessionDelegate;
    sessionItem: SessionItemDelegate;
    $transaction<T>(
      fn: (client: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T>;
    $disconnect(): Promise<void>;
  }
}
