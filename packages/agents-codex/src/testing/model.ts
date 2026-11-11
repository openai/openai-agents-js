import type {
  ModelRequest,
  ModelResponse,
  NativeModel,
} from '../runtime/models';
import type {
  ModelRetryAdvice,
  ModelRetryAdviceRequest,
} from '../runtime/model-retry';

/** Raise this exact application error and optionally offer captured static advice. */
export type ModelError = {
  readonly type: 'error';
  readonly error: unknown;
  readonly retryAdvice?: ModelRetryAdvice;
};

/**
 * A finite native-model script; Core owns attempts and retries.
 * Responses and static advice are captured; configured errors retain exact identity.
 * Unrequested advice records retain synthetic request/error state for this fixture's
 * lifetime, bounded by the original finite script. Use NativeModel for dynamic behavior.
 */
export class ScriptedModel implements NativeModel {
  readonly #steps: (ModelResponse | ModelError)[];
  readonly #advice = new Map<
    string,
    { request: ModelRequest; step: ModelError }
  >();

  constructor(steps: Iterable<ModelResponse | ModelError>) {
    this.#steps = Array.from(steps, (step) => {
      if ('type' in step && step.type === 'error')
        return { ...step, retryAdvice: structuredClone(step.retryAdvice) };
      return structuredClone(step);
    });
  }

  /** Unreserved steps, excluding model calls already admitted. */
  get remainingSteps(): number {
    return this.#steps.length;
  }

  /** Require all steps reserved without discarding unrequested advice. */
  assertComplete(): void {
    if (this.remainingSteps) throw new Error('Unconsumed scripted model steps');
  }

  complete(request: ModelRequest): ModelResponse {
    const step = this.#steps.shift();
    if (!step) throw new Error('Unexpected scripted model call');
    if ('type' in step && step.type === 'error') {
      if (step.retryAdvice !== undefined) {
        if (!request.attemptId || this.#advice.has(request.attemptId))
          throw new Error('Scripted advice requires a distinct native attempt');
        this.#advice.set(request.attemptId, { request, step });
      }
      throw step.error;
    }
    return structuredClone(step as ModelResponse);
  }

  getRetryAdvice(
    request: ModelRetryAdviceRequest,
  ): ModelRetryAdvice | undefined {
    const occurrence = this.#advice.get(request.attemptId);
    if (
      !occurrence ||
      occurrence.request !== request.request ||
      !Object.is(occurrence.step.error, request.error)
    )
      return undefined;
    this.#advice.delete(request.attemptId);
    return structuredClone(occurrence.step.retryAdvice);
  }
}
