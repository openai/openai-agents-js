import { z } from 'zod';
import { parseNative } from './binding';
import {
  projectHistory,
  threadHistorySchema,
  type RecordedTurn,
  type SessionItem,
} from './history';
import { NativeError } from './native-error';

const identitySchema = z.strictObject({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  callId: z.string().min(1),
});

const uncertainCallSchema = identitySchema.extend({
  name: z.string(),
  namespace: z.string().nullable(),
  arguments: z.string(),
});
const snapshotSchema = z.strictObject({
  calls: z.array(uncertainCallSchema).nonempty(),
  history: threadHistorySchema,
});

/** Original native call whose result did not reach storage. Arguments retain their recorded text. */
export type UncertainCall = Readonly<z.infer<typeof uncertainCallSchema>>;

const receiptSchema = identitySchema.extend({
  outcome: z.enum(['applied', 'not_applied']),
  result: z.string(),
});

/** An independently verified effect and the text the model may read. */
export type ReconciledCall = Readonly<z.infer<typeof receiptSchema>>;

/** A recorded local turn observed after the native writer stopped. */
export type LocalRecoveryTurn = Readonly<
  Omit<RecordedTurn, 'status'> & {
    status: Exclude<RecordedTurn['status'], 'in_progress'> | 'interrupted';
  }
>;

/** Local opening stopped before model work. Check application records for these calls. */
export class LocalRecoveryRequired extends NativeError {
  readonly #calls: readonly UncertainCall[];
  readonly #turns: readonly LocalRecoveryTurn[];
  readonly #items: readonly Readonly<SessionItem>[];

  constructor(
    calls: readonly UncertainCall[],
    turns: readonly LocalRecoveryTurn[],
    items: readonly SessionItem[],
  ) {
    super(
      'Native local history has unknown tool effects. Verify each effect before reopening.',
    );
    this.#calls = Object.freeze(
      calls.map((call) => Object.freeze({ ...call })),
    );
    this.#turns = Object.freeze(
      turns.map((turn) => Object.freeze({ ...turn })),
    );
    this.#items = Object.freeze(
      items.map((item) => Object.freeze({ ...item })),
    );
  }

  get calls() {
    return this.#calls;
  }

  get turns() {
    return this.#turns;
  }

  get items() {
    return this.#items;
  }
}

/** @internal Capture the opening input before awaiting any application work. */
export function captureReconciledCalls(
  input: readonly ReconciledCall[] | undefined,
) {
  if (input === undefined) return undefined;
  const captured = z.array(receiptSchema).safeParse(input);
  if (!captured.success)
    throw new TypeError(
      'Reconciliation requires native thread, turn, and call IDs, a confirmed outcome, and a text result',
    );
  return captured.data;
}

/** @internal Project only the stopped native writer's structured snapshot. */
export function localRecoveryRequired(snapshot: string, threadId: string) {
  const parsed = snapshotSchema.safeParse(parseNative(snapshot));
  if (
    !parsed.success ||
    parsed.data.calls.some((call) => call.threadId !== threadId)
  )
    throw new NativeError('Invalid native local recovery inspection');
  const { calls, history } = parsed.data;
  const { items, turns } = projectHistory(history, threadId);
  return new LocalRecoveryRequired(
    calls,
    turns.map((turn) => ({
      ...turn,
      status: turn.status === 'in_progress' ? 'interrupted' : turn.status,
    })),
    items.map(({ data: _data, ...item }) => item),
  );
}
