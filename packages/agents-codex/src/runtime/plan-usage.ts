import { z } from 'zod';
import { decode } from './binding';
import { NativeError } from './native-error';

const planWindow = z
  .object({
    usedPercent: z.number(),
    windowDurationMins: z.int().nullable(),
    resetsAt: z.int().nullable(),
  })
  .readonly();

const planCredits = z
  .object({
    hasCredits: z.boolean(),
    unlimited: z.boolean(),
    balance: z.string().nullable(),
  })
  .readonly();

const spendLimit = z
  .object({
    limit: z.string(),
    used: z.string(),
    remainingPercent: z.int(),
    resetsAt: z.int(),
  })
  .readonly();

const planLimit = z
  .object({
    limitId: z.string().nullable(),
    limitName: z.string().nullable(),
    normalModelSlug: z.string().nullable(),
    primary: planWindow.nullable(),
    secondary: planWindow.nullable(),
    credits: planCredits.nullable(),
    individualLimit: spendLimit.nullable(),
    spendControlReached: z.boolean().nullable(),
    planType: z.string().nullable(),
    rateLimitReachedType: z.string().nullable(),
  })
  .readonly();

const planUsageWire = z.object({
  accountId: z.string().nullable(),
  identityVerified: z.boolean(),
  observedAt: z.number(),
  ordinaryUsageAllowed: z.boolean().nullable(),
  rateLimits: z.array(planLimit),
  resetCreditsAvailable: z.int().nonnegative().nullable(),
});

/**
 * One provider usage bucket. Window reset times are in Unix seconds.
 * A null field means the value is unknown.
 */
export type CodexPlanLimit = z.infer<typeof planLimit>;

/** Provider-reported account usage at the time of the read. */
export type CodexPlanUsage = Readonly<{
  /** The Session's bound saved account, when available. */
  accountId: string | null;
  /** The provider identified both the bound account and user. */
  identityVerified: boolean;
  /** Receipt time in Unix seconds. The caller decides how long to use this snapshot. */
  observedAt: number;
  /** Provider-reported permission for ordinary usage when identity is verified. Request admission can still fail. */
  ordinaryUsageAllowed: boolean | null;
  /** The Codex bucket and any additional buckets reported by the provider. */
  rateLimitsByLimitId: Readonly<Record<string, CodexPlanLimit>>;
  /** Number of available window resets, when reported. */
  resetCreditsAvailable: number | null;
}>;

/** @internal Decode the allowlisted native account usage response. */
export function parsePlanUsage(value: string): CodexPlanUsage {
  try {
    const { rateLimits, ...snapshot } = decode(planUsageWire, value);
    const rateLimitsByLimitId: Record<string, CodexPlanLimit> =
      Object.create(null);
    for (const limit of rateLimits)
      rateLimitsByLimitId[limit.limitId ?? 'codex'] = limit;
    return Object.freeze({
      ...snapshot,
      rateLimitsByLimitId: Object.freeze(rateLimitsByLimitId),
    });
  } catch {
    throw new NativeError('Invalid Codex plan usage response');
  }
}
