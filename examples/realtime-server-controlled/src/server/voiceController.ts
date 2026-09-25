import type { PublicEvent } from '../shared/publicEvents';
import { projectRealtimeEvent } from './publicEventProjection';
import type { RealtimeCall } from './realtimeCall';
import type { ManagedRealtimeSession, SessionManager } from './sessionManager';
import type { SidebandSession } from './sidebandReady';

export type ControllerSession = ManagedRealtimeSession &
  SidebandSession & {
    on(event: 'error', listener: () => void): unknown;
    on(event: 'transport_event', listener: (event: unknown) => void): unknown;
    transport: {
      on(event: 'disconnected', listener: () => void): unknown;
    };
  };

export type VoiceControllerOptions = {
  apiKey: string;
  connectSideband: (
    session: SidebandSession,
    options: { apiKey: string; callId: string },
  ) => Promise<void>;
  createCall: (options: {
    offerSdp: string;
    safetyIdentifier: string;
    signal?: AbortSignal;
  }) => Promise<RealtimeCall>;
  createSession: (options: {
    onDisconnected: () => void;
    onError: () => void;
    onPublicEvent: (event: PublicEvent) => void;
    ownerId: string;
  }) => ControllerSession;
  sessions: SessionManager;
};

export class VoiceController {
  readonly #options: VoiceControllerOptions;

  constructor(options: VoiceControllerOptions) {
    this.#options = options;
  }

  async start(options: {
    offerSdp: string;
    ownerId: string;
    safetyIdentifier: string;
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<{ answerSdp: string; sessionId: string }> {
    const sessionId = this.#options.sessions.reserve(
      options.ownerId,
      options.sessionId,
    );
    let detachedCallId: string | undefined;

    try {
      const call = await this.#options.createCall({
        offerSdp: options.offerSdp,
        safetyIdentifier: options.safetyIdentifier,
        signal: options.signal,
      });
      detachedCallId = call.callId;
      this.#throwIfAborted(options.signal);

      if (!this.#options.sessions.attachCall(sessionId, call.callId)) {
        throw new Error('The application session closed during call creation.');
      }
      detachedCallId = undefined;

      const realtimeSession = this.#options.createSession({
        ownerId: options.ownerId,
        onDisconnected: () => {
          this.#options.sessions.publish(sessionId, {
            type: 'app.error',
            code: 'VOICE_SESSION_DISCONNECTED',
          });
          void this.#options.sessions.close(sessionId).catch(() => {
            // The session manager retains failed hangups for the next sweep.
          });
        },
        onError: () => {
          this.#options.sessions.publish(sessionId, {
            type: 'app.error',
            code: 'VOICE_SESSION_ERROR',
          });
        },
        onPublicEvent: (event) =>
          this.#options.sessions.publish(sessionId, event),
      });
      if (
        !this.#options.sessions.attachRealtimeSession(
          sessionId,
          realtimeSession,
        )
      ) {
        realtimeSession.close();
        throw new Error('The application session closed during setup.');
      }

      await this.#options.connectSideband(realtimeSession, {
        apiKey: this.#options.apiKey,
        callId: call.callId,
      });
      this.#throwIfAborted(options.signal);
      if (!this.#options.sessions.activate(sessionId)) {
        throw new Error('The application session closed during setup.');
      }
      return { answerSdp: call.answerSdp, sessionId };
    } catch (error) {
      await this.#options.sessions.close(sessionId).catch(() => {
        // Preserve the setup error; cleanup remains owned by the manager.
      });
      if (detachedCallId) {
        try {
          await this.#options.sessions.closeDetachedCall(detachedCallId);
        } catch {
          // Preserve the setup error; the manager retains the detached call ID.
        }
      }
      throw error;
    }
  }

  static wireSessionEvents(
    session: ControllerSession,
    callbacks: {
      onDisconnected: () => void;
      onError: () => void;
      onPublicEvent: (event: PublicEvent) => void;
    },
  ): void {
    session.on('transport_event', (event) => {
      const projected = projectRealtimeEvent(event);
      if (projected) {
        callbacks.onPublicEvent(projected);
      }
    });
    session.on('error', callbacks.onError);
    session.transport.on('disconnected', callbacks.onDisconnected);
  }

  #throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('The browser cancelled session setup.');
    }
  }
}
