import { inspect } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  InteractionRequired,
  NativeAgents,
  NativeError,
  NativeProvider,
  manualTool,
  parseSessionState,
  readSessionInstructions,
  tool,
  type ActionRequested,
  type ObservedEvent,
  type RecordedTurn,
  type Session,
  type SessionState,
  type TokenUsage,
  type TokenUsageInfo,
} from '../../src';
import {
  binding,
  type JsonObject,
  type JsonValue,
} from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

// These are raw JSON integer tokens, never large JavaScript numbers.
const CAPACITY = '90071992547409930';
const LARGE_RAW =
  '{"input_tokens":9007199254740993,"input_tokens_details":{"cached_tokens":9007199254740990},"output_tokens":7,"output_tokens_details":{"reasoning_tokens":2},"total_tokens":9007199254741000}';
const SAFE_RAW =
  '{"input_tokens":17,"input_tokens_details":{"cached_tokens":3},"output_tokens":7,"output_tokens_details":{"reasoning_tokens":2},"total_tokens":24}';
const NEXT_RAW =
  '{"input_tokens":7,"input_tokens_details":{"cached_tokens":1},"output_tokens":2,"output_tokens_details":{"reasoning_tokens":1},"total_tokens":9}';
const FINAL_RAW =
  '{"input_tokens":5,"input_tokens_details":{"cached_tokens":1},"output_tokens":1,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":6}';
// Zero parent usage isolates child counters even if Core carries a parent prefix.
const ROOT_RAW = '{"input_tokens":0,"output_tokens":0,"total_tokens":0}';
const CASES = [
  { name: 'safe', raw: SAFE_RAW, input: 17, cached: 3, total: 24 },
  {
    name: 'large',
    raw: LARGE_RAW,
    input: 9007199254740993n,
    cached: Number.MAX_SAFE_INTEGER - 1,
    total: 9007199254741000n,
  },
] as const;
type Scenario = (typeof CASES)[number];
type Count = number | bigint;
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
type Closable = { close(): Promise<void> };
type Resource = {
  kind: 'session' | 'provider' | 'executor';
  value: Closable;
  attempted: boolean;
};
type Evidence = {
  label: string;
  capacity: Array<{
    method: string;
    before: string;
    after: string;
    argumentCount: number;
    otherArgumentsPreserved: boolean;
  }>;
  observations: ObservedEvent[][];
  details: Record<string, unknown>;
  cleanupFailures: Array<{ resource: string; error: unknown }>;
};

function boundary(evidence: Evidence, phase: string, detail?: unknown): void {
  const boundaries = (evidence.details.boundaries ??= []) as unknown[];
  const entry = { sequence: boundaries.length + 1, phase, detail };
  boundaries.push(entry);
}

async function capacityWrapper(
  evidence: Evidence,
): Promise<(preserveCatalog: boolean) => Promise<void>> {
  boundary(evidence, 'CAPACITY_BINDING_BEGIN');
  const native = await binding();
  boundary(evidence, 'CAPACITY_BINDING_END');
  let catalogDirectory: string | undefined;
  const restore: Array<() => void> = [];
  const restoreAll = () => {
    let first: { error: unknown } | undefined;
    for (const undo of [...restore].reverse()) {
      try {
        undo();
      } catch (error) {
        first ??= { error };
      }
    }
    if (first) throw first.error;
  };
  try {
    const sourceUrl = new URL(
      '../../native/.upstream/codex/codex-rs/models-manager/models.json',
      import.meta.url,
    );
    boundary(evidence, 'CATALOG_READ_BEGIN', fileURLToPath(sourceUrl));
    const source = await readFile(sourceUrl, 'utf8');
    // Refuse to round any existing integer metadata while copying this pinned input.
    const catalog: unknown = JSON.parse(
      source,
      (_key, value: unknown, context?: { source?: string }) => {
        if (
          typeof value === 'number' &&
          /^-?\d+$/.test(context?.source ?? '') &&
          !Number.isSafeInteger(value)
        )
          throw new Error('Pinned catalog contains an unsafe integer');
        return value;
      },
    );
    if (
      !catalog ||
      typeof catalog !== 'object' ||
      !('models' in catalog) ||
      !Array.isArray(catalog.models)
    )
      throw new Error('Pinned catalog must contain a models array');
    const selected = (catalog.models as unknown[]).filter(
      (model): model is Record<string, unknown> =>
        model !== null &&
        typeof model === 'object' &&
        'slug' in model &&
        model.slug === 'gpt-5.5',
    );
    if (selected.length !== 1)
      throw new Error('Expected exactly one pinned gpt-5.5 model');
    const model = selected[0]!;
    const originalContextWindow = model.context_window;
    const originalMaximum = model.max_context_window;
    // Raising only the config override still clamps to the original model maximum.
    model.context_window = JSON.rawJSON(CAPACITY);
    model.max_context_window = JSON.rawJSON(CAPACITY);
    const serialized = JSON.stringify(catalog);
    boundary(evidence, 'CATALOG_DIRECTORY_BEGIN');
    catalogDirectory = await mkdtemp(join(tmpdir(), 'agents-counter-catalog-'));
    const catalogPath = join(catalogDirectory, 'models.json');
    evidence.details.catalog = {
      directory: catalogDirectory,
      path: catalogPath,
      source: fileURLToPath(sourceUrl),
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      originalContextWindow,
      originalMaximum,
      capacity: CAPACITY,
      sha256: createHash('sha256').update(serialized).digest('hex'),
    };
    boundary(evidence, 'CATALOG_WRITE_BEGIN', evidence.details.catalog);
    await writeFile(catalogPath, serialized, { encoding: 'utf8', mode: 0o600 });
    boundary(evidence, 'CATALOG_READY', evidence.details.catalog);
    for (const method of [
      'create_engine',
      'create_checkpoint_engine',
    ] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(native, method);
      if (!descriptor || typeof descriptor.value !== 'function')
        throw new Error(`Missing own NAPI factory: ${method}`);
      const original = native[method];
      const wrapped = function (
        this: unknown,
        ...args: Parameters<typeof original>
      ): ReturnType<typeof original> {
        const text = args[0];
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('NAPI configuration must be an object');
        for (const key of [
          'model_context_window',
          'model_auto_compact_token_limit',
          'model_catalog_json',
        ])
          if (Object.hasOwn(parsed, key))
            throw new Error(`Capacity fixture refuses an existing ${key}`);
        const closing = /}\s*$/.exec(text);
        if (!closing)
          throw new Error('Missing configuration object terminator');
        const added = `${Object.keys(parsed).length ? ',' : ''}"model_context_window":${CAPACITY},"model_auto_compact_token_limit":${CAPACITY},"model_catalog_json":${JSON.stringify(catalogPath)}`;
        const after =
          text.slice(0, closing.index) + added + text.slice(closing.index);
        const forwarded: Parameters<typeof original> = [...args];
        forwarded[0] = after;
        const unchanged = forwarded
          .slice(1)
          .every((value, index) => Object.is(value, args[index + 1]));
        if (!unchanged)
          throw new Error('Capacity fixture changed another NAPI argument');
        evidence.capacity.push({
          method,
          before: text,
          after,
          argumentCount: args.length,
          otherArgumentsPreserved: unchanged,
        });
        const runtime: unknown = JSON.parse(args[1]);
        boundary(evidence, 'FACTORY_BEGIN', {
          ...evidence.capacity.at(-1),
          profile:
            runtime && typeof runtime === 'object' && 'codex_home' in runtime
              ? runtime.codex_home
              : undefined,
        });
        // Observe settlement without replacing the original promise or error.
        try {
          const result = Reflect.apply(original, this, forwarded) as ReturnType<
            typeof original
          >;
          void result.then(
            () => boundary(evidence, 'FACTORY_END', { method }),
            (error: unknown) =>
              boundary(evidence, 'FACTORY_ERROR', { method, error }),
          );
          return result;
        } catch (error) {
          boundary(evidence, 'FACTORY_ERROR', { method, error });
          throw error;
        }
      };
      Object.defineProperty(native, method, { ...descriptor, value: wrapped });
      restore.push(() => Object.defineProperty(native, method, descriptor));
      boundary(evidence, 'FACTORY_WRAPPED', { method });
    }
  } catch (error) {
    try {
      restoreAll();
    } catch (restoreError) {
      evidence.cleanupFailures.push({
        resource: 'partial capacity installation',
        error: restoreError,
      });
    }
    boundary(evidence, 'CAPACITY_SETUP_ERROR', { error, catalogDirectory });
    // Keep any partial catalog and its path for inspection after setup failure.
    throw error;
  }
  return async (preserveCatalog) => {
    boundary(evidence, 'CAPACITY_RESTORE_BEGIN');
    restoreAll();
    boundary(evidence, 'CAPACITY_RESTORE_END');
    if (preserveCatalog) {
      boundary(evidence, 'CATALOG_RETAINED', catalogDirectory);
    } else if (catalogDirectory) {
      boundary(evidence, 'CATALOG_REMOVE_BEGIN', catalogDirectory);
      await rm(catalogDirectory, { recursive: true, force: true });
      boundary(evidence, 'CATALOG_REMOVE_END', catalogDirectory);
    }
  };
}

