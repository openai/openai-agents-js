import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Agent,
  NativeAgents,
  NativeError,
  NativeProvider,
  type Completed,
  type ObservedEvent,
  type Session,
  type Subagent,
  type Turn,
} from '@openai/agents';
import {
  DEFAULT_SOURCES,
  researchInParallel,
  type ParallelResearchOptions,
  type ResearchProgress,
} from '../../examples/parallel-research';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

const findings = {
  roofs: 'roofs: cobalt roofs reduce summer heat.',
  courtyards: 'courtyards: shaded courtyards retain cool air.',
};
const combined =
  'Cobalt roofs reduce summer heat, while shaded courtyards retain cool air.';
const sourceIds = ['roofs', 'courtyards'] as const;

function diagnosticError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return String(error);
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(depth < 4 && error.cause !== undefined
      ? { cause: diagnosticError(error.cause, depth + 1) }
      : {}),
    ...(depth < 4 && error instanceof AggregateError
      ? {
          errors: error.errors.map((item: unknown) =>
            diagnosticError(item, depth + 1),
          ),
        }
      : {}),
  };
}

async function phase<T>(
  pending: Promise<T>,
  name: string,
  timeoutMs = 8_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Parallel research phase timed out: ${name}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function threadId(request: JsonObject): string {
  const metadata = request.client_metadata as Record<string, string>;
  return String(JSON.parse(metadata['x-codex-turn-metadata']).thread_id);
}

function outputFor(request: JsonObject, callId: string): string {
  const input = request.input as Array<{
    type: string;
    call_id?: string;
    output?: string | Array<{ text?: string }>;
  }>;
  const output = input.find(
    (item) => item.type === 'function_call_output' && item.call_id === callId,
  )?.output;
  expect(output).toBeDefined();
  return typeof output === 'string'
    ? output
    : output!.map((part) => part.text ?? '').join('');
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'parallel research with real native children',
  () => {
    it.each([
      'success',
      'parent-provider-failure',
      'cross-source-read',
      'delayed-child-responses',
    ] as const)(
      'keeps two native researchers and their parent correlated: %s',
      async (mode) => {
        // This is the real qualified executor. A daemon/namespace refusal fails the
        // case; it must never select a mocked child or an elevated fallback.
        const executor = await phase(
          startPublicExecutor(),
          'executor startup',
          20_000,
        );
        const release = {
          roofs: Promise.withResolvers<void>(),
          courtyards: Promise.withResolvers<void>(),
        };
        const entered = {
          roofs: Promise.withResolvers<void>(),
          courtyards: Promise.withResolvers<void>(),
        };
        const parentMayWait = Promise.withResolvers<void>();
        const parentSecondRequest = Promise.withResolvers<void>();
        const bothIssued = Promise.withResolvers<void>();
        const opened = Promise.withResolvers<Session>();
        const issued = new Map<
          string,
          { child: Subagent; turn: Turn<string> }
        >();
        const assignmentKeys = new Map<string, string>();
        const childSources = new Map<string, keyof typeof findings>();
        const counts = new Map<string, number>();
        const progress: ResearchProgress[] = [];
        const rootTurns: Turn<string>[] = [];
        const lifecycle: string[] = [];
        const released = new Set<string>();
        let rootId: string | undefined;
        let finalParentRequest: JsonObject | undefined;
        let deniedSourceError: unknown;
        let server: ModelServer | undefined;
        let settled:
          | Promise<
              | {
                  ok: true;
                  value: Awaited<ReturnType<typeof researchInParallel>>;
                }
              | { ok: false; error: unknown }
            >
          | undefined;
        const failures: unknown[] = [];
        const earlyChildResults = new Map<string, Promise<Completed<string>>>();
        const childOutcomes = new Map<string, unknown>();

        try {
          const open = Agent.prototype.session;
          vi.spyOn(Agent.prototype, 'session').mockImplementation(
            async function (this: Agent, ...args) {
              const session = await open.apply(this, args);
              const submit = session.submit.bind(session);
              vi.spyOn(session, 'submit').mockImplementation(
                async (...submitArgs) => {
                  const turn = await submit(...submitArgs);
                  rootTurns.push(turn);
                  return turn;
                },
              );
              const close = session.close.bind(session);
              vi.spyOn(session, 'close').mockImplementation(async () => {
                lifecycle.push('session.close.begin');
                await close();
                lifecycle.push('session.close.end');
              });
              opened.resolve(session);
              return session;
            },
          );
          const closeProvider = NativeProvider.prototype.close;
          vi.spyOn(NativeProvider.prototype, 'close').mockImplementation(
            async function (this: NativeProvider) {
              lifecycle.push('provider.close.begin');
              await closeProvider.call(this);
              lifecycle.push('provider.close.end');
            },
          );

          const respond = async (request: JsonObject) => {
            const id = threadId(request);
            rootId ??= id;
            const count = (counts.get(id) ?? 0) + 1;
            counts.set(id, count);
            if (id === rootId) {
              if (count === 1) {
                for (const sourceId of sourceIds) {
                  const match = JSON.stringify(request).match(
                    new RegExp(
                      `Read source ${sourceId} with read_source using assignmentKey ([a-f0-9-]{36})`,
                    ),
                  );
                  expect(match).not.toBeNull();
                  assignmentKeys.set(sourceId, match![1]);
                }
                return sourceIds.map((sourceId) =>
                  call(
                    'spawn_agent',
                    {
                      task_name: `research_${sourceId}`,
                      message: `Read source ${sourceId} with read_source using assignmentKey ${assignmentKeys.get(sourceId)}. Return one finding that cites ${sourceId}.`,
                      agent_type: 'researcher',
                      fork_turns: 'none',
                    },
                    { namespace: 'collaboration', callId: `spawn-${sourceId}` },
                  ),
                );
              }
              if (count === 2) {
                parentSecondRequest.resolve();
                await parentMayWait.promise;
                return [
                  call(
                    'wait_agent',
                    { timeout_ms: 10_000 },
                    { namespace: 'collaboration', callId: 'wait-researchers' },
                  ),
                ];
              }
              expect(count).toBe(3);
              finalParentRequest = request;
              if (mode !== 'cross-source-read')
                expect(JSON.stringify(request.input)).toContain(findings.roofs);
              expect(JSON.stringify(request.input)).toContain(
                findings.courtyards,
              );
              return [message(combined)];
            }
            if (count === 1) {
              if (mode === 'delayed-child-responses')
                await new Promise<void>((resolve) =>
                  setTimeout(resolve, 9_000),
                );
              const input = JSON.stringify(request.input);
              const sourceId = sourceIds.find((source) =>
                input.includes(
                  `Read source ${source} with read_source using assignmentKey`,
                ),
              );
              expect(sourceId).toBeDefined();
              const assigned = sourceId!;
              expect(input).not.toContain(
                `Read source ${assigned === 'roofs' ? 'courtyards' : 'roofs'} with read_source using assignmentKey`,
              );
              expect(JSON.stringify(request)).toContain(
                assignmentKeys.get(assigned)!,
              );
              expect(JSON.stringify(request)).not.toContain(
                assignmentKeys.get(
                  assigned === 'roofs' ? 'courtyards' : 'roofs',
                )!,
              );
              childSources.set(id, assigned);
              const requested =
                mode === 'cross-source-read' && assigned === 'roofs'
                  ? 'courtyards'
                  : assigned;
              if (mode === 'cross-source-read' && assigned === 'roofs')
                entered.roofs.resolve();
              return [
                call(
                  'read_source',
                  {
                    sourceId: requested,
                    assignmentKey: assignmentKeys.get(assigned)!,
                  },
                  { callId: `read-${assigned}` },
                ),
              ];
            }
            expect(count).toBe(2);
            const sourceId = childSources.get(id)!;
            const actualOutput = outputFor(request, `read-${sourceId}`);
            if (mode === 'cross-source-read' && sourceId === 'roofs') {
              expect(actualOutput).not.toContain(DEFAULT_SOURCES[1].text);
            } else {
              expect(actualOutput).toContain(
                DEFAULT_SOURCES.find((source) => source.id === sourceId)!.text,
              );
            }
            entered[sourceId].resolve();
            await release[sourceId].promise;
            return [message(findings[sourceId])];
          };
          // Hold the second root response until both children settle. Successful
          // children use two requests; the denied child stops after one request.
          // No unused response acts as a gate.
          const responses: Array<
            ConstructorParameters<typeof ModelServer>[0][number]
          > = Array.from(
            { length: mode === 'cross-source-read' ? 6 : 7 },
            () => respond,
          );
          if (mode === 'parent-provider-failure')
            responses[6] = {
              status: 400,
              body: JSON.stringify({
                error: { message: 'Synthetic parent provider failure' },
              }),
            };
          server = new ModelServer(responses);
          const config = await server.config();
          settled = researchInParallel({
            sources: DEFAULT_SOURCES,
            model: 'gpt-5.5',
            providerOptions: {
              baseUrl: (
                config['model_providers.fixture'] as { base_url: string }
              ).base_url,
              apiKey: 'synthetic-parallel-research-key',
              supportsWebsockets: false,
            },
            executorOptions: {
              url: executor.url,
              cwd: executor.cwd,
              headers: executor.headers,
            },
            onProgress(observation) {
              progress.push(observation);
              for (const child of observation.children) {
                if (child.turn && !issued.has(child.id))
                  issued.set(child.id, { child, turn: child.turn });
              }
              if (issued.size === 2) bothIssued.resolve();
            },
          }).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );

          const session = await phase(opened.promise, 'open root Session');
          const receipts = Promise.all([
            entered.roofs.promise,
            entered.courtyards.promise,
          ]);
          // Observe the same public Turns outside callbacks before waiting for receipts.
          // A failed child cannot produce its second model request's receipt.
          const earlyChildFailure =
            mode === 'success'
              ? bothIssued.promise.then(() =>
                  Promise.race(
                    [...issued].map(([id, { turn }]) => {
                      const pending = turn.wait();
                      earlyChildResults.set(id, pending);
                      return pending.then(
                        (completed) => {
                          childOutcomes.set(id, {
                            status: 'completed',
                            finalOutput: completed.finalOutput,
                          });
                          return new Promise<never>(() => {});
                        },
                        (error: unknown) => {
                          childOutcomes.set(id, {
                            status: 'failed',
                            error: diagnosticError(error),
                          });
                          throw error;
                        },
                      );
                    }),
                  ),
                )
              : undefined;
          await phase(
            earlyChildFailure
              ? Promise.race([receipts, earlyChildFailure])
              : receipts,
            'both child source receipts before release',
            // Native child startup and two model requests can exceed eight seconds.
            20_000,
          );
          await phase(bothIssued.promise, 'both SDK-issued child Turns');
          await phase(
            parentSecondRequest.promise,
            'held second parent request',
          );
          expect(released.size).toBe(0);
          expect(issued.size).toBe(2);
          expect(new Set(childSources.values())).toEqual(new Set(sourceIds));
          expect(rootId).toBe(session.id);
          expect(rootTurns).toHaveLength(1);
          expect(rootTurns[0].childId).toBeNull();
          const requestCount = server.requests.length;
          const executorCount = executor.requests.length;
          const snapshots = await phase(
            Array.fromAsync(session.subagents()),
            'live subagent snapshot',
          );
          expect(snapshots).toHaveLength(2);
          for (const child of snapshots) {
            expect(child.id).not.toBe(session.id);
            expect(child.sessionId).toBe(session.id);
            expect(child.parentAgentId).toBe(session.id);
            expect(child.status).toBe('active');
            expect(child.isLive).toBe(true);
            expect(child.turn).toBe(issued.get(child.id)!.turn);
            expect(child.turn!.childId).toBe(child.id);
            expect(child.turn!.sessionId).toBe(session.id);
            expect(child.turn!.instanceId).toEqual(expect.any(String));
          }
          expect(server.requests).toHaveLength(requestCount);
          expect(executor.requests).toHaveLength(executorCount);
          expect(progress.some(({ event }) => event.type === 'gap')).toBe(
            false,
          );
          for (const child of snapshots) {
            expect(
              progress.some(
                ({ event }) =>
                  event.type === 'subagent_lifecycle' &&
                  event.subagentId === child.id &&
                  event.parentAgentId === session.id &&
                  event.kind === 'created',
              ),
            ).toBe(true);
          }

          // These waits run in the application, outside the research callbacks.
          const childWaits = [...issued.values()].map(
            async ({ child, turn }) => {
              if (
                mode === 'cross-source-read' &&
                childSources.get(child.id) === 'roofs'
              ) {
                const error = await turn.wait().then(
                  () => {
                    throw new Error('Denied child unexpectedly completed');
                  },
                  (failure: unknown) => failure,
                );
                expect(error).toEqual(
                  new Error('Source is not assigned to this native child'),
                );
                deniedSourceError = error;
                const history = await Array.fromAsync(
                  session.items({ subagentId: child.id }),
                );
                expect(JSON.stringify(history)).not.toContain(
                  DEFAULT_SOURCES[1].text,
                );
                return { child, turn, completed: null, error };
              }
              const completed = await (earlyChildResults.get(child.id) ??
                turn.wait());
              expect(completed.turn).toBe(turn);
              expect(completed.finalOutput).toBe(
                findings[childSources.get(child.id)!],
              );
              return { child, turn, completed };
            },
          );
          const allChildren = Promise.all(childWaits);
          void allChildren.catch(() => {});
          for (const sourceId of sourceIds) {
            released.add(sourceId);
            release[sourceId].resolve();
          }
          const completedChildren = await phase(
            allChildren,
            'both exact child completions',
          );
          expect(server.requests).toHaveLength(
            mode === 'cross-source-read' ? 5 : 6,
          );
          expect([...counts.values()].sort()).toEqual(
            mode === 'cross-source-read' ? [1, 2, 2] : [2, 2, 2],
          );
          const countBeforePassiveWait = server.requests.length;
          for (const { turn, completed } of completedChildren) {
            if (completed)
              expect(await phase(turn.wait(), 'passive child wait')).toBe(
                completed,
              );
          }
          expect(server.requests).toHaveLength(countBeforePassiveWait);
          parentMayWait.resolve();
          // The real wait_agent has a 10-second minimum; this phase must allow it.
          const outcome = await phase(
            settled,
            'native parent result and owned cleanup',
            20_000,
          );
          if (mode === 'parent-provider-failure') {
            expect(outcome.ok).toBe(false);
            if (!outcome.ok) expect(outcome.error).toBeInstanceOf(NativeError);
          } else if (mode === 'cross-source-read') {
            expect(outcome.ok).toBe(false);
            if (!outcome.ok) expect(outcome.error).toBe(deniedSourceError);
          } else {
            expect(outcome.ok).toBe(true);
            if (!outcome.ok) throw outcome.error;
            const result = outcome.value;
            expect(finalParentRequest).toBeDefined();
            expect(result.parent.turn).toBe(rootTurns[0]);
            expect(result.parent.finalOutput).toBe(combined);
            expect(result.children).toHaveLength(2);
            expect(result.sources).toHaveLength(2);
            for (const finding of result.children) {
              const retained = issued.get(finding.child.id)!;
              expect(finding.turn).toBe(retained.turn);
              expect(finding.completed.turn).toBe(retained.turn);
              expect(finding.completed.finalOutput).toBe(
                findings[finding.sourceId as keyof typeof findings],
              );
              const receipt = result.sources.find(
                (item) => item.childId === finding.child.id,
              )!;
              expect(receipt).toMatchObject({
                sourceId: finding.sourceId,
                childId: finding.child.id,
                turnId: finding.turn.turnId,
                submissionId: finding.turn.submissionId,
                callId: `read-${finding.sourceId}`,
                text: DEFAULT_SOURCES.find(
                  (source) => source.id === finding.sourceId,
                )!.text,
              });
              expect(receipt.call).toMatchObject({
                sessionId: session.id,
                childId: finding.child.id,
                turnId: finding.turn.turnId,
                callId: receipt.callId,
                route: 'direct',
                role: null,
                model: 'gpt-5.5',
                tool: { name: 'read_source' },
              });
              expect(
                result.events.some(
                  (event) =>
                    event.type === 'tool_finished' &&
                    event.submissionId === finding.turn.submissionId &&
                    event.turnId === finding.turn.turnId &&
                    event.callId === receipt.callId &&
                    event.status === 'completed',
                ),
              ).toBe(true);
            }
            const sequences = result.events.flatMap((event) =>
              'sequence' in event ? [event.sequence] : [],
            );
            expect(
              sequences.every(
                (sequence, index) =>
                  index === 0 || sequence > sequences[index - 1],
              ),
            ).toBe(true);
            const progressCount = progress.length;
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(progress).toHaveLength(progressCount);
          }
          const parentRequests = server.requests.filter(
            (request) => threadId(request) === session.id,
          );
          expect(parentRequests).toHaveLength(3);
          if (mode !== 'cross-source-read')
            expect(JSON.stringify(parentRequests[2].input)).toContain(
              findings.roofs,
            );
          expect(JSON.stringify(parentRequests[2].input)).toContain(
            findings.courtyards,
          );
          // The fixed HTTP400 slot bypasses the normal response callback counter.
          expect(counts.get(session.id)).toBe(
            mode === 'parent-provider-failure' ? 2 : 3,
          );
          expect(server.requests).toHaveLength(
            mode === 'cross-source-read' ? 6 : 7,
          );
          expect(lifecycle.indexOf('session.close.end')).toBeLessThan(
            lifecycle.indexOf('provider.close.begin'),
          );
          expect(lifecycle.at(-1)).toBe('provider.close.end');
          server.assertExhausted();
        } catch (error) {
          failures.push(error);
        } finally {
          if (mode === 'success' && process.env.EXECUTOR_EVIDENCE) {
            try {
              await writeFile(
                join(
                  process.env.EXECUTOR_EVIDENCE,
                  'parallel-research-primary.json',
                ),
                JSON.stringify(
                  {
                    capturedBeforeFixtureRelease: true,
                    error: failures.length
                      ? diagnosticError(failures[0])
                      : null,
                    executorMethods: executor.requests.map(
                      (request) => request.method,
                    ),
                    rootId,
                    counts: [...counts],
                    childSources: [...childSources],
                    issued: [...issued].map(([id, { turn }]) => ({
                      id,
                      turnId: turn.turnId,
                      submissionId: turn.submissionId,
                      instanceId: turn.instanceId,
                    })),
                    childOutcomes: [...childOutcomes],
                    progress: progress.map(({ event, children }) => ({
                      event,
                      children: children.map((child) => ({
                        id: child.id,
                        status: child.status,
                        isLive: child.isLive,
                        turnId: child.turn?.turnId,
                      })),
                    })),
                    modelRequests: server?.requests,
                    lifecycle,
                    released: [...released],
                  },
                  null,
                  2,
                ),
                { flag: 'wx' },
              );
            } catch (captureError) {
              failures.push(captureError);
            }
          }
          for (const gate of Object.values(release)) gate.resolve();
          parentMayWait.resolve();
          if (settled) {
            try {
              await phase(
                settled,
                'join example after fixture release',
                15_000,
              );
            } catch (error) {
              failures.push(error);
            }
          }
          try {
            await phase(executor.close(), 'executor cleanup');
          } catch (error) {
            failures.push(error);
          }
          try {
            await phase(ModelServer.closeAll(), 'model fixture cleanup');
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length)
          throw new AggregateError(
            failures,
            'Parallel research test and fixture cleanup failed',
          );
      },
      60_000,
    );
  },
);

// These cases control only public admission/lifecycle delivery. They do not
// instantiate native children and supply no R5.2 native-spawning evidence.
describe('parallel research admission and owned lifecycle without Core', () => {
  const options = (): ParallelResearchOptions => ({
    sources: DEFAULT_SOURCES,
    model: 'synthetic-model',
    providerOptions: { apiKey: 'synthetic-lifecycle-key' },
    executorOptions: { url: 'wss://127.0.0.1:9/executor', cwd: '/tmp' },
  });

  it.each([
    'missing-source',
    'duplicate-source',
    'blank-model',
    'missing-api-key',
    'blank-api-key',
  ] as const)('refuses %s before opening resources', async (invalid) => {
    const open = vi
      .spyOn(Agent.prototype, 'session')
      .mockRejectedValue(new Error('Unexpected opening'));
    const close = vi.spyOn(NativeProvider.prototype, 'close');
    const input = options();
    if (invalid === 'missing-source') input.sources = [DEFAULT_SOURCES[0]];
    if (invalid === 'duplicate-source')
      input.sources = [DEFAULT_SOURCES[0], DEFAULT_SOURCES[0]];
    if (invalid === 'blank-model') input.model = ' ';
    if (invalid === 'missing-api-key') {
      vi.stubEnv('OPENAI_API_KEY', undefined);
      input.providerOptions = {};
    }
    if (invalid === 'blank-api-key') {
      vi.stubEnv('OPENAI_API_KEY', 'synthetic-ambient-key');
      input.providerOptions = { apiKey: ' ' };
    }
    await expect(researchInParallel(input)).rejects.toThrow(
      invalid.includes('api-key')
        ? 'Configure provider credentials'
        : undefined,
    );
    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('preserves opening and provider-cleanup failures together', async () => {
    const opening = new Error('Synthetic opening failure');
    const cleanup = new Error('Synthetic provider cleanup failure');
    vi.spyOn(Agent.prototype, 'session').mockRejectedValue(opening);
    const close = vi
      .spyOn(NativeProvider.prototype, 'close')
      .mockRejectedValue(cleanup);
    const outcome = await researchInParallel(options()).catch(
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(AggregateError);
    expect((outcome as AggregateError).errors).toEqual([opening, cleanup]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('joins observer, losing root wait and Session cleanup before closing its provider', async () => {
    const entered = Promise.withResolvers<void>();
    const stopping = Promise.withResolvers<void>();
    const finishCleanup = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<never>();
    const observerFailure = new Error('Synthetic application observer failure');
    const stopped = new Error('Synthetic root stopped');
    const calls: string[] = [];
    let returned = false;
    const iterator: AsyncIterableIterator<ObservedEvent> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        await entered.promise;
        if (returned) return { done: true, value: undefined };
        return {
          done: false,
          value: {
            type: 'turn_started',
            sessionId: 'lifecycle-double',
            sequence: 1,
            submissionId: 'root-double',
            turnId: 'turn-double',
          },
        };
      },
      async return() {
        returned = true;
        calls.push('observer.return');
        return { done: true, value: undefined };
      },
    };
    const session = {
      id: 'lifecycle-double',
      events: () => iterator,
      async *subagents() {
        yield* [];
      },
      async submit() {
        return {
          wait() {
            entered.resolve();
            return answer.promise;
          },
        };
      },
      async close() {
        calls.push('session.close.begin');
        stopping.resolve();
        await finishCleanup.promise;
        answer.reject(stopped);
        calls.push('session.close.end');
      },
    };
    vi.spyOn(Agent.prototype, 'session').mockResolvedValue(
      session as unknown as Session,
    );
    const close = vi
      .spyOn(NativeProvider.prototype, 'close')
      .mockImplementation(async () => {
        calls.push('provider.close');
      });
    let finished = false;
    const running = researchInParallel({
      ...options(),
      onProgress() {
        throw observerFailure;
      },
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => {
        finished = true;
        return { ok: false as const, error };
      },
    );
    try {
      await phase(stopping.promise, 'Session close after observer failure');
      expect(returned).toBe(true);
      expect(finished).toBe(false);
      expect(close).not.toHaveBeenCalled();
      finishCleanup.resolve();
      const outcome = await phase(running, 'observer failure joined');
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toBeInstanceOf(AggregateError);
        expect((outcome.error as AggregateError).errors).toEqual([
          observerFailure,
          stopped,
        ]);
      }
      expect(calls.indexOf('observer.return')).toBeLessThan(
        calls.indexOf('session.close.begin'),
      );
      expect(calls.slice(-2)).toEqual(['session.close.end', 'provider.close']);
    } finally {
      entered.resolve();
      finishCleanup.resolve();
      answer.reject(stopped);
      await phase(running, 'join lifecycle double');
    }
  });

  it('joins a second child rejection delivered after Session.close before provider close', async () => {
    const sessionId = 'child-join-lifecycle-double';
    const firstFailure = new Error('Synthetic first child failure');
    const secondFailure = new Error('Synthetic late child failure');
    const first = Promise.withResolvers<never>();
    // Also keep fixture rejection safe if setup fails before the child wait starts.
    void first.promise.catch(() => {});
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const releasedByClose = Promise.withResolvers<void>();
    const secondResumed = Promise.withResolvers<void>();
    const allowSecondRejection = Promise.withResolvers<void>();
    const closeReturned = Promise.withResolvers<void>();
    const observerClosed = Promise.withResolvers<void>();
    const calls: string[] = [];
    let secondDelivered = false;
    let providerClosedAfterSecond = false;

    const firstTurn = {
      sessionId,
      childId: 'first-child-double',
      instanceId: 'first-instance-double',
      turnId: 'first-turn-double',
      submissionId: 'first-submission-double',
      wait: vi.fn(() => {
        calls.push('first.wait');
        firstStarted.resolve();
        return first.promise;
      }),
    } as unknown as Turn<string>;
    const secondTurn = {
      sessionId,
      childId: 'second-child-double',
      instanceId: 'second-instance-double',
      turnId: 'second-turn-double',
      submissionId: 'second-submission-double',
      wait: vi.fn(async () => {
        calls.push('second.wait');
        secondStarted.resolve();
        await releasedByClose.promise;
        secondResumed.resolve();
        // Model a public wait whose terminal rejection arrives after close returns.
        await allowSecondRejection.promise;
        secondDelivered = true;
        calls.push('second.reject');
        throw secondFailure;
      }),
    } as unknown as Turn<string>;
    const children = [firstTurn, secondTurn].map(
      (turn, index) =>
        ({
          id: turn.childId!,
          object: 'agent.session.subagent',
          sessionId,
          parentAgentId: sessionId,
          name: index === 0 ? 'Random display one' : 'Random display two',
          status: 'active',
          openedAt: index + 1,
          closedAt: null,
          isLive: true,
          turn,
        }) as unknown as Subagent,
    );
    const root = {
      sessionId,
      childId: null,
      instanceId: null,
      turnId: 'parent-turn-double',
      submissionId: 'parent-submission-double',
      wait: vi.fn(async () => {
        calls.push('parent.completed');
        return {
          turn: root,
          finalOutput: 'Synthetic parent completion',
          usage: null,
        };
      }),
    } as unknown as Turn<string>;
    const iterator: AsyncIterableIterator<ObservedEvent> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        await observerClosed.promise;
        return { done: true, value: undefined };
      },
      async return() {
        calls.push('observer.return');
        observerClosed.resolve();
        return { done: true, value: undefined };
      },
    };

    vi.spyOn(Agent.prototype, 'session').mockImplementation(async function (
      this: Agent,
    ) {
      const declaration = this.tools.find(
        (item) => item instanceof NativeAgents,
      );
      expect(declaration).toBeInstanceOf(NativeAgents);
      const approve = (declaration as NativeAgents).approval!;
      const prefix =
        'Spawn these two research tasks exactly, without waiting between spawns: ';
      const suffix = '. Use collaboration.wait_agent';
      expect(this.instructions.startsWith(prefix)).toBe(true);
      const end = this.instructions.indexOf(suffix);
      expect(end).toBeGreaterThan(prefix.length);
      const assignments = JSON.parse(
        this.instructions.slice(prefix.length, end),
      ) as Array<{
        task_name: string;
        message: string;
        agent_type: string;
        fork_turns: string;
      }>;
      expect(assignments).toHaveLength(2);
      return {
        id: sessionId,
        events: () => iterator,
        async *subagents() {
          yield* children;
        },
        async submit() {
          // The example's Session has been assigned before this callback executes.
          for (const [index, assignment] of assignments.entries()) {
            const callId = `approval-double-${index}`;
            expect(
              await approve(
                {
                  context: undefined,
                  submission: root,
                  threadId: sessionId,
                  turnId: root.turnId,
                  callId,
                  signal: new AbortController().signal,
                  originalArguments: {},
                  effectiveArguments: {},
                },
                {
                  threadId: sessionId,
                  turnId: root.turnId,
                  callId,
                  name: 'spawn_agent',
                  namespace: 'collaboration',
                  phase: 'before',
                  route: 'direct',
                  boundary: 'pre_dispatch',
                  toolKind: 'function',
                  input: JSON.stringify(assignment),
                  result: null,
                },
              ),
            ).toBe(true);
          }
          return root;
        },
        async close() {
          calls.push('session.close');
          releasedByClose.resolve();
          closeReturned.resolve();
        },
      } as unknown as Session;
    });
    const closeProvider = vi
      .spyOn(NativeProvider.prototype, 'close')
      .mockImplementation(async () => {
        providerClosedAfterSecond = secondDelivered;
        calls.push('provider.close');
      });
    let finished = false;
    const running = researchInParallel(options())
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .finally(() => {
        finished = true;
      });

    try {
      await phase(
        Promise.all([firstStarted.promise, secondStarted.promise]),
        'both retained child waits',
      );
      expect(calls.indexOf('parent.completed')).toBeLessThan(
        calls.indexOf('first.wait'),
      );
      expect(closeProvider).not.toHaveBeenCalled();
      first.reject(firstFailure);
      await phase(
        Promise.all([closeReturned.promise, secondResumed.promise]),
        'Session releases second child wait',
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      expect(closeProvider).not.toHaveBeenCalled();
      allowSecondRejection.resolve();
      const outcome = await phase(
        running,
        'all child tasks and provider cleanup joined',
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toBeInstanceOf(AggregateError);
        const errors = (outcome.error as AggregateError).errors;
        expect(errors).toHaveLength(2);
        expect(errors[0]).toBe(firstFailure);
        expect(errors[1]).toBe(secondFailure);
      }
      expect(firstTurn.wait).toHaveBeenCalledTimes(1);
      expect(secondTurn.wait).toHaveBeenCalledTimes(1);
      expect(closeProvider).toHaveBeenCalledTimes(1);
      expect(providerClosedAfterSecond).toBe(true);
      expect(calls.indexOf('observer.return')).toBeLessThan(
        calls.indexOf('session.close'),
      );
      expect(calls.indexOf('session.close')).toBeLessThan(
        calls.indexOf('second.reject'),
      );
      expect(calls.at(-1)).toBe('provider.close');
    } finally {
      first.reject(firstFailure);
      observerClosed.resolve();
      releasedByClose.resolve();
      allowSecondRejection.resolve();
      await phase(running, 'release and join child-failure lifecycle double');
    }
  });
});
