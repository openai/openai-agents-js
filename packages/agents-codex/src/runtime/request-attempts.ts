import { z } from 'zod';
import { parseTokenCount, type TokenCount } from './run-events';

const countSchema = z.strictObject({
  owner: z.enum(['root', 'child']),
  operation: z.enum(['generation', 'compaction', 'internal']),
  transport: z.enum(['http_sse', 'http_json', 'websocket']),
  count: z.string().regex(/^[1-9][0-9]{0,19}$/),
});

const reportSchema = z.strictObject({
  availability: z.enum(['complete', 'partial', 'unavailable']),
  counts: z.array(countSchema).max(18),
  borrowed_requests_unavailable: z.boolean(),
});

/** Entries into one native model transport, grouped by owner and operation. */
export type RequestAttemptCount = Readonly<
  Omit<z.infer<typeof countSchema>, 'count'> & { count: TokenCount }
>;

/** An opt-in snapshot through the native turn's settlement. */
export type RequestAttempts = Readonly<{
  availability: z.infer<typeof reportSchema>['availability'];
  counts: readonly RequestAttemptCount[];
  borrowedRequestsUnavailable: boolean;
}>;

export function parseRequestAttempts(snapshot: string): RequestAttempts {
  const report = reportSchema.parse(JSON.parse(snapshot));
  return Object.freeze({
    availability: report.availability,
    counts: Object.freeze(
      report.counts.map((entry) =>
        Object.freeze({ ...entry, count: parseTokenCount(entry.count) }),
      ),
    ),
    borrowedRequestsUnavailable: report.borrowed_requests_unavailable,
  });
}
