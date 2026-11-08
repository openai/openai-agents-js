/** Admission for one native callback owner/turn, including reply settlement. */
export class FunctionAdmission {
  private active = 0;
  private failure?: { error: unknown };
  private readonly waiters = new Set<{
    grant(): void;
    reject(error: unknown): void;
    removeAbort(): void;
  }>();

  constructor(private readonly limit: number) {}

  check(): void {
    if (this.failure) throw this.failure.error;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.failure) return Promise.reject(this.failure.error);
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiters.delete(waiter);
        reject(signal.reason);
      };
      const waiter = {
        grant: () => resolve(() => this.release()),
        reject,
        removeAbort: () => signal.removeEventListener('abort', abort),
      };
      this.waiters.add(waiter);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  /** Seal before releasing a failed callback's permit, not in an outer catch. */
  seal(error: unknown): void {
    this.failure ??= { error };
    for (const waiter of this.waiters) {
      waiter.removeAbort();
      waiter.reject(this.failure.error);
    }
    this.waiters.clear();
  }

  private release(): void {
    this.active--;
    if (this.failure) return;
    const waiter = this.waiters.values().next().value;
    if (waiter) {
      this.waiters.delete(waiter);
      waiter.removeAbort();
      this.active++;
      waiter.grant();
    }
  }
}

export function validateMaxFunctionConcurrency(
  value: number | undefined,
): number | undefined {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0))
    throw new TypeError('maxFunctionConcurrency must be a positive integer');
  return value;
}
