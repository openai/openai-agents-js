import type { Server } from 'node:http';
import type { SessionManager } from './sessionManager';

export async function shutdownApiServer(
  server: Server,
  sessions: SessionManager,
): Promise<void> {
  const serverClosed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await Promise.all([serverClosed, sessions.closeAll()]);
}
