import type { RecordedRequestUsage } from './history';
import type { CapturedModelAttempt } from './model-attempts';
import {
  parseTokenCount,
  runUsageSnapshot,
  type RunUsage,
  type TokenCount,
} from './run-events';

/** Passive projection of settled SDK attempts; external client retries stay opaque. */
export class RecordedRequestUsageProjection {
  readonly entries: RecordedRequestUsage[] = [];
  private complete = true;
  private readonly owners = new Map<string, RunUsage>();
  private readonly ids = new Map<string, Set<string>>();
  private readonly settled = new Map<
    string,
    Map<string, { id: string; usage: RunUsage }>
  >();
  private readonly active = new Map<
    string,
    { id: string; reports: number; cacheWriteTokens?: TokenCount } | null
  >();

  recordCacheWrite(threadId: string, value: TokenCount | undefined): void {
    const active = this.active.get(threadId);
    if (!active) return;
    active.reports += 1;
    active.cacheWriteTokens = value;
  }

  observe(
    value: unknown,
    captured: CapturedModelAttempt,
    threadId: unknown,
    turnId: unknown,
  ): void {
    if (!value || typeof value !== 'object' || !('phase' in value)) return;
    const id = 'attempt_id' in value ? value.attempt_id : undefined;
    if (
      value.phase === 'started' &&
      typeof id === 'string' &&
      typeof threadId === 'string' &&
      typeof turnId === 'string'
    ) {
      this.active.set(
        threadId,
        this.active.has(threadId) ? null : { id, reports: 0 },
      );
    }
    if (value.phase !== 'finished') return;
    const owner = captured.ownerAttemptId;
    if (
      typeof id !== 'string' ||
      !id ||
      owner === null ||
      typeof threadId !== 'string' ||
      !threadId ||
      typeof turnId !== 'string' ||
      !turnId
    ) {
      this.complete = false;
      return;
    }
    const active = this.active.get(threadId);
    if (!active || active.id === id) this.active.delete(threadId);
    const cacheWriteTokens =
      active?.id === id && active.reports === 1
        ? active.cacheWriteTokens
        : undefined;
    const current = captured.usage;
    const ordinal = String(current.requests);
    const facts = this.settled.get(owner) ?? new Map();
    this.settled.set(owner, facts);
    const priorFact = facts.get(ordinal);
    if (priorFact) {
      if (
        priorFact.id !== id ||
        (Object.keys(current) as Array<keyof RunUsage>).some(
          (key) => BigInt(current[key]) !== BigInt(priorFact.usage[key]),
        )
      )
        this.complete = false;
      return;
    }
    const ids = this.ids.get(owner) ?? new Set<string>();
    this.ids.set(owner, ids);
    if (ids.has(id)) {
      this.complete = false;
      return;
    }
    ids.add(id);
    const previous = this.owners.get(owner) ?? runUsageSnapshot(null);
    facts.set(ordinal, { id, usage: current });
    if (BigInt(current.requests) <= BigInt(previous.requests)) {
      this.complete = false;
      return;
    }
    this.owners.set(owner, current);
    const keys = [
      'inputTokens',
      'cachedInputTokens',
      'cacheWriteInputTokens',
      'outputTokens',
      'reasoningOutputTokens',
      'totalTokens',
    ] as const;
    const delta = Object.fromEntries(
      keys.map((key) => [key, BigInt(current[key]) - BigInt(previous[key])]),
    ) as Record<(typeof keys)[number], bigint>;
    const missing =
      BigInt(current.missingUsageRequests) -
      BigInt(previous.missingUsageRequests);
    if (
      BigInt(current.requests) !== BigInt(previous.requests) + 1n ||
      missing < 0n ||
      missing > 1n ||
      keys.some(
        (key) => delta[key] < 0n || (missing === 1n && delta[key] !== 0n),
      )
    ) {
      this.complete = false;
      return;
    }
    // Normalization can manufacture zero, but cannot manufacture a positive count.
    const knownCacheWrite =
      delta.cacheWriteInputTokens > 0n ||
      cacheWriteTokens === 0 ||
      cacheWriteTokens === 0n;
    this.entries.push({
      scope: 'sdk_model_attempt',
      threadId,
      turnId,
      ownerAttemptId: owner,
      attemptId: id,
      requestOrdinal: current.requests,
      tokenUsageKnown: missing === 0n,
      inputTokens: parseTokenCount(delta.inputTokens),
      inputTokensDetails: {
        cachedTokens: parseTokenCount(delta.cachedInputTokens),
        ...(missing === 0n && knownCacheWrite
          ? { cacheWriteTokens: parseTokenCount(delta.cacheWriteInputTokens) }
          : {}),
      },
      outputTokens: parseTokenCount(delta.outputTokens),
      outputTokensDetails: {
        reasoningTokens: parseTokenCount(delta.reasoningOutputTokens),
      },
      totalTokens: parseTokenCount(delta.totalTokens),
    });
  }

  isComplete(
    owners: Iterable<CapturedModelAttempt>,
    legacyRequests: number | bigint,
  ): boolean {
    if (!this.complete || BigInt(legacyRequests) !== 0n) return false;
    let requests = 0n;
    for (const captured of owners) {
      const settled =
        captured.ownerAttemptId === null
          ? undefined
          : this.owners.get(captured.ownerAttemptId);
      const usage = captured.usage;
      requests += BigInt(usage.requests);
      if (
        !settled ||
        (Object.keys(usage) as Array<keyof RunUsage>).some(
          (key) => BigInt(usage[key]) !== BigInt(settled[key]),
        )
      )
        return false;
    }
    return requests === BigInt(this.entries.length);
  }
}
