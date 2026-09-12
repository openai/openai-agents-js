import { resolve } from 'node:path';

// Prisma 6 resolves SQLite file URLs relative to the schema directory. Keep the
// CLI and driver adapter on that same database, regardless of the caller's cwd.
export function resolvePrismaDatabaseUrl(databaseUrl: string): string {
  return databaseUrl.startsWith('file:')
    ? `file:${resolve(__dirname, 'prisma', databaseUrl.slice('file:'.length))}`
    : databaseUrl;
}
