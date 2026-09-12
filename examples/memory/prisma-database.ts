import { resolve } from 'node:path';

// Prisma 6 resolves SQLite file URLs relative to the schema directory. Keep the
// CLI and driver adapter on that same database, regardless of the caller's cwd.
export function resolvePrismaDatabaseUrl(databaseUrl: string): string {
  if (!databaseUrl.startsWith('file:')) {
    return databaseUrl;
  }
  const [filePath, query] = databaseUrl.slice('file:'.length).split('?');
  const resolved = `file:${resolve(__dirname, 'prisma', filePath)}`;
  return query === undefined ? resolved : `${resolved}?${query}`;
}
