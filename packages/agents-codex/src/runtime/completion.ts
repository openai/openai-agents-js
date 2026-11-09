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

/**
 * A candidate checked by the original turn's completion hook before output conversion.
 * Prompted-output corrections return to this same owner with their repaired raw text.
 */
export interface CompletionContext<Context = unknown> {
  readonly context: Context;
  readonly text: string | null;
  readonly sessionId: string;
  readonly turnId: string;
  readonly subagentId: string | null;
  readonly model: string;
  readonly continuationCount: number;
  readonly signal: AbortSignal;
  /** Available only until this hook invocation settles. */
  readonly decide: BoundDecide;
}

/**
 * Undefined accepts; feedback continues; throwing fails the original turn.
 * Each repaired candidate is checked before conversion; ContinueTurn resumes
 * the original turn rather than the internal formatting Agent.
 */
export type BeforeComplete<Context = unknown> = (
  context: CompletionContext<Context>,
) => void | ContinueTurn | Promise<void | ContinueTurn>;
