import { describe, expect, it, vi } from 'vitest';
import type { CodexPlanUsage, Session } from '../src';
import type { Engine, NativeThread } from '../src/runtime/binding';
import { parsePlanUsage } from '../src/runtime/plan-usage';
import { Session as CoreSession } from '../src/runtime/session';
import { captureTools } from '../src/runtime/tools';

vi.mock('../src/runtime/binding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runtime/binding')>()),
  binding: async () => ({ _ModelHttpRequest: FixtureRequest }),
}));

class FixtureRequest {
  readonly cancelled = Promise.withResolvers<never>();

  cancel() {
    this.cancelled.reject(new Error('Native plan usage request cancelled'));
  }
}

const bucket = {
  limitId: 'codex',
  limitName: null,
  normalModelSlug: null,
  primary: {
    usedPercent: 37,
    windowDurationMins: 300,
    resetsAt: 1_800_000_000,
  },
  secondary: null,
  credits: { hasCredits: true, unlimited: false, balance: '4.25' },
  individualLimit: {
    limit: '25000',
    used: '8000',
    remainingPercent: 68,
    resetsAt: 1_800_000_300,
  },
  spendControlReached: false,
  planType: 'pro',
  rateLimitReachedType: null,
};

const snapshot = {
  accountId: 'fixture-account',
  identityVerified: true,
  observedAt: 1_799_999_999.125,
  ordinaryUsageAllowed: false,
  rateLimits: [bucket],
  resetCreditsAvailable: 0,
};

describe('plan usage projection', () => {
  it('preserves provider buckets, explicit unknowns, and zero reset credits', () => {
    const result = parsePlanUsage(
      JSON.stringify({
        ...snapshot,
        rateLimits: [
          bucket,
          {
            ...bucket,
            limitId: '__proto__',
            primary: null,
            credits: null,
          },
        ],
        responseOnlyMetadata: 'fixture-private-value',
      }),
    );

    expect(result).toEqual({
      accountId: 'fixture-account',
      identityVerified: true,
      observedAt: 1_799_999_999.125,
      ordinaryUsageAllowed: false,
      rateLimitsByLimitId: {
        codex: bucket,
        ['__proto__']: {
          ...bucket,
          limitId: '__proto__',
          primary: null,
          credits: null,
        },
      },
      resetCreditsAvailable: 0,
    });
    expect(result.rateLimitsByLimitId.constructor).toBeUndefined();
    expect(Object.isFrozen(result.rateLimitsByLimitId.codex.primary)).toBe(
      true,
    );
  });

  it('rejects malformed responses without including their content in the error', () => {
    expect(() =>
      parsePlanUsage('{"accountId": "fixture-private-value"'),
    ).toThrow(/^Invalid Codex plan usage response$/);
    expect(() =>
      parsePlanUsage(JSON.stringify({ accountId: 'fixture-private-value' })),
    ).toThrow(/^Invalid Codex plan usage response$/);
  });
});

function session(read: (request: FixtureRequest) => Promise<string | null>) {
  return new CoreSession(
    { _close_report: async () => null } as unknown as Engine,
    {
      id: 'fixture-session',
      _read_plan_usage: read,
      _stop_sampling_for_close: () => {},
      _close_report: async () => null,
      _finish_child_event_reader: () => {},
    } as unknown as NativeThread,
    captureTools([]),
    {},
    {},
  ) satisfies Session;
}

describe('Session.planUsage', () => {
  it('returns null for unsupported authentication and rejects after close', async () => {
    const read = vi.fn(async () => null);
    const owned = session(read);
    await expect(owned.planUsage()).resolves.toBeNull();
    await owned.close();
    await expect(owned.planUsage()).rejects.toThrow('Session is closed');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('drops the message and cause of a native account read failure', async () => {
    await using owned = session(async () => {
      throw new Error('fixture-private-value');
    });
    const failed = owned.planUsage();
    await expect(failed).rejects.toThrow(/^Unable to read Codex plan usage$/);
    await expect(failed).rejects.not.toHaveProperty('cause');
  });

  it('preserves the abort reason and leaves a concurrent read running', async () => {
    const response = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    const read = vi.fn((request: FixtureRequest) => {
      if (read.mock.calls.length === 2) started.resolve();
      return Promise.race([request.cancelled.promise, response.promise]);
    });
    const owned = session(read);
    const stop = new AbortController();
    const reason = new Error('Stop this fixture read');
    try {
      await expect(
        owned.planUsage({ signal: AbortSignal.abort(reason) }),
      ).rejects.toBe(reason);
      expect(read).not.toHaveBeenCalled();

      const cancelled = owned.planUsage({ signal: stop.signal });
      const surviving: Promise<CodexPlanUsage | null> = owned.planUsage();
      await started.promise;
      stop.abort(reason);
      await expect(cancelled).rejects.toBe(reason);
      response.resolve(JSON.stringify(snapshot));
      await expect(surviving).resolves.toMatchObject({
        identityVerified: true,
        rateLimitsByLimitId: { codex: bucket },
      });
    } finally {
      response.resolve(JSON.stringify(snapshot));
      await owned.close();
    }
  });
});
