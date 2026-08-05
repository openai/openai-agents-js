import { combineAbortSignals, isAbortError } from '../utils/abortSignals';

type ConcurrentTask<T> = (
  signal?: AbortSignal,
  cancelSiblings?: () => void,
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
  let firstFailure: { value: unknown } | undefined;
  const siblingFailureReason = new Error(
    'Cancelled because a sibling task failed.',
  );
  const cancelSiblings = () => {
    if (!siblingController.signal.aborted) {
      siblingController.abort(siblingFailureReason);
    }
  };
  const reserveFailure = (owner: number) => {
    if (firstFailureOwner === undefined) {
      firstFailureOwner = owner;
      try {
        onFirstFailure?.();
      } finally {
        cancelSiblings();
      }
    }
  };

  const pendingTasks = tasks.map(async (task, index) => {
    try {
      return await task(signal, () => reserveFailure(index));
    } catch (error) {
      const parentWasAborted = parentSignal?.aborted;
      reserveFailure(index);
      if (firstFailureOwner === index && firstFailure === undefined) {
        const failure =
          parentWasAborted &&
          (error === parentSignal.reason || isAbortError(error))
            ? parentSignal.reason
            : error;
        firstFailure = { value: failure };
      }
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
