import type { BoundDecide } from './decisions';

/** Continue the same native turn with model-visible feedback. */
export class ContinueTurn {
  constructor(readonly instructions: string) {
    if (typeof instructions !== 'string' || !instructions.trim())
      throw new TypeError(
        'ContinueTurn instructions must be a non-empty string',
      );
    Object.freeze(this);
  }
}

/** A successful native completion candidate, before final output conversion. */
export interface CompletionContext<Context = unknown> {
  readonly context: Context;
  readonly text: string | null;
  readonly sessionId: string;
  readonly turnId: string;
  readonly subagentId: string | null;
  readonly model: string;
  readonly continuationCount: number;
  readonly signal: AbortSignal;
  readonly decide: BoundDecide;
}

/** Undefined accepts; feedback continues; throwing fails the original turn. */
export type BeforeComplete<Context = unknown> = (
  context: CompletionContext<Context>,
) => void | ContinueTurn | Promise<void | ContinueTurn>;
