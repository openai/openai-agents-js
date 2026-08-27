import { randomUUID } from 'node:crypto';
import type { PublicEvent } from '../shared/publicEvents';

export type ManagedRealtimeSession = {
  close(): void;
};

export type PublicEventClient = {
  close(): void;
  send(event: PublicEvent): void;
};

type SessionState = 'active' | 'closing' | 'creating';

export class SessionConflictError extends Error {
  constructor() {
    super('This user already has an active voice session.');
    this.name = 'SessionConflictError';
  }
}

export class SessionCapacityError extends Error {
  constructor(message = 'The voice session capacity has been reached.') {
    super(message);
    this.name = 'SessionCapacityError';
  }
}

type SessionRecord = {
  agentState: 'idle' | 'listening' | 'speaking' | 'thinking';
  callId?: string;
  clients: Set<PublicEventClient>;
  closePromise?: Promise<void>;
  createdAt: number;
  id: string;
  lastEvent?: string;
  ownerId: string;
  ready: boolean;
  realtimeSession?: ManagedRealtimeSession;
  state: SessionState;
};

export class SessionManager {
  #acceptingSessions = true;
  readonly #hangup: (callId: string) => Promise<void>;
  readonly #maxSessions: number;
  readonly #now: () => number;
  readonly #ownerSessions = new Map<string, string>();
  readonly #sessions = new Map<string, SessionRecord>();

  constructor(options: {
    hangup: (callId: string) => Promise<void>;
    maxSessions?: number;
    now?: () => number;
  }) {
    this.#hangup = options.hangup;
    this.#maxSessions = options.maxSessions ?? 100;
    this.#now = options.now ?? Date.now;
  }

  reserve(ownerId: string): string {
    if (!this.#acceptingSessions) {
      throw new SessionCapacityError('The voice service is shutting down.');
    }
    if (this.#ownerSessions.has(ownerId)) {
      throw new SessionConflictError();
    }
    if (this.#sessions.size >= this.#maxSessions) {
      throw new SessionCapacityError();
    }

    const id = randomUUID();
    this.#sessions.set(id, {
      agentState: 'idle',
      clients: new Set(),
      createdAt: this.#now(),
      id,
      ownerId,
      ready: false,
      state: 'creating',
    });
    this.#ownerSessions.set(ownerId, id);
    return id;
  }

  attachCall(id: string, callId: string): boolean {
    const session = this.#sessions.get(id);
    if (!session || session.state !== 'creating') {
      return false;
    }
    session.callId = callId;
    return true;
  }

  attachRealtimeSession(
    id: string,
    realtimeSession: ManagedRealtimeSession,
  ): boolean {
    const session = this.#sessions.get(id);
    if (!session || session.state !== 'creating') {
      return false;
    }
    session.realtimeSession = realtimeSession;
    return true;
  }

  activate(id: string): boolean {
    const session = this.#sessions.get(id);
    if (!session || session.state !== 'creating') {
      return false;
    }
    session.state = 'active';
    this.publish(id, { type: 'app.session.ready' });
    return true;
  }

  publish(id: string, event: PublicEvent): void {
    const session = this.#sessions.get(id);
    if (!session || session.state === 'closing') {
      return;
    }

    const serialized = JSON.stringify(event);
    if (serialized === session.lastEvent) {
      return;
    }
    session.lastEvent = serialized;
    if (event.type === 'app.session.ready') {
      session.ready = true;
    } else if (event.type === 'app.agent.state') {
      session.agentState = event.state;
    }
    for (const client of session.clients) {
      client.send(event);
    }
  }

  ownsActive(id: string, ownerId: string): boolean {
    const session = this.#sessions.get(id);
    return session?.ownerId === ownerId && session.state === 'active';
  }

  subscribe(
    id: string,
    ownerId: string,
    client: PublicEventClient,
  ): (() => void) | null {
    const session = this.#sessions.get(id);
    if (!session || session.ownerId !== ownerId || session.state !== 'active') {
      return null;
    }
    session.clients.add(client);
    if (session.ready) {
      client.send({ type: 'app.session.ready' });
    }
    client.send({ type: 'app.agent.state', state: session.agentState });
    return () => session.clients.delete(client);
  }

  async close(id: string, ownerId?: string): Promise<boolean> {
    const session = this.#sessions.get(id);
    if (!session || (ownerId && session.ownerId !== ownerId)) {
      return false;
    }
    if (session.closePromise) {
      await session.closePromise;
      return true;
    }

    session.state = 'closing';
    this.#ownerSessions.delete(session.ownerId);
    const closePromise = Promise.resolve().then(async () => {
      for (const client of session.clients) {
        client.send({ type: 'app.session.closed' });
        client.close();
      }
      session.clients.clear();

      try {
        session.realtimeSession?.close();
      } catch {
        // Cleanup continues so the remote call is still terminated.
      }

      if (session.callId) {
        try {
          await this.#hangup(session.callId);
        } catch {
          // A failed or already-ended call must not block local cleanup.
        }
      }
      this.#sessions.delete(id);
    });
    session.closePromise = closePromise;
    await closePromise;
    return true;
  }

  async closeExpired(maxAgeMs: number): Promise<void> {
    const cutoff = this.#now() - maxAgeMs;
    const expired = [...this.#sessions.values()]
      .filter((session) => session.createdAt < cutoff)
      .map((session) => session.id);
    await Promise.all(expired.map((id) => this.close(id)));
  }

  async closeAll(): Promise<void> {
    this.#acceptingSessions = false;
    await Promise.all([...this.#sessions.keys()].map((id) => this.close(id)));
  }
}
