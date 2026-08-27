import type { AgentState, PublicEvent } from '../shared/publicEvents';

export type VoiceSessionStatus = AgentState | 'connecting' | 'error' | 'ready';

export type VoiceConnection = {
  close(): void;
  connect(
    exchangeSdp: (offerSdp: string, signal: AbortSignal) => Promise<string>,
  ): Promise<void>;
  readonly muted: boolean;
  setMuted(muted: boolean): void;
};

export type PublicEventStream = {
  close(): void;
};

type SessionAttempt = {
  closed: boolean;
  connection: VoiceConnection | null;
  eventStream: PublicEventStream | null;
  cleanupPromise: Promise<void> | null;
  sessionId: string;
  token: string | null;
};

export type VoiceSessionControls = {
  canMute: boolean;
  canStart: boolean;
  canStop: boolean;
  muted: boolean;
};

export type VoiceSessionCoordinatorOptions = {
  closeRemoteSession(sessionId: string, token: string): Promise<void>;
  createConnection(options: { onError(): void }): VoiceConnection;
  exchangeOffer(input: {
    offerSdp: string;
    sessionId: string;
    signal: AbortSignal;
    token: string;
  }): Promise<string>;
  getCsrfToken(signal: AbortSignal): Promise<string>;
  onControls(controls: VoiceSessionControls): void;
  onStatus(status: VoiceSessionStatus): void;
  openEvents(input: {
    onError(): void;
    onMessage(value: unknown): void;
    sessionId: string;
  }): PublicEventStream;
};

function isAgentState(value: unknown): value is AgentState {
  return ['idle', 'listening', 'thinking', 'speaking'].includes(String(value));
}

export class VoiceSessionCoordinator {
  #activeAttempt: SessionAttempt | null = null;
  readonly #options: VoiceSessionCoordinatorOptions;

  constructor(options: VoiceSessionCoordinatorOptions) {
    this.#options = options;
    this.#publishControls();
  }

  async start(): Promise<void> {
    if (this.#activeAttempt) {
      return;
    }

    const attempt: SessionAttempt = {
      closed: false,
      connection: null,
      eventStream: null,
      cleanupPromise: null,
      sessionId: crypto.randomUUID(),
      token: null,
    };
    this.#activeAttempt = attempt;
    this.#options.onStatus('connecting');
    this.#publishControls();

    try {
      const connection = this.#options.createConnection({
        onError: () => {
          if (!attempt.closed && this.#activeAttempt === attempt) {
            void this.#finish(attempt, 'error');
          }
        },
      });
      attempt.connection = connection;
      await connection.connect(async (offerSdp, signal) => {
        const token = await this.#options.getCsrfToken(signal);
        if (attempt.closed || this.#activeAttempt !== attempt) {
          throw new Error('The voice-session attempt is no longer active.');
        }
        attempt.token = token;
        return this.#options.exchangeOffer({
          offerSdp,
          sessionId: attempt.sessionId,
          signal,
          token,
        });
      });
      if (attempt.closed || this.#activeAttempt !== attempt) {
        return;
      }

      attempt.eventStream = this.#options.openEvents({
        sessionId: attempt.sessionId,
        onMessage: (value) => this.#handlePublicEvent(attempt, value),
        onError: () => {
          if (!attempt.closed && this.#activeAttempt === attempt) {
            this.#options.onStatus('error');
          }
        },
      });
      this.#publishControls();
    } catch {
      if (attempt.closed || this.#activeAttempt !== attempt) {
        return;
      }
      await this.#finish(attempt, 'error');
    }
  }

  async stop(): Promise<void> {
    const attempt = this.#activeAttempt;
    if (!attempt) {
      this.#options.onStatus('ready');
      this.#publishControls();
      return;
    }

    await this.#finish(attempt, 'ready');
  }

  toggleMuted(): void {
    const connection = this.#activeAttempt?.connection;
    if (!connection) {
      return;
    }
    connection.setMuted(!connection.muted);
    this.#publishControls();
  }

  #finish(attempt: SessionAttempt, status: 'error' | 'ready'): Promise<void> {
    if (attempt.cleanupPromise) {
      return attempt.cleanupPromise;
    }
    attempt.closed = true;
    if (status === 'error') {
      this.#options.onStatus('error');
    }
    attempt.eventStream?.close();
    attempt.eventStream = null;
    attempt.connection?.close();
    attempt.connection = null;
    attempt.cleanupPromise = Promise.resolve().then(async () => {
      try {
        if (attempt.token) {
          await this.#options.closeRemoteSession(
            attempt.sessionId,
            attempt.token,
          );
        }
      } catch {
        // Retain the attempt and its ID; the next Stop retries this request.
        attempt.cleanupPromise = null;
        if (this.#activeAttempt === attempt) {
          this.#options.onStatus('error');
          this.#publishControls();
        }
        return;
      }
      if (this.#activeAttempt === attempt) {
        this.#activeAttempt = null;
        this.#options.onStatus(status);
        this.#publishControls();
      }
    });
    this.#publishControls();
    return attempt.cleanupPromise;
  }

  #handlePublicEvent(attempt: SessionAttempt, value: unknown): void {
    if (
      this.#activeAttempt !== attempt ||
      attempt.closed ||
      typeof value !== 'object' ||
      value === null ||
      !('type' in value)
    ) {
      return;
    }
    const event = value as Partial<PublicEvent> & { state?: unknown };
    if (event.type === 'app.session.ready') {
      this.#options.onStatus('idle');
    } else if (event.type === 'app.agent.state' && isAgentState(event.state)) {
      this.#options.onStatus(event.state);
    } else if (event.type === 'app.error') {
      this.#options.onStatus('error');
    } else if (event.type === 'app.session.closed') {
      void this.stop();
    }
  }

  #publishControls(): void {
    const connection = this.#activeAttempt?.connection ?? null;
    const active = Boolean(this.#activeAttempt);
    this.#options.onControls({
      canMute: Boolean(connection),
      canStart: !active,
      canStop: active && !this.#activeAttempt?.cleanupPromise,
      muted: connection?.muted ?? false,
    });
  }
}
