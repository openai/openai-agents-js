import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import type {
  Completed,
  ActionRequested,
  PendingRequests,
  Session,
  Turn,
} from '@openai/agents';

// Compile-only contract. This file has not been typechecked or executed.
declare const session: Session<{ answer: number }>;
declare const turn: Turn<{ answer: number }>;
declare const queued: Turn<number, string | null>;

expectTypeOf(turn.wait()).toEqualTypeOf<
  Promise<Completed<{ answer: number }>>
>();
expectTypeOf(session.wait()).toEqualTypeOf<
  Promise<Completed<{ answer: number }>>
>();
expectTypeOf(turn.wait({ until: 'manual_tool' })).toEqualTypeOf<
  Promise<Completed<{ answer: number }> | PendingRequests<{ answer: number }>>
>();
expectTypeOf(session.wait({ until: 'manual_tool' })).toEqualTypeOf<
  Promise<
    | Completed<{ answer: number }>
    | PendingRequests<{ answer: number }, string | null>
  >
>();
expectTypeOf(queued.wait({ until: 'manual_tool' })).toEqualTypeOf<
  Promise<Completed<number> | PendingRequests<number, string | null>>
>();

export async function requestOutputContracts() {
  const transformed = await session.submit('transform', {
    outputType: {
      mode: 'prompted',
      schema: z.string().transform((text) => text.length),
    },
  });
  const native = await session.submit('native', {
    outputType: {
      mode: 'native',
      schema: z.number(),
    },
  });
  const prompted = await session.submit('prompted', {
    outputType: {
      mode: 'prompted',
      schema: z.number(),
    },
  });
  for (const selected of [transformed, native, prompted]) {
    expectTypeOf(selected).toEqualTypeOf<Turn<number>>();
    const result = await selected.wait({ until: 'manual_tool' });
    if ('requests' in result) {
      expectTypeOf(result.turn).toEqualTypeOf<Turn<number>>();
      expectTypeOf(result.requests).toEqualTypeOf<readonly ActionRequested[]>();
      // @ts-expect-error A returned request batch is readonly.
      result.requests.push(result.requests[0]);
      // @ts-expect-error The captured Turn cannot be replaced.
      result.turn = selected;
    } else {
      expectTypeOf(result.finalOutput).toEqualTypeOf<number>();
    }
  }
  // @ts-expect-error Only the supported request boundary is accepted.
  turn.wait({ until: 'approval' });
  // @ts-expect-error A signal alone does not select the request overload.
  turn.wait({ signal: new AbortController().signal });
}
