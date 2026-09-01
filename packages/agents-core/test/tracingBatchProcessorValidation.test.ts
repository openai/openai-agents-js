import { describe, expect, it } from 'vitest';

import {
  BatchTraceProcessor,
  type TracingExporter,
} from '../src/tracing/processor';
import { UserError } from '../src/errors';

const exporter: TracingExporter = {
  async export() {},
};

describe('BatchTraceProcessor option validation', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid maxBatchSize %s',
    (maxBatchSize) => {
      expect(
        () => new BatchTraceProcessor(exporter, { maxBatchSize }),
      ).toThrow(
        new UserError(
          'BatchTraceProcessor maxBatchSize must be a positive integer.',
        ),
      );
    },
  );

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    2_147_483_648,
  ])('rejects invalid scheduleDelay %s', (scheduleDelay) => {
    expect(
      () => new BatchTraceProcessor(exporter, { scheduleDelay }),
    ).toThrow(
      new UserError(
        'BatchTraceProcessor scheduleDelay must be a positive finite number less than or equal to 2147483647.',
      ),
    );
  });
});
