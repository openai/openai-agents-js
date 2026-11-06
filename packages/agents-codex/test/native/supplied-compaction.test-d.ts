import { expectTypeOf } from 'vitest';
import type { ModelContextSnapshot as FacadeSnapshot } from '@openai/agents';
import type {
  ModelContextSnapshot,
  Session,
  SuppliedCompactionOptions,
} from '../../src';

declare const session: Session<{ answer: string }>;
declare const snapshot: ModelContextSnapshot;
expectTypeOf<FacadeSnapshot>().toEqualTypeOf<ModelContextSnapshot>();
expectTypeOf(session.modelContext()).toEqualTypeOf<
  Promise<ModelContextSnapshot>
>();
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
    snapshot,
    retain: [2, 5] as const,
  }),
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
// @ts-expect-error Retain contains numeric indices.
session.compact({ summary: 'Decision.', snapshot, retain: ['0'] });
