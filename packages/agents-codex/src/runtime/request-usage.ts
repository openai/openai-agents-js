import { z } from 'zod';
import { losslessJsonObjectSchema } from './binding';
import type { ReceivedTokenUsage, RecordedRequestUsage } from './history';
import type { CapturedModelAttempt } from './model-attempts';
import {
  addRunUsage,
  nonnegativeTokenCountWireSchema,
  parseTokenCount,
  runUsageSnapshot,
  type RunUsage,
  type TokenCount,
} from './run-events';

const providerRequests = z.array(
  z.object({
    request_id: z.string().min(1),
    request_ordinal: nonnegativeTokenCountWireSchema,
    token_usage: losslessJsonObjectSchema.nullable(),
  }),
);

/** Project observed native requests; retries hidden inside external clients stay opaque. */
export class RecordedRequestUsageProjection {
  readonly entries: RecordedRequestUsage[] = [];
  private complete = true;
  private readonly owners = new Map<string, RunUsage>();
  private readonly physical = new Map<string, Map<string, number>>();
  private readonly ids = new Map<string, Set<string>>();
  private readonly settled = new Map<
    string,
    Map<string, { id: string; usage: RunUsage }>
  >();
  private readonly active = new Map<
    string,
    { id: string; reports: number; cacheWriteTokens?: TokenCount } | null
  >();

  private compactionRequests = 0;

  observeCompaction(
    id: string,
    threadId: string,
    turnId: string,
    usage: ReceivedTokenUsage | null,
  ): void {
    this.compactionRequests += 1;
    const cacheWriteTokens = usage?.inputTokensDetails?.cacheWriteTokens;
    this.entries.push({
      scope: 'compaction',
      threadId,
      turnId,
      ownerAttemptId: id,
      attemptId: id,
      requestOrdinal: this.compactionRequests,
      tokenUsageKnown:
        usage?.inputTokens !== undefined &&
        usage.outputTokens !== undefined &&
        usage.totalTokens !== undefined,
      inputTokens: usage?.inputTokens ?? 0,
      inputTokensDetails: {
        cachedTokens: usage?.inputTokensDetails?.cachedTokens ?? 0,
        ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
      },
      outputTokens: usage?.outputTokens ?? 0,
      outputTokensDetails: {
        reasoningTokens: usage?.outputTokensDetails?.reasoningTokens ?? 0,
      },
      totalTokens: usage?.totalTokens ?? 0,
    });
  }

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
    if (captured.wire.provider_managed === true) {
      if (typeof threadId === 'string') this.active.delete(threadId);
      if (value.phase === 'finished')
        this.observeProviderRequests(
          'provider_requests' in value ? value.provider_requests : undefined,
          captured,
          threadId,
          turnId,
        );
      return;
    }
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

  private observeProviderRequests(
    value: unknown,
    captured: CapturedModelAttempt,
    threadId: unknown,
    turnId: unknown,
  ): void {
    const owner = captured.ownerAttemptId;
    const parsed = providerRequests.safeParse(value);
    if (
      !parsed.success ||
      owner === null ||
      typeof threadId !== 'string' ||
      !threadId ||
      typeof turnId !== 'string' ||
      !turnId
    ) {
      this.complete = false;
      return;
    }
    const requests = this.physical.get(owner) ?? new Map();
    this.physical.set(owner, requests);
    for (const request of parsed.data) {
      const id = request.request_id;
      const index = requests.get(id);
      const ordinal = BigInt(request.request_ordinal);
      const measured = request.token_usage;
      const usage = runUsageSnapshot(
        measured === null ? null : addRunUsage(null, measured),
      );
      const entry: RecordedRequestUsage = {
        scope: 'provider_request',
        threadId,
        turnId,
        ownerAttemptId: owner,
        attemptId: id,
        requestOrdinal: parseTokenCount(ordinal),
        tokenUsageKnown: measured !== null,
        inputTokens: usage.inputTokens,
        inputTokensDetails: {
          cachedTokens: usage.cachedInputTokens,
          ...(measured !== null && 'cache_write_input_tokens' in measured
            ? { cacheWriteTokens: usage.cacheWriteInputTokens }
            : {}),
        },
        outputTokens: usage.outputTokens,
        outputTokensDetails: { reasoningTokens: usage.reasoningOutputTokens },
        totalTokens: usage.totalTokens,
      };
      if (index === undefined) {
        if (ordinal !== BigInt(requests.size) + 1n) {
          this.complete = false;
          continue;
        }
        requests.set(id, this.entries.length);
        this.entries.push(entry);
        continue;
      }
      const prior = this.entries[index];
      if (
        prior.threadId !== threadId ||
        prior.turnId !== turnId ||
        BigInt(prior.requestOrdinal) !== ordinal
      ) {
        this.complete = false;
      } else if (!prior.tokenUsageKnown && entry.tokenUsageKnown) {
        this.entries[index] = entry;
      } else if (
        prior.tokenUsageKnown &&
        entry.tokenUsageKnown &&
        (prior.inputTokens !== entry.inputTokens ||
          prior.inputTokensDetails.cachedTokens !==
            entry.inputTokensDetails.cachedTokens ||
          prior.inputTokensDetails.cacheWriteTokens !==
            entry.inputTokensDetails.cacheWriteTokens ||
          prior.outputTokens !== entry.outputTokens ||
          prior.outputTokensDetails.reasoningTokens !==
            entry.outputTokensDetails.reasoningTokens ||
          prior.totalTokens !== entry.totalTokens)
      ) {
        this.complete = false;
      }
    }
  }

  isComplete(
    owners: Iterable<CapturedModelAttempt>,
    legacyRequests: number | bigint,
  ): boolean {
    if (
      !this.complete ||
      BigInt(legacyRequests) !== 0n ||
      this.compactionRequests !== 0
    )
      return false;
    let requests = 0n;
    for (const captured of owners) {
      if (captured.wire.provider_managed === true) {
        const managed =
          captured.ownerAttemptId === null
            ? undefined
            : this.physical.get(captured.ownerAttemptId);
        const usage = captured.usage;
        if (!managed || BigInt(managed.size) !== BigInt(usage.requests))
          return false;
        const measured = {
          inputTokens: 0n,
          cachedInputTokens: 0n,
          cacheWriteInputTokens: 0n,
          outputTokens: 0n,
          reasoningOutputTokens: 0n,
          totalTokens: 0n,
          missingUsageRequests: 0n,
        };
        for (const index of managed.values()) {
          const entry = this.entries[index];
          measured.inputTokens += BigInt(entry.inputTokens);
          measured.cachedInputTokens += BigInt(
            entry.inputTokensDetails.cachedTokens,
          );
          measured.cacheWriteInputTokens += BigInt(
            entry.inputTokensDetails.cacheWriteTokens ?? 0,
          );
          measured.outputTokens += BigInt(entry.outputTokens);
          measured.reasoningOutputTokens += BigInt(
            entry.outputTokensDetails.reasoningTokens,
          );
          measured.totalTokens += BigInt(entry.totalTokens);
          measured.missingUsageRequests += entry.tokenUsageKnown ? 0n : 1n;
        }
        if (
          (Object.keys(measured) as Array<keyof typeof measured>).some(
            (key) => measured[key] !== BigInt(usage[key]),
          )
        )
          return false;
        requests += BigInt(usage.requests);
        continue;
      }
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
