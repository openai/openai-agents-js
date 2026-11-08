const backgroundResultBrand = Symbol('backgroundResult');

/** A tool result that is recorded without requesting another voice response. */
export interface BackgroundResult<T> {
  readonly [backgroundResultBrand]: true;
  readonly content: T;
}

/** Return from a tool callback or its after policy to suppress voice continuation. */
export function backgroundResult<T>(content: T): BackgroundResult<T> {
  return Object.freeze({ [backgroundResultBrand]: true as const, content });
}

export function isBackgroundResult<T = unknown>(
  value: unknown,
): value is BackgroundResult<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    backgroundResultBrand in value &&
    value[backgroundResultBrand] === true
  );
}

const acceptedBackgroundResults = new WeakSet<object>();

/** @internal Record the decision only after result validation and policies succeed. */
export function markBackgroundToolResponse<T extends object>(response: T): T {
  acceptedBackgroundResults.add(response);
  return response;
}

/** @internal Read accepted intent without trusting keys in model-visible content. */
export function isBackgroundToolResponse(response: object): boolean {
  return acceptedBackgroundResults.has(response);
}
