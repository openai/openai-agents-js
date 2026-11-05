import { expectTypeOf } from 'vitest';
import type { Session, SuppliedCompactionOptions } from '../../src';

declare const session: Session<{ answer: string }>;
expectTypeOf<Parameters<typeof session.compact>[0]>().toEqualTypeOf<
  SuppliedCompactionOptions | undefined
>();
expectTypeOf(session.compact()).toEqualTypeOf<Promise<void>>();
expectTypeOf(
  session.compact({ summary: 'Remember the decision.' }),
).toEqualTypeOf<Promise<void>>();
expectTypeOf(
  session.compact({
    summary: 'Remember the decision.',
    signal: new AbortController().signal,
  }),
).toEqualTypeOf<Promise<void>>();
// @ts-expect-error A supplied summary is text.
session.compact({ summary: 42 });
// @ts-expect-error Cancellation belongs to the supplied-summary branch.
session.compact({ signal: new AbortController().signal });
// @ts-expect-error The summary is not a positional string.
session.compact('Remember the decision.');
// @ts-expect-error Retained context is selected by the native owner.
session.compact({ summary: 'Decision.', retainedIndices: [0] });
