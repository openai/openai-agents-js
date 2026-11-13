import { expect, it } from 'vitest';
import { mergeRequestAttempts } from '../src/runtime/request-attempts';
import type { RequestAttempts } from '../src/runtime/request-attempts';
function report(
  count: number,
  availability: RequestAttempts['availability'] = 'complete',
): RequestAttempts {
  return {
    availability,
    counts: count
      ? [
          {
            owner: 'root',
            operation: 'generation',
            transport: 'http_sse',
            count,
          },
        ]
      : [],
    borrowedRequestsUnavailable: availability !== 'complete',
  };
}
it('merges settled native owners without losing exact large counts', () => {
  const first = {
    ...report(1),
    counts: [{ ...report(1).counts[0], count: 9007199254740991 }],
  };
  const merged = mergeRequestAttempts(first, report(2));
  expect(merged.counts[0].count).toBe(9007199254740993n);
  expect(first.counts[0].count).toBe(9007199254740991);
  expect(Object.isFrozen(merged)).toBe(true);
  expect(Object.isFrozen(merged.counts[0])).toBe(true);
});
it('keeps borrowed coverage partial or unavailable instead of claiming completeness', () => {
  expect(
    mergeRequestAttempts(report(1), report(0, 'unavailable')),
  ).toMatchObject({
    availability: 'partial',
    borrowedRequestsUnavailable: true,
  });
  expect(
    mergeRequestAttempts(report(0, 'unavailable'), report(0, 'unavailable')),
  ).toMatchObject({ availability: 'unavailable', counts: [] });
});
it('retains a fixed maximum of eighteen count groups as owners accumulate', () => {
  let total: RequestAttempts | undefined;
  for (let index = 0; index < 1000; index++)
    total = mergeRequestAttempts(total, report(1));
  expect(total?.counts).toHaveLength(1);
  expect(total?.counts[0].count).toBe(1000);
});
