import { randomUUID } from 'node:crypto';
import { NotFoundError } from 'openai';
import type { AgentState, PublicEvent } from '../shared/publicEvents';

export type ManagedRealtimeSession = {
  close(): void;
};

export type PublicEventClient = {
  close(): void;
  send(event: PublicEvent): void;
};

type SessionState = 'active' | 'closing' | 'creating';

export class SessionConflictError extends Error {
  constructor(message = 'This user already has an active voice session.') {
    super(message);
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
  agentState: AgentState;
  callId?: string;
  clients: Set<PublicEventClient>;
  closePromise?: Promise<void>;
  createdAt: number;
  id: string;
  ownerId: string;
  realtimeSession?: ManagedRealtimeSession;
  state: SessionState;
};

export class SessionManager {
  #acceptingSessions = true;
  readonly #cancelledSetups = new Map<string, string>();
  readonly #detachedCalls = new Map<string, Promise<void> | null>();
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

  reserve(ownerId: string, id: string = randomUUID()): string {
    if (!this.#acceptingSessions) {
      throw new SessionCapacityError('The voice service is shutting down.');
    }
    const cancelledOwner = this.#cancelledSetups.get(id);
    if (cancelledOwner) {
      throw new SessionConflictError(
        cancelledOwner === ownerId
          ? 'This voice session setup was cancelled.'
          : 'This voice session identifier is already in use.',
      );
    }
    if (this.#ownerSessions.has(ownerId)) {
      throw new SessionConflictError();
    }
    if (this.#sessions.has(id)) {
      throw new SessionConflictError(
        'This voice session identifier is already in use.',
      );
    }
    if (this.#sessions.size >= this.#maxSessions) {
      throw new SessionCapacityError();
    }

    this.#sessions.set(id, {
      agentState: 'idle',
      clients: new Set(),
      createdAt: this.#now(),
      id,
      ownerId,
      state: 'creating',
    });
    this.#ownerSessions.set(ownerId, id);
    return id;
  }

  async cancel(id: string, ownerId: string): Promise<boolean> {
    const session = this.#sessions.get(id);
    if (session && session.ownerId !== ownerId) {
      return false;
    }

    const cancelledOwner = this.#cancelledSetups.get(id);
    if (cancelledOwner && cancelledOwner !== ownerId) {
      return false;
    }

    this.#cancelledSetups.set(id, ownerId);
    if (session) {
      await this.close(id, ownerId);
    }
    return true;
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

    if (event.type === 'app.agent.state') {
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
    client.send({ type: 'app.session.ready' });
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
    const closePromise = Promise.resolve().then(async () => {
      for (const client of session.clients) {
        client.send({ type: 'app.session.closed' });
        client.close();
      }
      session.clients.clear();

      const realtimeSession = session.realtimeSession;
      session.realtimeSession = undefined;
      try {
        realtimeSession?.close();
      } catch {
        // Cleanup continues so the remote call is still terminated.
      }

      if (session.callId) {
        await this.#hangupCall(session.callId);
      }
      this.#sessions.delete(id);
      this.#ownerSessions.delete(session.ownerId);
    });
    session.closePromise = closePromise;
    try {
      await closePromise;
    } catch (error) {
      // Keep the call ID and owner reservation until hangup is confirmed.
      session.closePromise = undefined;
      throw error;
    }
    return true;
  }

  async closeDetachedCall(callId: string): Promise<void> {
    const pending = this.#detachedCalls.get(callId);
    if (pending) {
      return pending;
    }
    const closing = Promise.resolve().then(() => this.#hangupCall(callId));
    this.#detachedCalls.set(callId, closing);
    try {
      await closing;
      this.#detachedCalls.delete(callId);
    } catch (error) {
      // These calls never reached an attached session, but still need cleanup.
      this.#detachedCalls.set(callId, null);
      throw error;
    }
  }

  async closeExpired(maxAgeMs: number): Promise<void> {
    const cutoff = this.#now() - maxAgeMs;
    const expired = [...this.#sessions.values()]
      .filter(
        (session) => session.state === 'closing' || session.createdAt < cutoff,
      )
      .map((session) => session.id);
    await Promise.allSettled([
      ...expired.map((id) => this.close(id)),
      ...[...this.#detachedCalls.keys()].map((id) =>
        this.closeDetachedCall(id),
      ),
    ]);
  }

  async closeAll(): Promise<void> {
    this.#acceptingSessions = false;
    this.#cancelledSetups.clear();
    await Promise.allSettled([
      ...[...this.#sessions.keys()].map((id) => this.close(id)),
      ...[...this.#detachedCalls.keys()].map((id) =>
        this.closeDetachedCall(id),
      ),
    ]);
  }

  async #hangupCall(callId: string): Promise<void> {
    try {
      await this.#hangup(callId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return;
      }
      if (this.#acceptingSessions) {
        throw error;
      }
      // Shutdown has no future sweep. Make one bounded extra attempt, also for
      // calls whose setup completes after shutdown started.
      try {
        await this.#hangup(callId);
      } catch (retryError) {
        if (retryError instanceof NotFoundError) {
          return;
        }
        console.error(
          'A Realtime call could not be terminated during shutdown.',
        );
        throw retryError;
      }
    }
  }
}
