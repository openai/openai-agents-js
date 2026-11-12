import type { JsonValue } from './binding';
import type { NativeTurn } from './native-turn';

/** @internal */
export class QueuedRoots {
  private readonly pending: { run: NativeTurn; parts: JsonValue[] }[] = [];

  constructor(private readonly finishObservation: (run: NativeTurn) => void) {}

  get size(): number {
    return this.pending.length;
  }

  has(run: NativeTurn): boolean {
    return this.pending.some((entry) => entry.run === run);
  }

  register(run: NativeTurn, parts: JsonValue[]): void {
    this.pending.push({ run, parts });
  }

  withdraw(run: NativeTurn, error: unknown): void {
    const index = this.pending.findIndex((entry) => entry.run === run);
    if (index < 0) return;
    this.pending.splice(index, 1);
    this.reject(run, error);
  }

  discard(error: unknown): void {
    // Detach before abort listeners run; they cannot withdraw a different root.
    const pending = this.pending.splice(0);
    for (const { run } of pending) this.reject(run, error);
  }

  promote(
    canPromote: () => boolean,
    dispatch: (run: NativeTurn, parts: JsonValue[]) => void,
  ): void {
    if (!canPromote()) return;
    const entry = this.pending.shift();
    if (!entry) return;
    try {
      dispatch(entry.run, entry.parts);
    } catch (error) {
      this.reject(entry.run, error);
      this.promote(canPromote, dispatch);
    }
  }

  private reject(run: NativeTurn, error: unknown): void {
    run.controller.abort(error);
    run.accepted.reject(error);
    run.completion.reject(error);
    this.finishObservation(run);
  }
}
