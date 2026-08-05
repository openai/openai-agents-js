import {
  combineAbortSignals,
  createSiblingCancellationError,
  isAbortError,
} from '../utils/abortSignals';

type ConcurrentTask<T> = (
  signal?: AbortSignal,
  reserveFailure?: (error?: unknown) => void,
) => Promise<T>;

export async function runWithSiblingCancellation<TFirst, TSecond>(
  tasks: readonly [ConcurrentTask<TFirst>, ConcurrentTask<TSecond>],
  parentSignal?: AbortSignal,
  onFirstFailure?: () => void,
): Promise<[TFirst, TSecond]>;
export async function runWithSiblingCancellation<T>(
  tasks: readonly ConcurrentTask<T>[],
  parentSignal?: AbortSignal,
  onFirstFailure?: () => void,
): Promise<T[]>;
export async function runWithSiblingCancellation(
  tasks: readonly ConcurrentTask<unknown>[],
  parentSignal?: AbortSignal,
  onFirstFailure?: () => void,
): Promise<unknown[]> {
  if (tasks.length <= 1) {
    return Promise.all(tasks.map((task) => task(parentSignal)));
  }

  const siblingController = new AbortController();
  const { signal, cleanup } = combineAbortSignals(
    parentSignal,
    siblingController.signal,
  );
  let firstFailureOwner: number | undefined;
  let firstFailureParentWasAborted = false;
  let firstFailure: { value: unknown } | undefined;
  const siblingFailureReason = createSiblingCancellationError();
  const cancelSiblings = () => {
    if (!siblingController.signal.aborted) {
      siblingController.abort(siblingFailureReason);
    }
  };
  const reserveFailure = (
    owner: number,
    hasFailure: boolean,
    error?: unknown,
  ) => {
    const newlyReserved = firstFailureOwner === undefined;
    if (firstFailureOwner === undefined) {
      firstFailureOwner = owner;
      firstFailureParentWasAborted = parentSignal?.aborted ?? false;
    }
    if (
      firstFailureOwner === owner &&
      hasFailure &&
      firstFailure === undefined
    ) {
      const parentReason = parentSignal?.reason;
      const failure =
        firstFailureParentWasAborted &&
        (error === parentReason || isAbortError(error))
          ? parentReason
          : error;
      firstFailure = { value: failure };
    }
    if (newlyReserved) {
      try {
        onFirstFailure?.();
      } finally {
        cancelSiblings();
      }
    }
  };

  const pendingTasks = tasks.map(async (task, index) => {
    try {
      return await task(signal, (...errors: [error?: unknown]) =>
        reserveFailure(index, errors.length > 0, errors[0]),
      );
    } catch (error) {
      reserveFailure(index, true, error);
      throw error;
    }
  });

  try {
    const settledTasks = await Promise.allSettled(pendingTasks);
    if (firstFailureOwner !== undefined) {
      if (firstFailure === undefined) {
        const ownerResult = settledTasks[firstFailureOwner];
        if (ownerResult?.status === 'rejected') {
          throw ownerResult.reason;
        }
        throw new Error('The task that reserved failure ownership completed.');
      }
      throw firstFailure.value;
    }
    return settledTasks.map(
      (result) => (result as PromiseFulfilledResult<unknown>).value,
    );
  } finally {
    cleanup();
  }
}
