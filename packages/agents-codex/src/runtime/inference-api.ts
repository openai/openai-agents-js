/** The default inference API, overridable for each run or Session. */
export type InferenceApi = 'responses' | 'decisions';

/** @internal Agent-declared Decisions policy captured for an opening. */
export type DecisionsPolicy = Readonly<{
  fallbackModel?: string;
  minRouteProbability?: number;
}>;

/** @internal Validate API selection before acquiring resources. */
export function captureInferenceApi(
  api: InferenceApi | undefined,
): InferenceApi {
  if (api === undefined) return 'responses';
  if (api !== 'responses' && api !== 'decisions')
    throw new TypeError("api must be 'responses' or 'decisions'");
  return api;
}

/** @internal Validate and snapshot Agent policy before opening suspension. */
export function captureDecisionsPolicy(
  policy: DecisionsPolicy,
): DecisionsPolicy {
  const { fallbackModel, minRouteProbability } = policy;
  if (
    fallbackModel !== undefined &&
    (typeof fallbackModel !== 'string' || !fallbackModel.trim())
  )
    throw new TypeError('Decisions fallbackModel must be a non-empty string');
  if (
    minRouteProbability !== undefined &&
    (!Number.isFinite(minRouteProbability) ||
      minRouteProbability < 0 ||
      minRouteProbability > 1)
  )
    throw new RangeError(
      'Decisions minRouteProbability must be finite and between 0 and 1',
    );
  return Object.freeze({ fallbackModel, minRouteProbability });
}
