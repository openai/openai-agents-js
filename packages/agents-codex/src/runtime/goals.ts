import { z } from 'zod';
import { parseTokenCount, type TokenCount } from './run-events';

/** Opening declaration for Core goal tools on a local native conversation. */
export interface NativeGoals {
  readonly kind: 'native_goals';
}

export function nativeGoals(): NativeGoals {
  return Object.freeze({ kind: 'native_goals' });
}

export const nativeGoalToolNames = [
  'create_goal',
  'get_goal',
  'update_goal',
] as const;

/** Native state, not an application checklist or permission grant. */
export interface NativeGoal {
  readonly threadId: string;
  readonly objective: string;
  readonly status:
    | 'active'
    | 'paused'
    | 'blocked'
    | 'usageLimited'
    | 'budgetLimited'
    | 'complete';
  readonly tokenBudget?: TokenCount;
  readonly tokensUsed: TokenCount;
  readonly timeUsedSeconds: TokenCount;
  /** Epoch seconds from Core. */
  readonly createdAt: TokenCount;
  readonly updatedAt: TokenCount;
}

const count = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/)
  .transform((value) => parseTokenCount(value));
const goalSchema = z
  .object({
    threadId: z.string().min(1),
    objective: z.string().min(1),
    status: z.enum([
      'active',
      'paused',
      'blocked',
      'usageLimited',
      'budgetLimited',
      'complete',
    ]),
    tokenBudget: count
      .refine((value) => value !== 0 && value !== 0n)
      .optional(),
    tokensUsed: count,
    timeUsedSeconds: count,
    createdAt: count,
    updatedAt: count,
  })
  .strict();

/** @internal Decode decimal native fields before they can lose precision. */
export function nativeGoal(value: unknown): Readonly<NativeGoal> | null {
  return value === null ? null : Object.freeze(goalSchema.parse(value));
}
