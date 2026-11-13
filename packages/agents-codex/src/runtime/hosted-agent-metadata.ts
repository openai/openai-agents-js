export interface HostedAgentMetadata {
  readonly agentName: string;
  readonly phase?: string;
}
const admitted = new WeakMap<object, HostedAgentMetadata>();
const maxBytes = 1024 * 1024;
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function capture(
  name: unknown,
  phase: unknown,
): HostedAgentMetadata | undefined {
  if (
    typeof name !== 'string' ||
    !name.length ||
    name.length > maxBytes ||
    (typeof phase === 'string' && phase.length > maxBytes)
  )
    return undefined;
  if (
    Buffer.byteLength(name) +
      (typeof phase === 'string' ? Buffer.byteLength(phase) : 0) >
    maxBytes
  )
    return undefined;
  return Object.freeze({
    agentName: name,
    ...(typeof phase === 'string' ? { phase } : {}),
  });
}
/** @internal Bind only the exact call object after native callback admission. */
export function bindHostedAgentMetadata<T extends object>(
  call: T,
  raw: unknown,
): T {
  const source = object(raw);
  const value = capture(source?.agent_name, source?.phase);
  if (value) admitted.set(call, value);
  return call;
}
/** Read provider attribution without affecting native routing or execution. */
export function getHostedAgentMetadata(
  value: unknown,
): HostedAgentMetadata | undefined {
  const outer = object(value);
  if (!outer) return undefined;
  const item = object(outer.call) ?? object(outer.toolCall) ?? outer;
  const known = admitted.get(item);
  if (known) return known;
  const provider = object(item.providerData);
  const source = provider && object(provider.agent) ? provider : item;
  return capture(object(source.agent)?.agent_name, source.phase);
}
