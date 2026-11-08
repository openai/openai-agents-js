import type { Turn } from './session';

/** One response's native work; several batches can share one actual root Turn. */
export class NativeRealtimeToolBatch {
  retired = false;
  admitted = false;
  cleaned = false;
  finished = false;
  root?: Turn<unknown>;
  task?: Promise<void>;
  private submission?: Promise<Turn<unknown>>;
  private cancellation?: Promise<void>;
  private readonly controller = new AbortController();
  private readonly completion = Promise.withResolvers<void>();
  private readonly graphClosed = Promise.withResolvers<void>();
  constructor(
    readonly responseId: string,
    readonly callIds: readonly string[],
    private readonly submit: (signal: AbortSignal) => Promise<Turn<unknown>>,
  ) {
    void this.completion.promise.catch(() => {});
  }

  complete(): void {
    this.finished = true;
    this.completion.resolve();
  }
  fail(error: unknown): void {
    this.finished = true;
    this.completion.reject(error);
  }
  /** Successful native interruption/close joins this batch's actual work. */
  retiredByCore(): void {
    this.complete();
  }
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
        this.controller.signal.throwIfAborted();
        return this.submit(this.controller.signal);
      });
      this.root = await this.beforeGraphClose(this.submission);
      this.admitted = true;
      await this.beforeGraphClose(this.completion.promise);
      if (this.retired) throw new Error('Realtime tool batch stopped');
      this.cleaned = true;
    } catch (error) {
      primary = { error };
    }
    if (!this.cleaned) await this.cleanup();
    if (primary) throw primary.error;
  }
  cancel(): Promise<void> {
    this.retired = true;
    this.controller.abort(new Error('Realtime tool batch stopped'));
    return this.cleanup();
  }
  private cleanup(): Promise<void> {
    if (this.cleaned) return Promise.resolve();
    return (this.cancellation ??= (async () => {
      const root = await Promise.race([
        this.submission?.catch(() => undefined),
        this.graphClosed.promise.then(() => undefined),
      ]);
      if (root)
        await Promise.race([
          this.completion.promise.catch(() => {}),
          this.graphClosed.promise,
        ]);
      this.cleaned = true;
    })().catch((error) => {
      this.cancellation = undefined;
      throw error;
    }));
  }
}
