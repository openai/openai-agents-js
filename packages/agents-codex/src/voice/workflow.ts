import type { Session } from '../runtime/public-agent';
import type { OperationOptions, Turn } from '../runtime/session';

export interface VoiceWorkflow {
  run(
    transcription: string,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<string>;
}

interface ActiveVoiceTurn {
  controller: AbortController;
  submission?: Promise<Turn<string>>;
  cancellation?: Promise<void>;
  settled: boolean;
  cleaned: boolean;
  finished: boolean;
  graphClosed: ReturnType<typeof Promise.withResolvers<void>>;
}

const graphShutdown = new WeakMap<NativeSessionVoiceWorkflow, () => void>();
/** Internal receipt after Session has confirmed native graph teardown, never a public cancellation shortcut. */
export function voiceWorkflowGraphClosed(
  workflow: NativeSessionVoiceWorkflow,
): void {
  graphShutdown.get(workflow)?.();
}

function beforeGraphClose<T>(
  active: ActiveVoiceTurn,
  pending: Promise<T>,
): Promise<T> {
  return Promise.race([
    pending,
    active.graphClosed.promise.then(() => {
      throw active.controller.signal.reason;
    }),
  ]);
}

/** Speaks only a caller-owned Session's validated final string, after settlement.
 * It never approves requests or closes the Session. Structured output needs a custom VoiceWorkflow.
 */
export class NativeSessionVoiceWorkflow implements VoiceWorkflow {
  private active?: ActiveVoiceTurn;
  private readonly tools: OperationOptions<any>['tools'];

  /** Capture a tool ceiling; omission uses Session defaults and [] selects no tools. */
  constructor(
    private readonly session: Session<string, any>,
    tools?: OperationOptions<any>['tools'],
  ) {
    this.tools = tools === undefined ? undefined : Object.freeze([...tools]);
    graphShutdown.set(this, () => {
      const active = this.active;
      if (!active) return;
      active.cleaned = true;
      active.controller.abort(new Error('Native Session graph closed'));
      active.graphClosed.resolve();
    });
  }

  async cancel(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    active.cancellation ??= (async () => {
      const turn = await Promise.race([
        active.submission?.catch(() => undefined),
        active.graphClosed.promise.then(() => undefined),
      ]);
      if (turn && !active.settled)
        await Promise.race([turn.cancel(), active.graphClosed.promise]);
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
      graphClosed: Promise.withResolvers<void>(),
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
        return this.tools === undefined
          ? this.session.submit(transcription)
          : this.session.submit(transcription, { tools: this.tools });
      });
      const turn = await beforeGraphClose(active, active.submission);
      active.controller.signal.throwIfAborted();
      const completed = await beforeGraphClose(active, turn.wait());
      active.controller.signal.throwIfAborted();
      active.settled = true;
      if (typeof completed.finalOutput !== 'string')
        throw new TypeError(
          'Native voice requires a string final output; use a custom VoiceWorkflow for structured output',
        );
      yield completed.finalOutput;
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