async function unwrap<T>(promise: Promise<Settled<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw result.error;
  return result.value;
}

// A timed-out or failed case must not admit another process-wide wrapper.
let fixtureUnavailable = false;
async function withCase(
  label: string,
  useCapacity: boolean,
  body: (context: {
    evidence: Evidence;
    own<T extends Closable>(kind: Resource['kind'], value: T): T;
    track<T>(task: Promise<T>): Promise<Settled<T>>;
    closePair(session: Session, provider: NativeProvider): Promise<void>;
    rememberFailure(error: unknown): void;
  }) => Promise<void>,
): Promise<void> {
  if (fixtureUnavailable)
    throw new Error(
      `Native case ${label} not started: an earlier fixture is active or failed`,
    );
  fixtureUnavailable = true;
  const evidence: Evidence = {
    label,
    capacity: [],
    observations: [],
    details: {},
    cleanupFailures: [],
  };
  const resources: Resource[] = [];
  const waits: Promise<Settled<unknown>>[] = [];
  let restore: ((preserveCatalog: boolean) => Promise<void>) | undefined;
  let primary: { error: unknown } | undefined;
  const close = async (resource: Resource) => {
    if (resource.attempted) return;
    resource.attempted = true;
    boundary(evidence, 'CLOSE_BEGIN', { kind: resource.kind });
    try {
      await resource.value.close();
      boundary(evidence, 'CLOSE_END', { kind: resource.kind });
    } catch (error) {
      boundary(evidence, 'CLOSE_ERROR', { kind: resource.kind, error });
      evidence.cleanupFailures.push({ resource: resource.kind, error });
      throw error;
    }
  };
  try {
    if (useCapacity) restore = await capacityWrapper(evidence);
    boundary(evidence, 'BODY_BEGIN');
    await body({
      evidence,
      own(kind, value) {
        resources.push({ kind, value, attempted: false });
        boundary(evidence, 'OWNER_REGISTERED', { kind });
        return value;
      },
      track<T>(task: Promise<T>): Promise<Settled<T>> {
        const settled = task.then<Settled<T>, Settled<T>>(
          (value) => ({ ok: true, value }),
          (error: unknown) => ({ ok: false, error }),
        );
        waits.push(settled);
        return settled;
      },
      rememberFailure(error) {
        primary ??= { error };
        evidence.details.firstAssertionFailure ??= error;
      },
      async closePair(session, provider) {
        let first: { error: unknown } | undefined;
        for (const value of [session, provider]) {
          const resource = resources.find((row) => row.value === value);
          if (!resource) throw new Error('Unowned fixture resource');
          try {
            await close(resource);
          } catch (error) {
            first ??= { error };
          }
        }
        if (first) throw first.error;
      },
    });
  } catch (error) {
    if (primary) evidence.details.laterFailure = error;
    primary ??= { error };
    evidence.details.primaryFailure = primary.error;
  } finally {
    for (const kind of ['session', 'provider', 'executor'] as const)
      for (const resource of resources.filter((row) => row.kind === kind))
        try {
          await close(resource);
        } catch {
          /* Retained above; keep closing later owners. */
        }
    try {
      boundary(evidence, 'MODEL_SERVERS_CLOSE_BEGIN');
      await ModelServer.closeAll();
      boundary(evidence, 'MODEL_SERVERS_CLOSE_END');
    } catch (error) {
      evidence.cleanupFailures.push({ resource: 'model server', error });
    }
    const timeout = new AbortController();
    try {
      boundary(evidence, 'OWNED_WAITS_DRAIN_BEGIN', { count: waits.length });
      await Promise.race([
        Promise.all(waits),
        delay(5000, undefined, { signal: timeout.signal, ref: false }).then(
          () => {
            throw new Error(
              'Owned waits did not drain after cleanup; source usability is unknown',
            );
          },
        ),
      ]);
      boundary(evidence, 'OWNED_WAITS_DRAIN_END');
    } catch (error) {
      boundary(evidence, 'OWNED_WAITS_DRAIN_ERROR', error);
      evidence.cleanupFailures.push({ resource: 'owned waits', error });
    } finally {
      timeout.abort();
    }
    try {
      await restore?.(
        primary !== undefined || evidence.cleanupFailures.length > 0,
      );
    } catch (error) {
      evidence.cleanupFailures.push({
        resource: 'capacity restoration',
        error,
      });
    }
    if (!primary && evidence.cleanupFailures.length === 0)
      fixtureUnavailable = false;
  }
  if (primary || evidence.cleanupFailures.length) {
    throw new AggregateError(
      [
        ...(primary ? [primary.error] : []),
        ...evidence.cleanupFailures.map(({ error }) => error),
      ],
      `Native counter case ${label} failed.\n${inspect(evidence, { depth: null, maxArrayLength: null })}`,
    );
  }
}

