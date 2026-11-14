import type { BoundDecide } from './decisions';
export type { BoundDecide } from './decisions';
/** @internal Keep tool deadline signals on helpers when callback contexts are copied. */
export const decisionBinding = Symbol('decisionBinding');
export function withDecisionSignal<
  T extends {
    signal: AbortSignal;
    decide?: BoundDecide;
    /** @internal */
    [decisionBinding]?: (signal: AbortSignal) => BoundDecide;
  },
>(context: T, signal: AbortSignal): T {
  return {
    ...context,
    signal,
    ...(context[decisionBinding]
      ? { decide: context[decisionBinding](signal) }
      : {}),
  };
}
