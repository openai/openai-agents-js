import { jsonValue, type JsonValue } from './binding';

declare const executorPolicyDecision: unique symbol;
interface Decision<Kind extends 'allow' | 'replace' | 'stop'> {
  readonly [executorPolicyDecision]: Kind;
}

/** Executor policy authority issued only by the executor decision factories. */
export type ExecutorPolicyDecision =
  Decision<'allow'> | Decision<'replace'> | Decision<'stop'>;

type Payload =
  | { kind: 'allow' }
  | { kind: 'replace'; value: JsonValue }
  | { kind: 'stop'; reason?: string };

const decisions = new WeakMap<object, Payload>();

function issue<Kind extends Payload['kind']>(
  payload: Extract<Payload, { kind: Kind }>,
): Decision<Kind> {
  const decision = Object.freeze(Object.create(null)) as Decision<Kind>;
  decisions.set(decision, payload);
  return decision;
}

/** Keep the original arguments after approval allows the call. */
export function allowExecutorCall(): Decision<'allow'> {
  return issue<'allow'>({ kind: 'allow' });
}

/** Copy replacement JSON now; the selected tool validates its argument kind before dispatch. */
export function replaceExecutorArguments(
  value: JsonValue,
): Decision<'replace'> {
  return issue<'replace'>({ kind: 'replace', value: jsonValue.parse(value) });
}

/** Request an exact-owner stop before dispatch. The reason stays private. */
export function stopExecutorTurn(reason?: string): Decision<'stop'> {
  if (reason !== undefined && typeof reason !== 'string')
    throw new TypeError('Executor stop reason must be a string');
  return issue<'stop'>({ kind: 'stop', reason });
}

/** @internal Recognize identity without inspecting the supplied object's properties or prototype. */
export function readExecutorPolicyDecision(
  value: unknown,
): Exclude<Payload, { kind: 'stop' }> | { kind: 'stop' } | undefined {
  const payload = decisions.get(value as object);
  if (payload?.kind === 'stop') return { kind: 'stop' };
  if (payload?.kind === 'replace')
    return { kind: 'replace', value: jsonValue.parse(payload.value) };
  return payload ? { kind: 'allow' } : undefined;
}