type Context = Parameters<Parameters<typeof withCase>[2]>[0];
async function providerFor(
  server: ModelServer,
  context: Context,
): Promise<NativeProvider> {
  boundary(context.evidence, 'PROVIDER_CONFIG_BEGIN');
  const config = await server.config();
  boundary(context.evidence, 'PROVIDER_CONFIG_END');
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-counter-fixture',
    supportsWebsockets: false,
  });
}
function requestThread(request: JsonObject): string {
  const metadata = request.client_metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new Error('Missing native client metadata');
  const text = metadata['x-codex-turn-metadata'];
  if (typeof text !== 'string')
    throw new Error('Missing native thread metadata');
  const value: unknown = JSON.parse(text);
  if (
    !value ||
    typeof value !== 'object' ||
    !('thread_id' in value) ||
    typeof value.thread_id !== 'string'
  )
    throw new Error('Missing exact native thread identity');
  return value.thread_id;
}
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}
function observe(
  context: Context,
  session: Session,
  stop: (event: ObservedEvent) => boolean,
) {
  const events: ObservedEvent[] = [];
  context.evidence.observations.push(events);
  return context.track(
    (async () => {
      for await (const event of session.events()) {
        events.push(event);
        boundary(context.evidence, 'EVENT', event);
        if (stop(event) || event.type === 'session_ended') return events;
      }
      return events;
    })(),
  );
}
type ObservationOwner = {
  turnId: string;
  submissionId?: string;
  outcome: Promise<Settled<unknown>>;
};

async function ownerObservation<T>(
  context: Context,
  session: Session,
  owner: ObservationOwner,
  label: string,
  match: (event: ObservedEvent) => T | undefined,
): Promise<T> {
  const waits = (context.evidence.details.observationWaits ??= []) as Array<
    Record<string, unknown>
  >;
  const record: Record<string, unknown> = {
    label,
    sessionId: session.id,
    turnId: owner.turnId,
    submissionId: owner.submissionId,
  };
  waits.push(record);
  boundary(context.evidence, 'OBSERVATION_WAIT_BEGIN', record);
  let outcome: Settled<unknown> | undefined;
  const ended = owner.outcome.then((result) => {
    outcome = result;
    record.ownerOutcome = result.ok
      ? { ok: true }
      : { ok: false, error: result.error };
    if (!result.ok) throw result.error;
    throw new NativeError(`Owned turn completed before ${label}`);
  });
  const reading = context.track(
    (async () => {
      for await (const event of session.events()) {
        boundary(context.evidence, 'OWNER_OBSERVATION_EVENT', event);
        const value = match(event);
        if (value !== undefined) return value;
        const relevantTurn =
          owner.submissionId !== undefined &&
          event.type === 'turn_finished' &&
          event.submissionId === owner.submissionId;
        if (event.type === 'session_ended' || relevantTurn) {
          record.terminal = event;
          // Prefer the actual owned rejection if it is already delivered. A
          // matching terminal must still release into cleanup if a callback
          // drain delays that rejection. Restored waits never infer ownership
          // from replayed turn IDs: their Session.wait outcome is authoritative.
          await Promise.resolve();
          if (outcome && !outcome.ok) throw outcome.error;
          const detail =
            event.type === 'turn_finished'
              ? `${event.status}/${event.errorType ?? 'no error type'}`
              : event.reason;
          throw new NativeError(
            `Native owner ended (${detail}) before ${label}`,
          );
        }
      }
      throw new NativeError(`Session observation ended before ${label}`);
    })(),
  );
  const timer = new AbortController();
  try {
    return await Promise.race([
      unwrap(reading),
      ended,
      delay(5000, undefined, { signal: timer.signal, ref: false }).then(() => {
        throw new NativeError(
          `Timed out waiting for ${label} on owned turn ${owner.turnId}`,
        );
      }),
    ]);
  } finally {
    timer.abort();
    // Do not join a still-pending read here. The existing case owner first
    // closes the Session, then drains every tracked observation and Turn wait.
  }
}

function nextAction(
  context: Context,
  session: Session,
  callId: string,
  owner: ObservationOwner,
  childId: string | null = null,
): Promise<ActionRequested> {
  return ownerObservation(
    context,
    session,
    owner,
    `manual request ${callId}`,
    (event) =>
      event.type === 'action_requested' &&
      event.sessionId === session.id &&
      event.callId === callId &&
      event.subagentId === childId &&
      event.turnId === owner.turnId &&
      (owner.submissionId === undefined ||
        event.submissionId === owner.submissionId)
        ? event
        : undefined,
  );
}

function firstReportedUsage(
  events: readonly ObservedEvent[],
  owner: { sessionId: string; turnId: string; submissionId: string },
  callId: string,
): TokenUsageInfo {
  const actionIndex = events.findIndex(
    (event) =>
      event.type === 'action_requested' &&
      event.sessionId === owner.sessionId &&
      event.turnId === owner.turnId &&
      event.submissionId === owner.submissionId &&
      event.callId === callId,
  );
  if (actionIndex < 0)
    throw new Error('Missing owned manual action before usage');
  const event = events
    .slice(actionIndex + 1)
    .find(
      (event) =>
        event.type === 'usage_updated' &&
        event.sessionId === owner.sessionId &&
        event.turnId === owner.turnId &&
        event.submissionId === owner.submissionId &&
        event.usage &&
        event.usage.lastTokenUsage.inputTokens !== 0,
    );
  if (!event || event.type !== 'usage_updated' || !event.usage)
    throw new Error('Missing native reported usage after manual suspension');
  return event.usage;
}

function toolText(output: JsonValue): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output) && output.length === 1) {
    const part = output[0];
    if (
      part &&
      typeof part === 'object' &&
      !Array.isArray(part) &&
      part.type === 'input_text' &&
      typeof part.text === 'string'
    )
      return part.text;
  }
  throw new Error('Missing supported recorded tool text content');
}
function plus(value: Count, amount: number): Count {
  const sum = BigInt(value) + BigInt(amount);
  return sum <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(sum) : sum;
}
function usageOf(scenario: Scenario, continued = false): TokenUsage {
  return {
    inputTokens: continued ? plus(scenario.input, 7) : scenario.input,
    cachedInputTokens: continued ? plus(scenario.cached, 1) : scenario.cached,
    cacheWriteInputTokens: 0,
    outputTokens: continued ? 9 : 7,
    reasoningOutputTokens: continued ? 3 : 2,
    totalTokens: continued ? plus(scenario.total, 9) : scenario.total,
  };
}
function assertUsageInfo(
  info: TokenUsageInfo | null,
  expected: TokenUsage,
  fixtureCapacity: boolean,
): asserts info is TokenUsageInfo {
  expect(info, 'real native usage must be present').not.toBeNull();
  if (!info) throw new Error('Missing actual native usage');
  expect(info.totalTokenUsage).toEqual(expected);
  if (fixtureCapacity) {
    expect(typeof info.modelContextWindow).toBe('bigint');
    if (info.modelContextWindow === null)
      throw new Error('Missing effective native model window');
    expect(
      BigInt(info.modelContextWindow) > BigInt(expected.totalTokens) * 2n,
      'fixture capacity must leave real native headroom',
    ).toBe(true);
  }
}
function assertTurnUsage(
  turns: RecordedTurn[],
  turnId: string,
  expected: TokenUsage,
): void {
  const turn = turns.find((row) => row.id === turnId);
  expect(turn, `missing actual recorded turn ${turnId}`).toBeDefined();
  expect(turn?.usage).toEqual({
    inputTokens: expected.inputTokens,
    inputTokensDetails: {
      cachedTokens: expected.cachedInputTokens,
      cacheWriteTokens: expected.cacheWriteInputTokens,
    },
    outputTokens: expected.outputTokens,
    outputTokensDetails: { reasoningTokens: expected.reasoningOutputTokens },
    totalTokens: expected.totalTokens,
  });
}
function assertLiveUsage(
  events: ObservedEvent[],
  submissionId: string,
  expected: TokenUsage,
): void {
  const snapshots = events.filter(
    (event) =>
      event.type === 'usage_updated' && event.submissionId === submissionId,
  );
  expect(
    snapshots.length,
    'real token_count observations must exist',
  ).toBeGreaterThan(0);
  expect(
    snapshots.some(
      (event) =>
        event.type === 'usage_updated' &&
        event.usage?.lastTokenUsage.inputTokens === expected.inputTokens &&
        event.usage.lastTokenUsage.totalTokens === expected.totalTokens,
    ),
    'expected exact native token_count snapshot',
  ).toBe(true);
}
function attachServer(context: Context, server: ModelServer): void {
  server.onRecord = (phase, detail) =>
    boundary(context.evidence, phase, detail);
  boundary(context.evidence, 'MODEL_SERVER_ATTACHED');
  context.evidence.details.requests = server.requests;
  context.evidence.details.rawCompletedFrames = server.completedFrames;
}
function assertFrames(server: ModelServer, raw: string, count: number): void {
  expect(server.requests).toHaveLength(count);
  expect(server.completedFrames).toHaveLength(count);
  expect(
    server.completedFrames.some((frame) => frame.includes(`"usage":${raw}`)),
    'original unquoted JSON usage tokens must be emitted',
  ).toBe(true);
  server.assertExhausted();
}
function assertFactories(evidence: Evidence, names: string[]): void {
  expect(evidence.capacity.map((row) => row.method)).toEqual(names);
  expect(evidence.capacity.every((row) => row.otherArgumentsPreserved)).toBe(
    true,
  );
}

