/** Read the settled public projection; retain records this reader cannot associate. */
export async function readHistory(session: {
  turns(): AsyncIterable<unknown>;
  items(): AsyncIterable<unknown>;
}) {
  const turns: unknown[] = [];
  const items: unknown[] = [];
  for await (const turn of session.turns()) turns.push(turn);
  for await (const item of session.items()) items.push(item);
  const calls = new Map<string, Record<string, unknown>>();
  const functionResults: Record<string, unknown>[] = [];
  for (const value of items) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      continue;
    const item = value as Record<string, unknown>;
    const key =
      typeof item.turnId === 'string' &&
      item.turnId.length > 0 &&
      typeof item.callId === 'string' &&
      item.callId.length > 0
        ? JSON.stringify([item.turnId, item.callId])
        : undefined;
    if (item.type === 'function_call') {
      if (key !== undefined) calls.set(key, item);
    } else if (item.type === 'function_call_output') {
      const call = key === undefined ? undefined : calls.get(key);
      if (key !== undefined) calls.delete(key);
      functionResults.push({
        turnId: item.turnId ?? null,
        callId: item.callId ?? null,
        name: call?.name ?? null,
        arguments: call?.arguments ?? null,
        status: item.status ?? null,
        output: item.output,
        error: item.error ?? null,
      });
    }
  }
  return { turns, items, functionResults };
}

/** Native usage may contain bigint; retain its precision in this example artifact. */
export function artifactJson(value: unknown): string {
  return (
    JSON.stringify(
      value,
      (_key, item: unknown) =>
        typeof item === 'bigint' ? item.toString() : item,
      2,
    ) + '\n'
  );
}
