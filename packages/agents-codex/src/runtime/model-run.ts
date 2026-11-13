import type { ModelRunOwner, NativeModel } from './models';
import { NativeError } from './native-error';

/** One existing run's optional model resources; never serialized. */
export class ModelRun {
  readonly owner: ModelRunOwner;
  readonly errors: unknown[] = [];
  closed = false;
  private readonly models = new Map<
    NativeModel,
    NonNullable<NativeModel['cleanupOnRunEnd']>
  >();
  private pending?: Promise<void>;

  constructor(sessionId: string, turnId: string) {
    this.owner = Object.freeze({ sessionId, turnId });
  }

  admit(
    model: NativeModel,
    cleanup: NonNullable<NativeModel['cleanupOnRunEnd']>,
  ): ModelRunOwner {
    if (this.pending)
      throw new NativeError('Model run cleanup has already started');
    if (!this.models.has(model)) this.models.set(model, cleanup);
    return this.owner;
  }

  close(): Promise<void> {
    return (this.pending ??= Promise.resolve().then(async () => {
      const models = [...this.models];
      this.models.clear();
      const settled = await Promise.allSettled(
        models.map(([model, cleanup]) =>
          Promise.resolve().then(() => cleanup.call(model, this.owner)),
        ),
      );
      for (const result of settled)
        if (result.status === 'rejected') this.errors.push(result.reason);
      this.closed = true;
    }));
  }
}