function assertCheckpointUsageGroups(
  state: SessionState,
  turnId: string,
  expected: TokenUsage,
  initial: TokenUsage,
  descendantId?: string,
): void {
  const descendant = descendantId
    ? state.descendants.find((entry) => entry.thread_id === descendantId)
    : undefined;
  if (descendantId && !descendant)
    throw new Error('Missing retained child checkpoint');
  const history = descendant ? descendant.history : state.history;
  const records = history.filter(
    (item) =>
      item.type === 'token_usage_record' &&
      item.payload &&
      typeof item.payload === 'object' &&
      !Array.isArray(item.payload) &&
      item.payload.turn_id === turnId,
  );
  expect(records).toHaveLength(2);
  const wireUsage = (usage: TokenUsage) =>
    Object.fromEntries(
      Object.entries({
        input_tokens: usage.inputTokens,
        cached_input_tokens: usage.cachedInputTokens,
        cache_write_input_tokens: usage.cacheWriteInputTokens,
        output_tokens: usage.outputTokens,
        reasoning_output_tokens: usage.reasoningOutputTokens,
        total_tokens: usage.totalTokens,
      }).map(([key, value]) => [
        key,
        typeof value === 'bigint' ? value.toString() : value,
      ]),
    );
  const next = {
    inputTokens: 7,
    cachedInputTokens: 1,
    cacheWriteInputTokens: 0,
    outputTokens: 2,
    reasoningOutputTokens: 1,
    totalTokens: 9,
  };
  for (const [index, item] of records.entries()) {
    const record = item.payload;
    if (!record || typeof record !== 'object' || Array.isArray(record))
      throw new Error('Missing actual idle token usage record');
    // Physical response, turn and thread totals have independent expected values.
    expect(record.usage).toEqual(wireUsage(index === 0 ? initial : next));
    expect(record.turn_token_usage).toEqual(
      wireUsage(index === 0 ? initial : expected),
    );
    expect(record.thread_token_usage).toEqual(
      wireUsage(index === 0 ? initial : expected),
    );
  }
  expect(state.root_metadata.history ?? null).toBeNull();
  for (const child of state.descendants)
    expect(child.metadata.history ?? null).toBeNull();
}

async function qualifyIdleCheckpoint(
  context: Context,
  server: ModelServer,
  session: Session,
  provider: NativeProvider,
  agent: Agent<unknown>,
  turnId: string,
  expected: TokenUsage,
  initial: TokenUsage,
  environment?: Environment,
  descendantId?: string,
): Promise<void> {
  const before = server.requests.length;
  boundary(context.evidence, 'IDLE_CHECKPOINT_BEGIN', {
    sessionId: session.id,
  });
  const saved = await session.saveState();
  expect(saved.format_version).toBe(4);
  assertCheckpointUsageGroups(saved, turnId, expected, initial, descendantId);
  const stored = parseSessionState(JSON.stringify(saved));
  assertCheckpointUsageGroups(stored, turnId, expected, initial, descendantId);
  expect(await readSessionInstructions(stored)).toBe(agent.instructions);
  context.evidence.details.idleStoredCheckpoint = stored;
  await context.closePair(session, provider);
  const freshProvider = context.own(
    'provider',
    await providerFor(server, context),
  );
  expect(freshProvider).not.toBe(provider);
  // Copy current public declarations, never declarations taken from saved history.
  const freshAgent = new Agent({ ...agent, provider: freshProvider });
  boundary(context.evidence, 'IDLE_RESTORE_BEGIN');
  const restored = context.own(
    'session',
    await freshAgent.session({ state: stored, environment }),
  );
  boundary(context.evidence, 'IDLE_RESTORE_END', { sessionId: restored.id });
  const watching = observe(context, restored, () => false);
  expect(restored.id).toBe(session.id);
  const turns = await collect(
    restored.turns(descendantId ? { subagentId: descendantId } : {}),
  );
  assertTurnUsage(turns, turnId, expected);
  if (descendantId) {
    const children = await collect(restored.subagents());
    const child = children.find((entry) => entry.id === descendantId);
    expect(child).toBeDefined();
    expect(child?.isLive).toBe(false);
  }
  const resaved = await restored.saveState();
  expect(resaved.format_version).toBe(4);
  assertCheckpointUsageGroups(resaved, turnId, expected, initial, descendantId);
  expect(await readSessionInstructions(resaved)).toBe(agent.instructions);
  expect(server.requests).toHaveLength(before);
  await context.closePair(restored, freshProvider);
  await unwrap(watching);
  boundary(context.evidence, 'IDLE_CHECKPOINT_END');
}

