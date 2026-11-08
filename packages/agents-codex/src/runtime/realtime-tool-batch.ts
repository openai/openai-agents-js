import type { Turn } from './session';

/** Private ownership of one response's single native tool admission. Core runs
 * the tools and publishes each correlated result; this class joins lifecycle. */
export class NativeRealtimeToolBatch {
  retired = false;
  admitted = false;
  cleaned = false;
  task?: Promise<void>;
  private submission?: Promise<Turn<unknown>>;
  private cancellation?: Promise<void>;
  private settled = false;
  private readonly graphClosed = Promise.withResolvers<void>();
  constructor(
    readonly responseId: string,
    readonly callIds: readonly string[],
    private readonly submit: () => Promise<Turn<unknown>>,
  ) {}

  afterGraphClosed(): void {
    this.retired = true;
    this.cleaned = true;
    this.graphClosed.resolve();
  }
  private beforeGraphClose<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      this.graphClosed.promise.then(() => {
        throw new Error('Native Session graph closed');
      }),
    ]);
  }
  async run(): Promise<void> {
    if (this.retired) {
      this.cleaned = true;
      return;
    }
    let primary: { error: unknown } | undefined;
    try {
      this.submission = Promise.resolve().then(() => {
        if (this.retired)
          throw new Error('Realtime tool batch stopped before admission');
        return this.submit();
      });
      const turn = await this.beforeGraphClose(this.submission);
      this.admitted = true;
      if (this.retired) throw new Error('Realtime tool batch stopped');
      await this.beforeGraphClose(turn.wait());
      if (this.retired) throw new Error('Realtime tool batch stopped');
      this.settled = true;
      this.cleaned = true;
    } catch (error) {
      primary = { error };
    }
    if (!this.settled) {
      try {
        await this.cleanup();
      } catch (error) {
        throw primary ? primary.error : error;
      }
    }
    if (primary) throw primary.error;
  }
  cancel(): Promise<void> {
    this.retired = true;
    return this.cleanup();
  }
  private cleanup(): Promise<void> {
    if (this.cleaned) return Promise.resolve();
    return (this.cancellation ??= (async () => {
      const turn = await Promise.race([
        this.submission?.catch(() => undefined),
        this.graphClosed.promise.then(() => undefined),
      ]);
      if (turn && !this.settled)
        await Promise.race([turn.cancel(), this.graphClosed.promise]);
      this.cleaned = true;
    })().catch((error) => {
      this.cancellation = undefined;
      throw error;
    }));
  }
}
