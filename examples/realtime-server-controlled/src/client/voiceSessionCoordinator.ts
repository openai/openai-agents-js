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
  remoteClosePromise: Promise<void> | null;
  sessionId: string | null;
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
  createConnection(): VoiceConnection;
  exchangeOffer(input: {
    offerSdp: string;
    onSessionCreated(sessionId: string): Promise<void>;
    signal: AbortSignal;
    token: string;
  }): Promise<string>;
  getCsrfToken(): Promise<string>;
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
  #latestAttempt: SessionAttempt | null = null;
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
      remoteClosePromise: null,
      sessionId: null,
      token: null,
    };
    this.#activeAttempt = attempt;
    this.#latestAttempt = attempt;
    this.#options.onStatus('connecting');
    this.#publishControls();

    try {
      const token = await this.#options.getCsrfToken();
      if (this.#activeAttempt !== attempt) {
        return;
      }
      attempt.token = token;
      const connection = this.#options.createConnection();
      attempt.connection = connection;
      await connection.connect(async (offerSdp, signal) => {
        return this.#options.exchangeOffer({
          offerSdp,
          onSessionCreated: async (sessionId) => {
            attempt.sessionId = sessionId;
            if (attempt.closed) {
              await this.#closeRemote(attempt);
              throw new Error('The voice-session attempt is no longer active.');
            }
          },
          signal,
          token,
        });
      });
      if (this.#activeAttempt !== attempt) {
        await this.#cleanup(attempt);
        return;
      }

      attempt.eventStream = this.#options.openEvents({
        sessionId: attempt.sessionId!,
        onMessage: (value) => this.#handlePublicEvent(attempt, value),
        onError: () => {
          if (this.#activeAttempt === attempt) {
            this.#options.onStatus('error');
          }
        },
      });
      this.#publishControls();
    } catch {
      const isCurrent = this.#activeAttempt === attempt;
      if (isCurrent) {
        this.#activeAttempt = null;
        this.#options.onStatus('error');
      }
      await this.#cleanup(attempt);
      if (isCurrent) {
        this.#publishControls();
      }
    }
  }

  async stop(options: { keepError?: boolean } = {}): Promise<void> {
    const attempt = this.#activeAttempt;
    if (!attempt) {
      if (!options.keepError) {
        this.#options.onStatus('ready');
      }
      this.#publishControls();
      return;
    }

    this.#activeAttempt = null;
    this.#publishControls();
    await this.#cleanup(attempt);
    if (!options.keepError && this.#latestAttempt === attempt) {
      this.#options.onStatus('ready');
    }
  }

  toggleMuted(): void {
    const connection = this.#activeAttempt?.connection;
    if (!connection) {
      return;
    }
    connection.setMuted(!connection.muted);
    this.#publishControls();
  }

  async #cleanup(attempt: SessionAttempt): Promise<void> {
    attempt.closed = true;
    attempt.eventStream?.close();
    attempt.eventStream = null;
    attempt.connection?.close();
    attempt.connection = null;
    await this.#closeRemote(attempt);
  }

  async #closeRemote(attempt: SessionAttempt): Promise<void> {
    if (!attempt.sessionId || !attempt.token) {
      return;
    }
    attempt.remoteClosePromise ??= this.#options
      .closeRemoteSession(attempt.sessionId, attempt.token)
      .catch(() => {});
    await attempt.remoteClosePromise;
  }

  #handlePublicEvent(attempt: SessionAttempt, value: unknown): void {
    if (
      this.#activeAttempt !== attempt ||
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
      attempt.sessionId = null;
      void this.stop();
    }
  }

  #publishControls(): void {
    const connection = this.#activeAttempt?.connection ?? null;
    const active = Boolean(this.#activeAttempt);
    this.#options.onControls({
      canMute: Boolean(connection),
      canStart: !active,
      canStop: active,
      muted: connection?.muted ?? false,
    });
  }
}