// One file, explicitly serial: the temporary NAPI configuration wrapper is process-wide.
describe(
  'real native history counter qualification',
  { concurrent: false },
  () => {
    it('preserves exact audit counters through supplied compaction and continuation', async () => {
      await withCase('supplied-compaction/large', true, async (context) => {
        const scenario = CASES[1];
        const summary = 'The probe completed; retain its exact audit counters.';
        const server = new ModelServer(
          [
            [call('probe', {}, { callId: 'summary-probe' })],
            [message('original done')],
            (request) => {
              expect(JSON.stringify(request)).toContain(summary);
              return [message('continued done')];
            },
            (request) => {
              expect(JSON.stringify(request)).toContain(summary);
              return [message('restored done')];
            },
          ],
          [LARGE_RAW, NEXT_RAW, FINAL_RAW, FINAL_RAW],
        );
        attachServer(context, server);
        const provider = context.own(
          'provider',
          await providerFor(server, context),
        );
        const agent = new Agent({
          instructions: 'Use the probe once, then finish.',
          model: 'gpt-5.5',
          provider,
          tools: [
            tool({
              name: 'probe',
              parameters: z.object({}),
              execute: () => 'receipt',
            }),
          ],
        });
        const session = context.own('session', await agent.session());
        const turn = await session.submit('begin exact summary');
        const result = await unwrap(context.track(turn.wait()));
        expect(result.finalOutput).toBe('original done');
        assertUsageInfo(result.usage, usageOf(scenario, true), true);
        const before = await session.saveState();
        assertCheckpointUsageGroups(
          before,
          turn.turnId,
          usageOf(scenario, true),
          usageOf(scenario),
        );
        await session.compact({ summary });
        expect(server.requests).toHaveLength(2);
        const first = parseSessionState(
          JSON.stringify(await session.saveState()),
        );
        expect(first.history.slice(0, before.history.length)).toEqual(
          before.history,
        );
        assertCheckpointUsageGroups(
          first,
          turn.turnId,
          usageOf(scenario, true),
          usageOf(scenario),
        );
        await context.closePair(session, provider);

        // Exercise the same transport for retained compaction usage and token_count
        // windows. Use the actual native usage record, not a second counter codec.
        const record = first.history.findLast(
          (row) => row.type === 'token_usage_record',
        );
        const compacted = first.history.findLast(
          (row) => row.type === 'compacted',
        );
        if (
          !record?.payload ||
          typeof record.payload !== 'object' ||
          Array.isArray(record.payload)
        )
          throw new Error('Missing native usage record');
        if (
          !compacted?.payload ||
          typeof compacted.payload !== 'object' ||
          Array.isArray(compacted.payload)
        )
          throw new Error('Missing supplied compaction record');
        const totalUsage = record.payload.thread_token_usage;
        const lastUsage = record.payload.usage;
        if (
          !totalUsage ||
          typeof totalUsage !== 'object' ||
          Array.isArray(totalUsage)
        )
          throw new Error('Missing native thread usage');
        if (
          !lastUsage ||
          typeof lastUsage !== 'object' ||
          Array.isArray(lastUsage)
        )
          throw new Error('Missing native response usage');
        compacted.payload.latest_token_usage_record = structuredClone(
          record.payload,
        );
        const window = {
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: structuredClone(totalUsage),
              last_token_usage: structuredClone(lastUsage),
              model_context_window: CAPACITY,
            },
            rate_limits: null,
          },
        };
        first.history.push(window);
        const stored = parseSessionState(JSON.stringify(first));
        const nextProvider = context.own(
          'provider',
          await providerFor(server, context),
        );
        const nextAgent = new Agent({ ...agent, provider: nextProvider });
        const restored = context.own(
          'session',
          await nextAgent.session({ state: stored }),
        );
        await restored.compact({ summary });
        expect(server.requests).toHaveLength(2);
        const second = await restored.saveState();
        expect(second.history.slice(0, stored.history.length)).toEqual(
          stored.history,
        );
        expect(second.history).toContainEqual(window);
        expect(second.history).toContainEqual(compacted);
        assertCheckpointUsageGroups(
          second,
          turn.turnId,
          usageOf(scenario, true),
          usageOf(scenario),
        );
        assertTurnUsage(
          await collect(restored.turns()),
          turn.turnId,
          usageOf(scenario, true),
        );
        expect(
          (
            await unwrap(
              context.track((await restored.submit('continue')).wait()),
            )
          ).finalOutput,
        ).toBe('continued done');
        const continued = parseSessionState(
          JSON.stringify(await restored.saveState()),
        );
        assertCheckpointUsageGroups(
          continued,
          turn.turnId,
          usageOf(scenario, true),
          usageOf(scenario),
        );
        await context.closePair(restored, nextProvider);

        const finalProvider = context.own(
          'provider',
          await providerFor(server, context),
        );
        const finalAgent = new Agent({ ...agent, provider: finalProvider });
        const finalSession = context.own(
          'session',
          await finalAgent.session({ state: continued }),
        );
        assertTurnUsage(
          await collect(finalSession.turns()),
          turn.turnId,
          usageOf(scenario, true),
        );
        expect(
          (
            await unwrap(
              context.track((await finalSession.submit('resume')).wait()),
            )
          ).finalOutput,
        ).toBe('restored done');
        assertCheckpointUsageGroups(
          await finalSession.saveState(),
          turn.turnId,
          usageOf(scenario, true),
          usageOf(scenario),
        );
        assertFrames(server, LARGE_RAW, 4);
      });
    }, 30000);

    it.each(CASES)(
      'root live usage/history ($name)',
      async (scenario) => {
        await withCase(
          `root/${scenario.name}`,
          scenario.name === 'large',
          async (context) => {
            const counts = new Map<string, number>();
            context.evidence.details.perThreadRequests = counts;
            const ids: { rootId?: string } = {};
            const arbitrary = {
              input_tokens: 7,
              total_tokens: 1.5,
              nested: { output_tokens: 0.25 },
            };
            const arbitraryText = JSON.stringify(arbitrary);
            let callbacks = 0;
            const respond = (request: JsonObject) => {
              const id = requestThread(request);
              expect(id).toBe(ids.rootId);
              counts.set(id, (counts.get(id) ?? 0) + 1);
              return server.requests.length === 1
                ? [call('probe', arbitrary, { callId: 'root-probe' })]
                : [message('root done')];
            };
            const server = new ModelServer(
              [respond, respond],
              [scenario.raw, NEXT_RAW],
            );
            attachServer(context, server);
            const provider = context.own(
              'provider',
              await providerFor(server, context),
            );
            const agent = new Agent({
              instructions: 'Use the probe once, then finish.',
              model: 'gpt-5.5',
              provider,
              tools: [
                tool({
                  name: 'probe',
                  parameters: z.object({
                    input_tokens: z.number(),
                    total_tokens: z.number(),
                    nested: z.object({ output_tokens: z.number() }),
                  }),
                  execute(args) {
                    callbacks++;
                    expect(args).toEqual(arbitrary);
                    return arbitraryText;
                  },
                }),
              ],
            });
            boundary(context.evidence, 'SESSION_OPEN_BEGIN');
            const session = context.own('session', await agent.session());
            boundary(context.evidence, 'SESSION_OPEN_END', {
              sessionId: session.id,
            });
            ids.rootId = session.id;
            boundary(context.evidence, 'ROOT_SUBMIT_BEGIN', {
              sessionId: session.id,
            });
            const turn = await session.submit('begin root');
            boundary(context.evidence, 'ROOT_SUBMIT_END', {
              turnId: turn.turnId,
              submissionId: turn.submissionId,
            });
            const waiting = context.track(turn.wait());
            const watching = observe(
              context,
              session,
              (event) =>
                event.type === 'turn_finished' &&
                event.submissionId === turn.submissionId,
            );
            // Bound this owned wait, not the whole body or a pending acquisition.
            // A failure unwinds through withCase and closes the Session first.
            boundary(context.evidence, 'ROOT_WAIT_BEGIN', { timeoutMs: 5000 });
            const timer = new AbortController();
            let completed: Awaited<ReturnType<typeof turn.wait>>;
            try {
              completed = await Promise.race([
                unwrap(waiting),
                unwrap(watching).then(() => unwrap(waiting)),
                delay(5000, undefined, {
                  signal: timer.signal,
                  ref: false,
                }).then(() => {
                  boundary(context.evidence, 'ROOT_WAIT_DEADLINE');
                  throw new NativeError(
                    'Owned root turn did not finish within 5 seconds',
                  );
                }),
              ]);
              boundary(context.evidence, 'ROOT_WAIT_END');
            } finally {
              timer.abort();
            }
            const events = await unwrap(watching);
            context.evidence.details.completed = completed.usage;
            expect(completed.finalOutput).toBe('root done');
            assertUsageInfo(
              completed.usage,
              usageOf(scenario, true),
              scenario.name === 'large',
            );
            expect(completed.usage.lastTokenUsage.inputTokens).toBe(7);
            expect(completed.usage.lastTokenUsage.totalTokens).toBe(9);
            assertLiveUsage(events, turn.submissionId, usageOf(scenario));
            const turns = await collect(session.turns());
            context.evidence.details.history = turns;
            assertTurnUsage(turns, turn.turnId, usageOf(scenario, true));
            const items = await collect(session.items());
            context.evidence.details.items = items;
            const invocation = items.find(
              (item) =>
                item.type === 'function_call' && item.callId === 'root-probe',
            );
            expect(invocation?.type).toBe('function_call');
            if (!invocation || invocation.type !== 'function_call')
              throw new Error('Missing actual recorded tool invocation');
            expect(invocation.arguments).toBe(arbitraryText);
            if (typeof invocation.arguments !== 'string')
              throw new Error('Expected original recorded JSON arguments');
            expect(JSON.parse(invocation.arguments)).toEqual(arbitrary);
            const output = items.find(
              (item) =>
                item.type === 'function_call_output' &&
                item.callId === 'root-probe',
            );
            expect(output?.type).toBe('function_call_output');
            if (!output || output.type !== 'function_call_output')
              throw new Error('Missing actual recorded tool output');
            const content = toolText(output.output);
            expect(content).toBe(arbitraryText);
            expect(typeof content === 'string' && JSON.parse(content)).toEqual(
              arbitrary,
            );
            expect(callbacks).toBe(1);
            expect([...counts]).toEqual([[ids.rootId, 2]]);
            assertFrames(server, scenario.raw, 2);
            assertFactories(
              context.evidence,
              scenario.name === 'large' ? ['create_engine'] : [],
            );
            await qualifyIdleCheckpoint(
              context,
              server,
              session,
              provider,
              agent,
              turn.turnId,
              usageOf(scenario, true),
              usageOf(scenario),
            );
            expect(callbacks).toBe(1);
            assertFrames(server, scenario.raw, 2);
            assertFactories(
              context.evidence,
              scenario.name === 'large'
                ? ['create_engine', 'create_checkpoint_engine']
                : [],
            );
          },
        );
      },
      20000,
    );

    it.each(CASES)(
      'child result/history ($name)',
      async (scenario) => {
        await withCase(
          `child/${scenario.name}`,
          scenario.name === 'large',
          async (context) => {
            boundary(context.evidence, 'EXECUTOR_OPEN_BEGIN');
            const executor = context.own(
              'executor',
              await startPublicExecutor(),
            );
            const counts = new Map<string, number>();
            context.evidence.details.perThreadRequests = counts;
            const routes = new WeakMap<
              JsonObject,
              { id: string; ordinal: number }
            >();
            const ids: { rootId?: string; childSubmission?: string } = {};
            const respond = (request: JsonObject) => {
              const id = requestThread(request);
              const ordinal = (counts.get(id) ?? 0) + 1;
              counts.set(id, ordinal);
              routes.set(request, { id, ordinal });
              if (id === ids.rootId)
                return ordinal === 1
                  ? [
                      call(
                        'spawn_agent',
                        {
                          task_name: 'counter_child',
                          message: 'Ask decision, then finish.',
                        },
                        {
                          namespace: 'collaboration',
                          callId: 'spawn-counter-child',
                        },
                      ),
                    ]
                  : [message('root done')];
              return ordinal === 1
                ? [call('decision', { phase: 1 }, { callId: 'child-decision' })]
                : [message('child done')];
            };
            const rawUsage = (request: JsonObject) => {
              const route = routes.get(request);
              if (!route)
                throw new Error('Usage must use the captured response request');
              return route.id === ids.rootId
                ? ROOT_RAW
                : route.ordinal === 1
                  ? scenario.raw
                  : NEXT_RAW;
            };
            const server = new ModelServer(
              Array.from({ length: 4 }, () => respond),
              Array.from({ length: 4 }, () => rawUsage),
            );
            attachServer(context, server);
            const provider = context.own(
              'provider',
              await providerFor(server, context),
            );
            const decision = manualTool({
              name: 'decision',
              description: 'Ask.',
              parameters: z.object({ phase: z.number() }),
              result: z.string(),
            });
            const agent = new Agent({
              instructions: 'Spawn one child, then finish.',
              model: 'gpt-5.5',
              provider,
              tools: [new NativeAgents(), decision],
            });
            boundary(context.evidence, 'SESSION_OPEN_BEGIN');
            const environment = new Environment({
              url: executor.url,
              cwd: executor.cwd,
              headers: executor.headers,
              tools: ['exec_command', 'write_stdin', 'apply_patch'],
            });
            const session = context.own(
              'session',
              await agent.session({ environment }),
            );
            ids.rootId = session.id;
            boundary(context.evidence, 'SESSION_OPEN_END', {
              sessionId: session.id,
            });
            boundary(context.evidence, 'CHILD_ROOT_SUBMIT_BEGIN');
            const root = await session.submit('begin child');
            boundary(context.evidence, 'CHILD_ROOT_SUBMIT_END', {
              turnId: root.turnId,
              submissionId: root.submissionId,
            });
            const rootWait = context.track(root.wait());
            const watching = observe(
              context,
              session,
              (event) =>
                event.type === 'turn_finished' &&
                event.submissionId === ids.childSubmission,
            );
            expect((await unwrap(rootWait)).finalOutput).toBe('root done');
            const children = await collect(session.subagents());
            expect(children).toHaveLength(1);
            const child = children[0];
            expect(child.isLive).toBe(true);
            const original = child.turn;
            if (!original) throw new Error('Missing actual live child Turn');
            ids.childSubmission = original.submissionId;
            const childWait = context.track(original.wait());
            const action = await nextAction(
              context,
              session,
              'child-decision',
              {
                turnId: original.turnId,
                submissionId: original.submissionId,
                outcome: childWait,
              },
              child.id,
            );
            expect(action.arguments).toEqual({ phase: 1 });
            expect(await child.submit(action.reply('approved child'))).toBe(
              original,
            );
            const result = await unwrap(childWait);
            const events = await unwrap(watching);
            context.evidence.details.childIdentity = {
              id: child.id,
              turnId: original.turnId,
              submissionId: original.submissionId,
            };
            context.evidence.details.childCompleted = result.usage;
            expect(result.turn).toBe(original);
            expect(result.finalOutput).toBe('child done');
            assertUsageInfo(
              result.usage,
              usageOf(scenario, true),
              scenario.name === 'large',
            );
            expect(result.usage.lastTokenUsage.inputTokens).toBe(7);
            assertLiveUsage(events, original.submissionId, usageOf(scenario));
            const turns = await collect(
              session.turns({ subagentId: child.id }),
            );
            context.evidence.details.childHistory = turns;
            assertTurnUsage(turns, original.turnId, usageOf(scenario, true));
            const expectedCounts: Array<[string, number]> = [
              [session.id, 2],
              [child.id, 2],
            ];
            expect([...counts].sort(([a], [b]) => a.localeCompare(b))).toEqual(
              expectedCounts.sort(([a], [b]) => a.localeCompare(b)),
            );
            assertFrames(server, scenario.raw, 4);
            assertFactories(
              context.evidence,
              scenario.name === 'large' ? ['create_engine'] : [],
            );
            await qualifyIdleCheckpoint(
              context,
              server,
              session,
              provider,
              agent,
              original.turnId,
              usageOf(scenario, true),
              usageOf(scenario),
              environment,
              child.id,
            );
            assertFrames(server, scenario.raw, 4);
            assertFactories(
              context.evidence,
              scenario.name === 'large'
                ? ['create_engine', 'create_checkpoint_engine']
                : [],
            );
          },
        );
      },
      30000,
    );

    // The large manual case runs last. Checkpoint history and the exact sidecar
    // remain independent checks of the native/JS storage boundary.
    it.each(CASES)(
      'manual capture JSON restore accumulation ($name)',
      async (scenario) => {
        await withCase(
          `manual/${scenario.name}`,
          scenario.name === 'large',
          async (context) => {
            const historyFailures: unknown[] = [];
            const historyChecks: Array<{
              label: string;
              status: string;
              observation?: unknown;
              error?: unknown;
            }> = [];
            context.evidence.details.historyPrecision = historyChecks;
            const diagnostic = (label: string, check: () => unknown) => {
              const row: (typeof historyChecks)[number] = {
                label,
                status: 'pending',
              };
              historyChecks.push(row);
              try {
                row.observation = check();
                row.status = 'passed';
              } catch (error) {
                row.status = 'failed';
                row.error = error;
                historyFailures.push(error);
                context.rememberFailure(error);
              }
            };
            const checkpointRecord = (state: SessionState, turnId: string) => {
              const records = state.history.filter(
                (item) =>
                  item.type === 'token_usage_record' &&
                  item.payload !== null &&
                  typeof item.payload === 'object' &&
                  !Array.isArray(item.payload) &&
                  item.payload.turn_id === turnId,
              );
              context.evidence.details[
                `checkpointRecords:${historyChecks.length}`
              ] = records;
              expect(
                records.length,
                `expected actual usage record for ${turnId}; absence is not precision evidence`,
              ).toBeGreaterThan(0);
              const payload = records.at(-1)?.payload;
              if (
                !payload ||
                typeof payload !== 'object' ||
                Array.isArray(payload)
              )
                throw new Error('Missing checkpoint record payload');
              const usage = payload.turn_token_usage;
              if (!usage || typeof usage !== 'object' || Array.isArray(usage))
                throw new Error('Missing recorded native token usage');
              return usage;
            };
            const checkCheckpoint = (
              state: SessionState,
              turnId: string,
              input: Count,
            ) => {
              const usage = checkpointRecord(state, turnId);
              const actual = usage.input_tokens;
              // Diagnostic only: compare the observed value with an independent exact
              // expectation. Never feed this conversion into restore or a counter codec.
              expect(
                typeof actual === 'number' || typeof actual === 'string',
              ).toBe(true);
              if (typeof actual === 'number')
                expect(Number.isInteger(actual)).toBe(true);
              else if (typeof actual === 'string')
                expect(actual).toMatch(/^(?:0|[1-9]\d*)$/);
              else
                throw new Error(
                  'Missing input counter in real checkpoint record',
                );
              expect(BigInt(actual)).toBe(BigInt(input));
              return {
                turnId,
                input: actual,
                expected: input,
                unsafeNumeric:
                  typeof actual === 'number' && !Number.isSafeInteger(actual),
              };
            };
            let activeId: string | undefined;
            let phase = 1;
            const requestsByPhase: Array<{ phase: number; thread: string }> =
              [];
            const respond = (request: JsonObject) => {
              const id = requestThread(request);
              requestsByPhase.push({ phase, thread: id });
              expect(id).toBe(activeId);
              expect(server.requests).toHaveLength(phase);
              return phase === 1
                ? [call('decision', { phase: 1 }, { callId: 'decision1' })]
                : phase === 2
                  ? [call('decision', { phase: 2 }, { callId: 'decision2' })]
                  : [message('manual done')];
            };
            const server = new ModelServer(
              [respond, respond, respond],
              [scenario.raw, NEXT_RAW, FINAL_RAW],
            );
            attachServer(context, server);
            context.evidence.details.requestPhases = requestsByPhase;
            const decision = manualTool({
              name: 'decision',
              description: 'Ask.',
              parameters: z.object({ phase: z.number() }),
              result: z.string(),
            });
            const open = async (state?: SessionState) => {
              const provider = context.own(
                'provider',
                await providerFor(server, context),
              );
              const agent = new Agent({
                instructions: 'Ask each decision once, then finish.',
                model: 'gpt-5.5',
                provider,
                tools: [decision],
              });
              boundary(context.evidence, 'SESSION_OPEN_BEGIN', {
                restored: !!state,
              });
              const session = context.own(
                'session',
                await agent.session({ state }),
              );
              boundary(context.evidence, 'SESSION_OPEN_END', {
                sessionId: session.id,
              });
              activeId = session.id;
              const watching = observe(context, session, () => false);
              const pending = state ? context.track(session.wait()) : undefined;
              return { provider, session, watching, pending };
            };
            const assertSidecar = (state: SessionState, continued: boolean) => {
              if (state.format_version !== 5)
                throw new Error('Expected a real format3 manual receipt');
              const expected = usageOf(scenario, continued);
              const wire = Object.fromEntries(
                Object.entries(expected).map(([key, value]) => [
                  key,
                  typeof value === 'bigint' ? value.toString() : value,
                ]),
              );
              expect(state.manual_context.usage).toEqual(wire);
            };
            const first = await open();
            const sourceTurn = await first.session.submit('begin manual');
            const sourceWait = context.track(sourceTurn.wait());
            expect(
              (
                await nextAction(context, first.session, 'decision1', {
                  turnId: sourceTurn.turnId,
                  submissionId: sourceTurn.submissionId,
                  outcome: sourceWait,
                })
              ).arguments,
            ).toEqual({ phase: 1 });
            // Core emits token_count after pending tools drain. Seal this
            // boundary first; waiting for that event before suspend deadlocks.
            boundary(context.evidence, 'MANUAL_SOURCE_SUSPEND_BEGIN');
            const state1 = await first.session.suspend();
            boundary(context.evidence, 'MANUAL_SOURCE_SUSPEND_END');
            // The original native owner still supports history reads before
            // Session.close, even though its writer has finished suspension.
            const sourceTurns = structuredClone(
              await collect(first.session.turns()),
            );
            context.evidence.details.sourceObservedHistory = sourceTurns;
            const sourceReceiptSnapshot = structuredClone(state1);
            context.evidence.details.sourceReceipt = sourceReceiptSnapshot;
            assertSidecar(state1, false);
            context.evidence.details.firstSidecar = 'passed';
            const suspended = await sourceWait;
            expect(suspended.ok).toBe(false);
            if (suspended.ok)
              throw new Error('Source manual Turn unexpectedly completed');
            expect(suspended.error).toBeInstanceOf(InteractionRequired);
            const turnId =
              state1.format_version === 5
                ? state1.manual_continuation.turn_id
                : '';
            expect(turnId).toBe(sourceTurn.turnId);
            const json1 = JSON.stringify(state1);
            context.evidence.details.firstStoredJSON = json1;
            const stored1 = parseSessionState(json1);
            const stored1Snapshot = structuredClone(stored1);
            assertSidecar(stored1, false);
            expect(server.requests).toHaveLength(1);
            await context.closePair(first.session, first.provider);
            const sourceEvents = await unwrap(first.watching);
            // Inspect actual correlated native events after that owner drains.
            // Fail before opening phase2 if native never published the usage.
            const sourceInfo = firstReportedUsage(
              sourceEvents,
              {
                sessionId: first.session.id,
                turnId: sourceTurn.turnId,
                submissionId: sourceTurn.submissionId,
              },
              'decision1',
            );
            context.evidence.details.sourceNativeUsage = sourceInfo;
            assertUsageInfo(
              sourceInfo,
              usageOf(scenario),
              scenario.name === 'large',
            );
            phase = 2;
            const second = await open(stored1);
            expect(second.provider).not.toBe(first.provider);
            const action1 = await nextAction(
              context,
              second.session,
              'decision1',
              { turnId, outcome: second.pending! },
            );
            expect(server.requests).toHaveLength(1);
            const restoredTurns = structuredClone(
              await collect(second.session.turns()),
            );
            context.evidence.details.firstRestoredHistory = restoredTurns;
            const continuing = await second.session.submit(
              action1.reply('approved first'),
            );
            const continuingWait = context.track(continuing.wait());
            expect(
              (
                await nextAction(context, second.session, 'decision2', {
                  turnId: continuing.turnId,
                  submissionId: continuing.submissionId,
                  outcome: continuingWait,
                })
              ).arguments,
            ).toEqual({ phase: 2 });
            boundary(context.evidence, 'MANUAL_CONTINUED_SUSPEND_BEGIN');
            const state2 = await second.session.suspend();
            boundary(context.evidence, 'MANUAL_CONTINUED_SUSPEND_END');
            context.evidence.details.accumulatedReceipt = state2;
            assertSidecar(state2, true);
            context.evidence.details.restoreAndAccumulationSidecar = 'passed';
            const suspendedAgain = await continuingWait;
            expect(suspendedAgain.ok).toBe(false);
            if (suspendedAgain.ok)
              throw new Error('Second manual Turn unexpectedly completed');
            expect(suspendedAgain.error).toBeInstanceOf(InteractionRequired);
            const json2 = JSON.stringify(state2);
            context.evidence.details.secondStoredJSON = json2;
            const stored2 = parseSessionState(json2);
            const stored2Snapshot = structuredClone(stored2);
            assertSidecar(stored2, true);
            expect(server.requests).toHaveLength(2);
            await context.closePair(second.session, second.provider);
            const continuedEvents = await unwrap(second.watching);
            const continuedInfo = firstReportedUsage(
              continuedEvents,
              {
                sessionId: second.session.id,
                turnId: continuing.turnId,
                submissionId: continuing.submissionId,
              },
              'decision2',
            );
            context.evidence.details.continuedNativeUsage = continuedInfo;
            // This checks the actual second physical response. Accumulated
            // sidecar usage remains independently checked above.
            expect(continuedInfo.lastTokenUsage).toEqual({
              inputTokens: 7,
              cachedInputTokens: 1,
              cacheWriteInputTokens: 0,
              outputTokens: 2,
              reasoningOutputTokens: 1,
              totalTokens: 9,
            });
            expect(typeof continuedInfo.modelContextWindow).toBe(
              scenario.name === 'large' ? 'bigint' : 'number',
            );
            phase = 3;
            const third = await open(stored2);
            expect(third.provider).not.toBe(second.provider);
            const action2 = await nextAction(
              context,
              third.session,
              'decision2',
              { turnId, outcome: third.pending! },
            );
            expect(server.requests).toHaveLength(2);
            const finalTurn = await third.session.submit(
              action2.reply('approved second'),
            );
            const completed = await unwrap(context.track(finalTurn.wait()));
            context.evidence.details.finalCompletedUsage = completed.usage;
            expect(completed.finalOutput).toBe('manual done');
            expect(completed.usage?.lastTokenUsage.inputTokens).toBe(5);
            expect(completed.usage?.lastTokenUsage.totalTokens).toBe(6);
            const firstNativeUsage = context.evidence.observations[0].find(
              (event) =>
                event.type === 'usage_updated' &&
                event.usage?.lastTokenUsage.inputTokens === scenario.input,
            );
            expect(
              firstNativeUsage,
              'manual path must expose actual native token_count',
            ).toBeDefined();
            if (!firstNativeUsage || firstNativeUsage.type !== 'usage_updated')
              throw new Error('Missing native usage snapshot');
            assertUsageInfo(
              firstNativeUsage.usage,
              usageOf(scenario),
              scenario.name === 'large',
            );
            assertFrames(server, scenario.raw, 3);
            expect(requestsByPhase.map((row) => row.phase)).toEqual([1, 2, 3]);
            assertFactories(
              context.evidence,
              scenario.name === 'large'
                ? [
                    'create_engine',
                    'create_checkpoint_engine',
                    'create_checkpoint_engine',
                  ]
                : [],
            );
            await context.closePair(third.session, third.provider);
            await unwrap(third.watching);
            context.evidence.details.sidecarOutcome =
              'passed independently of checkpoint history';
            // All three native Session/provider pairs are closed. The following
            // comparisons read detached evidence only; a mismatch starts no phase.
            diagnostic('actual source history has expected count', () => {
              assertTurnUsage(sourceTurns, turnId, usageOf(scenario));
              return sourceTurns;
            });
            diagnostic(
              'source checkpoint contains the expected actual usage record',
              () =>
                checkCheckpoint(sourceReceiptSnapshot, turnId, scenario.input),
            );
            diagnostic('stored checkpoint retains expected record', () =>
              checkCheckpoint(stored1Snapshot, turnId, scenario.input),
            );
            diagnostic(
              'fresh native restore retains expected source count',
              () => {
                assertTurnUsage(restoredTurns, turnId, usageOf(scenario));
                return restoredTurns;
              },
            );
            diagnostic(
              'second checkpoint record retains exact accumulated input',
              () =>
                checkCheckpoint(
                  stored2Snapshot,
                  turnId,
                  plus(scenario.input, 7),
                ),
            );
            if (historyFailures.length) throw historyFailures[0];
          },
        );
      },
      40000,
    );
  },
);
