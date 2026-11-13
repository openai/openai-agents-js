import { z } from 'zod';
import { losslessJsonObjectSchema } from './binding';
import type { CompactionContext } from './model-callbacks';

/** @internal Detached callback data; lifecycle ownership stays with Session. */
export function createCompactionContext<Context>(
  base: Omit<CompactionContext<Context>, 'items' | 'requestId' | 'automatic'>,
  msg: Record<string, unknown>,
): CompactionContext<Context> {
  const items = z.array(losslessJsonObjectSchema).parse(msg.items);
  return Object.freeze({
    ...base,
    items: Object.freeze(items),
    requestId: z.string().parse(msg.request_id),
    automatic: z.boolean().parse(msg.automatic),
  });
}

/** @internal Preserve accepted text and the native fallback. */
export function captureCompactionSummary(value: unknown): string | undefined {
  if (value !== undefined && (typeof value !== 'string' || !value.trim()))
    throw new TypeError(
      'beforeCompact must return a nonempty summary or undefined',
    );
  return value;
}
