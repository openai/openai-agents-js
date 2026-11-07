import type { Session } from '../runtime/public-agent';
import type { Turn } from '../runtime/session';

export interface VoiceWorkflow {
  run(
    transcription: string,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<string>;
}

export class VoiceEventGapError extends Error {
  constructor() {
    super('Native voice text was lost from the observation stream');
    this.name = 'VoiceEventGapError';
  }
}

interface ActiveVoiceTurn {
  controller: AbortController;
  submission?: Promise<Turn<string>>;
  cancellation?: Promise<void>;
  settled: boolean;
  cleaned: boolean;
  finished: boolean;
}

/** Speech adapter for a caller-owned Session. It never approves requests or closes the Session. */
export class NativeSessionVoiceWorkflow implements VoiceWorkflow {
  private active?: ActiveVoiceTurn;

  constructor(private readonly session: Session<string, any>) {}

  async cancel(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    active.cancellation ??= (async () => {
      const turn = await active.submission?.catch(() => undefined);
      if (turn && !active.settled) await turn.cancel();
      active.cleaned = true;
      if (active.finished && this.active === active) this.active = undefined;
    })().catch((error: unknown) => {
      active.cancellation = undefined;
      throw error;
    });
    await active.cancellation;
  }

  async *run(
    transcription: string,
    { signal }: { signal?: AbortSignal } = {},
  ): AsyncGenerator<string> {
    if (typeof transcription !== 'string' || !transcription.trim())
      throw new TypeError('Voice transcription must be nonempty text');
    if (this.active) throw new Error('Voice workflow is busy');
    signal?.throwIfAborted();
    const active = {
      controller: new AbortController(),
      settled: false,
      cleaned: false,
      finished: false,
    } as ActiveVoiceTurn;
    this.active = active;
    const abort = () => {
      void this.cancel().catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    let failed = false;
    try {
      active.submission = Promise.resolve().then(() => {
        active.controller.signal.throwIfAborted();
        return this.session.submit(transcription);
      });
      const turn = await active.submission;
      active.controller.signal.throwIfAborted();
      let started = false;
      let priorGap = false;
      for await (const event of turn.events()) {
        active.controller.signal.throwIfAborted();
        if (event.type === 'gap') {
          if (started) throw new VoiceEventGapError();
          priorGap = true;
        } else if (
          event.type === 'turn_started' &&
          event.submissionId === turn.submissionId
        ) {
          started = true;
          priorGap = false;
        } else {
          if (priorGap) throw new VoiceEventGapError();
          if (event.type === 'output_text_delta') yield event.delta;
        }
      }
      if (priorGap) throw new VoiceEventGapError();
      active.controller.signal.throwIfAborted();
      await turn.wait();
      active.controller.signal.throwIfAborted();
      active.settled = true;
    } catch (error) {
      failed = true;
      throw signal?.aborted ? signal.reason : error;
    } finally {
      signal?.removeEventListener('abort', abort);
      active.finished = true;
      try {
        if (!active.settled && !active.cleaned) {
          const cleanup = this.cancel();
          await (failed ? cleanup.catch(() => {}) : cleanup);
        }
      } finally {
        if ((active.settled || active.cleaned) && this.active === active)
          this.active = undefined;
      }
    }
  }
}
