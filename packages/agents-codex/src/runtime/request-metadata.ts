import type { ObservationInput } from './observation';
import { parseTokenCount } from './run-events';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: ObjectValue, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Strict private bridge decoding; malformed passive metadata never fails work. */
export function decodeRequestMetadata(
  value: unknown,
  submissionId: string,
): ObservationInput | null {
  if (!object(value)) return null;
  const common = ['type', 'request_id', 'thread_id', 'turn_id'];
  if (
    !common.every((key) => typeof value[key] === 'string' && value[key] !== '')
  )
    return null;
  const identity = {
    submissionId,
    requestId: value.request_id as string,
    threadId: value.thread_id as string,
    turnId: value.turn_id as string,
  };
  if (value.type === 'model_response_linked') {
    if (
      !exact(value, [...common, 'response_observation_id']) ||
      typeof value.response_observation_id !== 'string' ||
      !value.response_observation_id
    )
      return null;
    return {
      type: 'model_response_linked',
      ...identity,
      responseObservationId: value.response_observation_id,
    };
  }
  if (
    value.type !== 'model_request_dispatching' ||
    !exact(value, [
      ...common,
      'model',
      'reasoning_effort',
      'reasoning_summary',
      'service_tier',
      'wire',
      'transport',
    ])
  )
    return null;
  if (
    typeof value.model !== 'string' ||
    (value.wire !== 'responses' && value.wire !== 'responses_lite') ||
    (value.transport !== 'http_sse' && value.transport !== 'websocket')
  )
    return null;
  if (
    (value.reasoning_summary !== null &&
      typeof value.reasoning_summary !== 'string') ||
    (value.service_tier !== null && typeof value.service_tier !== 'string')
  )
    return null;
  const raw = value.reasoning_effort;
  let effort: string | number | bigint | null = null;
  if (raw !== null) {
    if (!object(raw)) return null;
    if (
      raw.kind === 'text' &&
      exact(raw, ['kind', 'value']) &&
      typeof raw.value === 'string'
    )
      effort = raw.value;
    else if (
      raw.kind === 'integer' &&
      exact(raw, ['kind', 'decimal']) &&
      typeof raw.decimal === 'string' &&
      /^(0|[1-9][0-9]{0,19})$/.test(raw.decimal)
    ) {
      const integer = BigInt(raw.decimal);
      if (integer > 18446744073709551615n) return null;
      effort = parseTokenCount(integer);
    } else return null;
  }
  return {
    type: 'model_request_dispatching',
    ...identity,
    model: value.model,
    reasoningEffort: effort,
    reasoningSummary: value.reasoning_summary,
    serviceTier: value.service_tier,
    wire: value.wire,
    transport: value.transport,
  };
}
