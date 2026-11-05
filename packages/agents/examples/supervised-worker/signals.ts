type Attachment = { accountId: string | null; generation: number };

type QuotaWindow = Readonly<{
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
}>;

type QuotaCredits = Readonly<{
  hasCredits: boolean | null;
  unlimited: boolean | null;
  balance: string | null;
}>;

const rateLimitReachedTypes = [
  'rate_limit_reached',
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
] as const;

type RateLimitReachedType = (typeof rateLimitReachedTypes)[number];

type RateLimitSnapshot = {
  limitId?: string | null;
  primary?: Partial<QuotaWindow> | null;
  secondary?: Partial<QuotaWindow> | null;
  credits?: Partial<QuotaCredits> | null;
  spendControlReached?: boolean | null;
  rateLimitReachedType?: string | null;
};

// The host supplies the observation and expiration times in epoch seconds.
export type AccountQuotaObservation = {
  generation: number;
  observedAt?: number | null;
  expiresAt?: number | null;
  response: {
    accountId?: string | null;
    ordinaryUsageAllowed?: boolean | null;
    rateLimits?: RateLimitSnapshot | null;
    rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
    rateLimitUpsell?: unknown;
  };
};

export type AccountQuota = {
  accountId: string;
  generation: number;
  limitId: string;
  observedAt: number | null;
  expiresAt: number | null;
  ordinaryUsageAllowed: boolean | null;
  primary: QuotaWindow | null;
  secondary: QuotaWindow | null;
  credits: QuotaCredits | null;
  usableCredits: boolean | null;
  spendControlReached: boolean | null;
  rateLimitReachedType: RateLimitReachedType | null;
  fresh: boolean;
  blocked: boolean;
};

function quotaWindow(window?: Partial<QuotaWindow> | null): QuotaWindow | null {
  return window
    ? Object.freeze({
        usedPercent: window.usedPercent ?? null,
        windowDurationMins: window.windowDurationMins ?? null,
        resetsAt: window.resetsAt ?? null,
      })
    : null;
}

function isFresh(observedAt: number | null, expiresAt: number | null): boolean {
  const now = Date.now() / 1000;
  return (
    observedAt !== null &&
    expiresAt !== null &&
    Number.isFinite(observedAt) &&
    Number.isFinite(expiresAt) &&
    observedAt <= now &&
    now < expiresAt
  );
}

export class WorkerSignals {
  readonly #changes = new EventTarget();
  readonly #limitId: string;
  #attachment: Attachment;
  #snapshot:
    | {
        details: Omit<AccountQuota, 'fresh' | 'blocked'>;
        acceptedAt: number | null;
      }
    | undefined;

  constructor({
    accountId,
    generation,
    limitId = 'codex',
  }: Attachment & {
    limitId?: string;
  }) {
    this.#attachment = { accountId, generation };
    this.#limitId = limitId;
  }

  get generation(): number {
    return this.#attachment.generation;
  }

  attach({ accountId, generation }: Attachment): void {
    if (generation > this.generation) {
      this.#attachment = { accountId, generation };
      this.#snapshot = undefined;
      this.#changes.dispatchEvent(new Event('change'));
    }
  }

  // Refetch the authoritative snapshot when a sparse rate-limit update arrives.
  async refreshQuota({
    generation,
    maxAgeSeconds,
    read,
  }: {
    generation: number;
    maxAgeSeconds: number;
    read: () => Promise<AccountQuotaObservation['response']>;
  }): Promise<void> {
    if (generation !== this.generation) {
      return;
    }
    const observedAt = Date.now() / 1000;
    const response = await read();
    this.updateQuota({
      generation,
      observedAt,
      expiresAt: observedAt + maxAgeSeconds,
      response,
    });
  }

  updateQuota({
    generation,
    observedAt = null,
    expiresAt = null,
    response,
  }: AccountQuotaObservation): void {
    const { accountId, ordinaryUsageAllowed, rateLimits, rateLimitsByLimitId } =
      response;
    if (
      !accountId?.trim() ||
      accountId !== this.#attachment.accountId ||
      generation !== this.generation
    ) {
      return;
    }

    const acceptedAt = isFresh(observedAt, expiresAt) ? observedAt : null;
    // Keep the last accepted timestamp even after its quota expires.
    const previous = this.#snapshot?.acceptedAt;
    if (previous != null && (acceptedAt === null || acceptedAt <= previous)) {
      return;
    }

    let selected: RateLimitSnapshot | null | undefined;
    if (
      rateLimitsByLimitId &&
      Object.hasOwn(rateLimitsByLimitId, this.#limitId)
    ) {
      selected = rateLimitsByLimitId[this.#limitId];
    } else if ((rateLimits?.limitId ?? 'codex') === this.#limitId) {
      selected = rateLimits;
    }
    const credits = selected?.credits;
    const hasCredits = credits?.hasCredits ?? null;
    const unlimited = credits?.unlimited ?? null;
    let usableCredits: boolean | null = null;
    if (hasCredits === true || unlimited === true) {
      usableCredits = true;
    } else if (hasCredits === false && unlimited === false) {
      usableCredits = false;
    }
    this.#snapshot = {
      acceptedAt,
      details: {
        accountId,
        generation,
        limitId: this.#limitId,
        observedAt,
        expiresAt,
        ordinaryUsageAllowed: ordinaryUsageAllowed ?? null,
        primary: quotaWindow(selected?.primary),
        secondary: quotaWindow(selected?.secondary),
        credits: credits
          ? Object.freeze({
              hasCredits,
              unlimited,
              balance: credits.balance ?? null,
            })
          : null,
        usableCredits,
        spendControlReached: selected?.spendControlReached ?? null,
        rateLimitReachedType:
          rateLimitReachedTypes.find(
            (type) => type === selected?.rateLimitReachedType,
          ) ?? null,
      },
    };
    this.#changes.dispatchEvent(new Event('change'));
  }

  get quota(): AccountQuota | undefined {
    const snapshot = this.#snapshot;
    if (!snapshot) {
      return undefined;
    }
    const { details, acceptedAt } = snapshot;
    const fresh =
      acceptedAt !== null && isFresh(details.observedAt, details.expiresAt);
    return {
      ...details,
      fresh,
      blocked:
        fresh &&
        (details.spendControlReached === true ||
          details.rateLimitReachedType !== null ||
          (details.ordinaryUsageAllowed === false &&
            details.usableCredits === false)),
    };
  }

  onChange(listener: () => void, signal: AbortSignal): void {
    this.#changes.addEventListener('change', listener, { signal });
  }
}
