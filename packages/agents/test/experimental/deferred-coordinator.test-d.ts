import { expectTypeOf } from 'vitest';
import {
  DeferredTools,
  type AdvanceOptions,
  type JobJournal,
  type JobProvider,
} from '../../src/experimental/deferred';
import { deferredTool } from '../../src/experimental/deferred-tool';
import type { Session } from '../../src/runtime/public-agent';
import type { ManualToolRequest } from '../../src/runtime/manual';
import type { Turn } from '../../src/runtime/session';

declare const journal: JobJournal;
declare const session: Session<string>;
declare const request: ManualToolRequest;
declare const provider: JobProvider<{ id: string }>;
const jobs = new DeferredTools({ tenant: 'tenant', runId: 'run', journal });
const declaration = deferredTool({
  name: 'result',
  description: 'Get a result',
  schemas: (z) => ({
    parameters: z.strictObject({ id: z.string() }),
    result: z.string(),
  }),
});
jobs.register(declaration, {
  providerId: 'service-v1',
  provider,
  project: String,
});
jobs.register(declaration, {
  providerId: 'service-v1',
  provider,
  // @ts-expect-error projection must return the declared result type.
  project: () => 7,
});
const result = jobs.start(
  session,
  request,
  {},
  async ({ session: reopened, outcome }) => {
    expectTypeOf(reopened).toEqualTypeOf<Session<string>>();
    if (outcome.status === 'continued') {
      expectTypeOf(outcome.turn).toEqualTypeOf<Turn<unknown>>();
      // @ts-expect-error an active output override has no string-output witness.
      const stringTurn: Turn<string> = outcome.turn;
      void stringTurn;
    }
    return 7;
  },
);
expectTypeOf(result).toEqualTypeOf<Promise<number>>();
const advance: AdvanceOptions = { waitMs: 100 };
const respond: AdvanceOptions = {
  operation: 'respond',
  response: { approved: true },
};
const cancel: AdvanceOptions = { operation: 'cancel' };
// @ts-expect-error responding requires an explicit host response.
const missingResponse: AdvanceOptions = { operation: 'respond' };
// @ts-expect-error cancellation cannot carry a response.
const cancelResponse: AdvanceOptions = { operation: 'cancel', response: {} };
void [advance, respond, cancel, missingResponse, cancelResponse];
