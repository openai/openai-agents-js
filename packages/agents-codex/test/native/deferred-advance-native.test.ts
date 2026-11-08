import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  type ActionRequested,
  type Session,
} from '../../src';
import {
  DeferredAuthorizationError,
  DeferredTools,
  type JobBinding,
  type JobClaim,
  type JobContext,
  type JobUpdate,
} from '../../src/experimental/deferred';
import { deferredTool } from '../../src/experimental/deferred-tool';
import type { ManualTool } from '../../src/runtime/manual';
import { isManualSessionState } from '../../src/runtime/state';
import { ModelServer, call, message } from './fixtures/model-server';

const KEY = 'opaque-private-job-key';
const RECEIPT = 'opaque-private-receipt';
const API_KEY = 'synthetic-deferred-advance';
const GENERATION = '18446744073709551615';
const LARGE_USAGE =
  '{"input_tokens":9007199254740993,"input_tokens_details":{"cached_tokens":9007199254740990},"output_tokens":7,"output_tokens_details":{"reasoning_tokens":2},"total_tokens":9007199254741000}';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
interface FixtureOptions {
  apiKey?: string;
  siblings?: boolean;
  prompted?: boolean;
  largeUsage?: boolean;
  maxOutputBytes?: number;
  weak?: boolean;
}
function fixture(options: FixtureOptions = {}) {
  return preparedFixture(
    (name) =>
      deferredTool({
        name,
        description: 'Read one deferred result',
        schemas: (builder) => ({
          parameters: builder.strictObject({ id: builder.string() }),
          result: builder.string(),
        }),
      }),
    (value) => {
      if (typeof value !== 'string')
        throw new TypeError('Expected string fixture result');
      return value;
    },
    options,
  );
}
function objectFixture() {
  return preparedFixture(
    (name) =>
      deferredTool({
        name,
        description: 'Read one structured deferred result',
        schemas: (builder) => ({
          parameters: builder.strictObject({ id: builder.string() }),
          result: builder.strictObject({ [KEY]: builder.string() }),
        }),
      }),
    (value) => {
      if (
        typeof value !== 'object' ||
        value === null ||
        !(KEY in value) ||
        typeof value[KEY] !== 'string'
      )
        throw new TypeError('Expected structured fixture result');
      return { [KEY]: value[KEY] };
    },
  );
}

async function nextAction(
  session: Session<unknown>,
  callId?: string,
): Promise<ActionRequested> {
  for await (const event of session.events())
    if (
      event.type === 'action_requested' &&
      (callId === undefined || event.callId === callId)
    )
      return event;
  throw new Error('Expected restored deferred request');
}

async function preparedFixture<Result>(
  declaration: (name: string) => ManualTool<{ id: string }, Result>,
  projectResult: (value: unknown) => Result,
  options: FixtureOptions = {},
) {
  const tools = [declaration('first')];
  if (options.siblings) tools.push(declaration('second'));
  const model = new ModelServer(
    [
      tools.map((tool, index) =>
        call(tool.name, { id: `${index}` }, { callId: `${tool.name}-call` }),
      ),
      [message(options.prompted ? '{"answer":"done"}' : 'done')],
    ],
    options.largeUsage ? [LARGE_USAGE] : [],
  );
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: options.apiKey ?? API_KEY,
    supportsWebsockets: false,
  });
  const backend = {
    start: vi.fn(
      async (
        _claim: JobClaim,
        _input: { id: string },
        _ctx: JobContext,
      ): Promise<JobUpdate> => ({
        status: 'completed',
        receipt: RECEIPT,
        value: 'safe-result',
      }),
    ),
    observe: vi.fn(
      async (_claim: JobClaim, _ctx: JobContext): Promise<JobUpdate> => ({
        status: 'unknown',
      }),
    ),
    reconcileCreation: vi.fn(
      async (
        _claim: JobClaim,
        _input: { id: string },
        _ctx: JobContext,
      ): Promise<JobUpdate> => ({ status: 'unknown' }),
    ),
    respond: vi.fn(
      async (
        _claim: JobClaim,
        _response: unknown,
        _ctx: JobContext,
      ): Promise<JobUpdate> => ({
        status: 'completed',
        value: 'safe-response',
      }),
    ),
    cancel: vi.fn(
      async (_claim: JobClaim, _ctx: JobContext): Promise<JobUpdate> => ({
        status: 'cancelled',
      }),
    ),
  };
  let exact = '';
  let bindings: readonly JobBinding[] = [];
  const journal = {
    prepare: vi.fn(
      async (json: string, batch: readonly JobBinding[], _ctx: JobContext) => {
        exact = json;
        bindings = batch;
      },
    ),
    claim: vi.fn(
      async (
        binding: JobBinding,
        _operation: 'advance' | 'respond' | 'cancel',
        _ctx: JobContext,
      ): Promise<JobClaim> => ({
        binding,
        key: KEY,
        generation: GENERATION,
        action: 'start',
      }),
    ),
    authorize: vi.fn(
      async (_claim: JobClaim, _action: string, _ctx: JobContext) => {},
    ),
    record: vi.fn(
      async (_claim: JobClaim, _update: JobUpdate, _ctx: JobContext) => {},
    ),
    saveResult: vi.fn(
      async (_claim: JobClaim, _json: string, _ctx: JobContext) => {},
    ),
  };
  const project = vi.fn(projectResult);
  const jobs = new DeferredTools({ tenant: 'tenant', runId: 'run', journal });
  for (const tool of tools)
    jobs.register(tool, {
      providerId: `provider-${tool.name}`,
      provider: options.weak
        ? { start: backend.start, observe: backend.observe }
        : backend,
      requireReconciliation: !options.weak,
      project,
      ...(options.maxOutputBytes === undefined
        ? {}
        : { maxOutputBytes: options.maxOutputBytes }),
    });
  const agent = new Agent<undefined, string | { answer: string }>({
    instructions: 'Ask for the declared jobs, then finish.',
    model: 'gpt-5',
    provider,
    tools,
    programmaticToolCalling: false,
    ...(options.prompted
      ? {
          outputType: {
            mode: 'prompted' as const,
            schema: z.object({ answer: z.string() }),
          },
        }
      : {}),
  });
  try {
    await using original = await agent.session();
    const originalTurn = await original.submit('ASK-ONCE');
    const completion = originalTurn.wait().catch((error: unknown) => error);
    await expect
      .poll(async () => {
        const batch = await originalTurn.wait({ until: 'manual_tool' });
        return 'requests' in batch ? batch.requests.length : 0;
      })
      .toBe(tools.length);
    const batch = await originalTurn.wait({ until: 'manual_tool' });
    if (!('requests' in batch))
      throw new Error('Expected pending deferred batch');
    const stale = batch.requests[0]!;
    const state = await jobs.prepare(original, stale);
    expect(await completion).toBeInstanceOf(InteractionRequired);
    await original.close();
    const session = await agent.session({ state });
    const request = await nextAction(session);
    return {
      jobs,
      journal,
      backend,
      project,
      model,
      session,
      request,
      stale,
      state,
      bindings,
      exact,
      agent,
      async [Symbol.asyncDispose]() {
        try {
          await session.close();
        } finally {
          await provider.close();
        }
      },
    };
  } catch (error) {
    await provider.close();
    throw error;
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'private deferred advance and recovery',
  () => {
    it('starts once, records and saves the checked result before continuing the real restored turn', async () => {
      await using f = await fixture();
      const result = await f.jobs.advance(f.session, f.request);
      expect(result.status).toBe('continued');
      if (result.status !== 'continued')
        throw new Error('Expected continuation');
      expect((await result.turn.wait()).finalOutput).toBe('done');
      const claim = f.backend.start.mock.calls[0]![0];
      expect(claim.binding).toEqual(f.bindings[0]);
      expect(claim.generation).toBe(GENERATION);
      expect(f.backend.start.mock.calls[0]![1]).toEqual({ id: '0' });
      expect(f.journal.record).toHaveBeenCalledWith(
        claim,
        {
          status: 'completed',
          receipt: RECEIPT,
          value: 'safe-result',
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(f.journal.saveResult.mock.calls[0]![1]).toBe('"safe-result"');
      expect(
        f.journal.authorize.mock.calls.map(([, action]) => action),
      ).toEqual(['start', 'project', 'deliver']);
      expect(f.journal.saveResult.mock.invocationCallOrder[0]).toBeLessThan(
        f.journal.authorize.mock.invocationCallOrder[2]!,
      );
      expect(f.backend.start).toHaveBeenCalledTimes(1);
      expect(f.backend.observe).not.toHaveBeenCalled();
      f.model.assertExhausted();
    }, 20_000);

    it('keeps exact checkpoint bindings and prompted output across partial sibling delivery', async () => {
      await using f = await fixture({
        siblings: true,
        prompted: true,
      });
      expect(isManualSessionState(f.state)).toBe(true);
      if (!isManualSessionState(f.state))
        throw new Error('Expected manual checkpoint');
      expect(f.state.format_version).toBe(5);
      expect(f.bindings.map((binding) => binding.checkpointDigest)).toEqual([
        sha(f.exact),
        sha(f.exact),
      ]);
      expect(f.bindings.map((binding) => binding.requestDigest)).toEqual([
        sha('{"id":"0"}'),
        sha('{"id":"1"}'),
      ]);
      const first = await f.jobs.advance(f.session, f.request);
      expect(first.status).toBe('continued');
      expect(f.model.requests).toHaveLength(1);
      const second = await nextAction(f.session, 'second-call');
      expect(second.callId).toBe('second-call');
      const last = await f.jobs.advance(f.session, second);
      if (last.status !== 'continued')
        throw new Error('Expected final continuation');
      expect((await last.turn.wait()).finalOutput).toEqual({ answer: 'done' });
      expect(f.journal.claim.mock.calls.map(([binding]) => binding)).toEqual(
        f.bindings,
      );
      f.model.assertExhausted();
    }, 25_000);

    it('keeps exact large-counter bindings after partial sibling delivery without final native continuation', async () => {
      await using f = await fixture({
        siblings: true,
        prompted: true,
        largeUsage: true,
      });
      if (!isManualSessionState(f.state))
        throw new Error('Expected manual checkpoint');
      expect(f.state.format_version).toBe(5);
      expect(f.state.manual_context.usage).toMatchObject({
        inputTokens: '9007199254740993',
        cachedInputTokens: 9007199254740990,
        totalTokens: '9007199254741000',
      });
      expect(JSON.stringify(f.state)).toBe(f.exact);
      expect(f.bindings.map((binding) => binding.checkpointDigest)).toEqual([
        sha(f.exact),
        sha(f.exact),
      ]);
      const first = await f.jobs.advance(f.session, f.request);
      expect(first.status).toBe('continued');
      expect(f.model.requests).toHaveLength(1);
      const second = await nextAction(f.session, 'second-call');
      f.journal.claim.mockImplementation(async (binding) => ({
        binding,
        key: KEY,
        generation: GENERATION,
        action: 'busy',
      }));
      // The first reply remains pending behind its sibling. Final native
      // continuation needs the catalog-capacity fixture used by history counters.
      expect(await f.jobs.advance(f.session, second)).toEqual({
        status: 'busy',
      });
      expect(f.journal.claim.mock.calls.map(([binding]) => binding)).toEqual(
        f.bindings,
      );
      expect(f.backend.start).toHaveBeenCalledTimes(1);
      expect(f.backend.observe).not.toHaveBeenCalled();
      expect(f.project).toHaveBeenCalledTimes(1);
      expect(f.journal.saveResult).toHaveBeenCalledTimes(1);
      expect(f.model.requests).toHaveLength(1);
    }, 20_000);

    it('replays a saved result on a fresh grant without calling the provider, projector or saving it again', async () => {
      await using f = await fixture();
      f.journal.claim.mockImplementation(async (binding) => ({
        binding,
        key: KEY,
        generation: GENERATION,
        action: 'deliver',
        resultJson: '"saved-safe"',
      }));
      const result = await f.jobs.advance(f.session, f.request);
      if (result.status !== 'continued')
        throw new Error('Expected saved continuation');
      expect((await result.turn.wait()).finalOutput).toBe('done');
      for (const method of Object.values(f.backend))
        expect(method).not.toHaveBeenCalled();
      expect(f.project).not.toHaveBeenCalled();
      expect(f.journal.record).not.toHaveBeenCalled();
      expect(f.journal.saveResult).not.toHaveBeenCalled();
      expect(JSON.stringify(f.model.requests[1])).toContain('saved-safe');
      f.model.assertExhausted();
    }, 20_000);

    it('explicitly restores a saved result with current provider credentials and fresh authority without repeating the external effect', async () => {
      await using f = await fixture();
      f.journal.authorize.mockImplementation(async (_claim, action) => {
        if (action === 'deliver') throw new DeferredAuthorizationError();
      });
      await expect(f.jobs.advance(f.session, f.request)).rejects.toBeInstanceOf(
        DeferredAuthorizationError,
      );
      expect(f.backend.start).toHaveBeenCalledTimes(1);
      expect(f.project).toHaveBeenCalledTimes(1);
      const saved = f.journal.saveResult.mock.calls[0]![1];
      expect(saved).toBe('"safe-result"');
      await f.session.close();
      const config = await f.model.config();
      await using currentProvider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-deferred-current-C',
        supportsWebsockets: false,
      });
      f.journal.authorize.mockResolvedValue(undefined);
      f.journal.claim.mockImplementation(async (binding) => ({
        binding,
        key: KEY,
        generation: GENERATION,
        action: 'deliver',
        resultJson: saved,
      }));
      await using restored = await f.agent.session({
        state: f.state,
        provider: currentProvider,
      });
      const fresh = await nextAction(restored);
      expect(fresh).not.toBe(f.request);
      await expect(f.jobs.advance(restored, f.request)).rejects.toThrow();
      expect(f.journal.claim).toHaveBeenCalledTimes(1);
      expect(f.model.requests).toHaveLength(1);
      const result = await f.jobs.advance(restored, fresh);
      if (result.status !== 'continued')
        throw new Error('Expected recovered delivery');
      expect((await result.turn.wait()).finalOutput).toBe('done');
      expect(f.backend.start).toHaveBeenCalledTimes(1);
      expect(f.backend.observe).not.toHaveBeenCalled();
      expect(f.backend.reconcileCreation).not.toHaveBeenCalled();
      expect(f.backend.respond).not.toHaveBeenCalled();
      expect(f.backend.cancel).not.toHaveBeenCalled();
      expect(f.project).toHaveBeenCalledTimes(1);
      expect(f.journal.record).toHaveBeenCalledTimes(1);
      expect(f.journal.saveResult).toHaveBeenCalledTimes(1);
      expect(f.journal.claim).toHaveBeenCalledTimes(2);
      expect(f.journal.claim.mock.calls[1]![0]).toEqual(f.bindings[0]);
      expect(f.model.requests[1]?.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'function_call_output',
            call_id: fresh.callId,
            output: JSON.parse(saved),
          }),
        ]),
      );
      expect(
        f.model.requestHeaders.map((headers) => headers.authorization),
      ).toEqual([`Bearer ${API_KEY}`, 'Bearer synthetic-deferred-current-C']);
      f.model.assertExhausted();
    }, 25_000);

    it.each(['respond', 'cancel'] as const)(
      'uses only the explicitly claimed %s operation and preserves its receipt',
      async (operation) => {
        await using f = await fixture();
        f.journal.claim.mockImplementation(async (binding) => ({
          binding,
          key: KEY,
          generation: GENERATION,
          action: operation,
          update: { status: 'inputRequired', receipt: RECEIPT },
        }));
        const response = { confirmation: 'accepted' };
        const result = await f.jobs.advance(
          f.session,
          f.request,
          operation === 'respond' ? { operation, response } : { operation },
        );
        expect(f.journal.claim.mock.calls[0]![1]).toBe(operation);
        expect(f.journal.record.mock.calls[0]![1].receipt).toBe(RECEIPT);
        expect(f.backend.start).not.toHaveBeenCalled();
        expect(f.backend.observe).not.toHaveBeenCalled();
        if (operation === 'respond') {
          expect(f.backend.respond.mock.calls[0]![1]).toBe(response);
          expect(f.backend.cancel).not.toHaveBeenCalled();
          if (result.status !== 'continued')
            throw new Error('Expected response completion');
          expect((await result.turn.wait()).finalOutput).toBe('done');
        } else {
          expect(result).toEqual({ status: 'cancelled' });
          expect(f.backend.cancel).toHaveBeenCalledTimes(1);
          expect(f.backend.respond).not.toHaveBeenCalled();
          expect(f.model.requests).toHaveLength(1);
        }
      },
      20_000,
    );

    it.each(['failed', 'cancelled'] as const)(
      'leaves a %s job pending until the host explicitly supplies a safe reply',
      async (status) => {
        await using f = await fixture();
        f.backend.start.mockResolvedValueOnce({ status });
        expect(await f.jobs.advance(f.session, f.request)).toEqual({ status });
        expect(f.model.requests).toHaveLength(1);
        expect(f.project).not.toHaveBeenCalled();
        expect(f.journal.saveResult).not.toHaveBeenCalled();
        const pending = await f.session.wait({ until: 'manual_tool' });
        expect('requests' in pending).toBe(true);
        await f.session.respond(
          f.request.reply('The host confirmed the job stopped.'),
        );
        expect((await f.session.wait()).finalOutput).toBe('done');
        expect(f.backend.start).toHaveBeenCalledTimes(1);
        f.model.assertExhausted();
      },
      20_000,
    );

    it.each(['binding', 'action', 'stale request'] as const)(
      'rejects a mismatched %s before invoking a provider',
      async (reason) => {
        await using f = await fixture();
        f.journal.claim.mockImplementation(async (binding) =>
          reason === 'binding'
            ? {
                binding: { ...binding, checkpointDigest: '0'.repeat(64) },
                key: KEY,
                generation: GENERATION,
                action: 'start',
              }
            : {
                binding,
                key: KEY,
                generation: GENERATION,
                action: 'cancel',
                update: { status: 'pending', receipt: RECEIPT },
              },
        );
        await expect(
          f.jobs.advance(
            f.session,
            reason === 'stale request' ? f.stale : f.request,
          ),
        ).rejects.toThrow();
        for (const method of Object.values(f.backend))
          expect(method).not.toHaveBeenCalled();
        expect(f.journal.record).not.toHaveBeenCalled();
        expect(f.model.requests).toHaveLength(1);
        if (reason === 'stale request')
          expect(f.journal.claim).not.toHaveBeenCalled();
      },
      15_000,
    );

    it.each(['start', 'project', 'deliver', 'record', 'saveResult'] as const)(
      'does not deliver when the journal denies %s',
      async (phase) => {
        await using f = await fixture();
        f.journal.authorize.mockImplementation(async (_claim, action) => {
          if (action === phase) throw new DeferredAuthorizationError();
        });
        if (phase === 'record')
          f.journal.record.mockRejectedValue(new DeferredAuthorizationError());
        if (phase === 'saveResult')
          f.journal.saveResult.mockRejectedValue(
            new DeferredAuthorizationError(),
          );
        await expect(
          f.jobs.advance(f.session, f.request),
        ).rejects.toBeInstanceOf(DeferredAuthorizationError);
        expect(f.model.requests).toHaveLength(1);
        if (phase === 'start') expect(f.backend.start).not.toHaveBeenCalled();
        if (phase === 'start' || phase === 'record' || phase === 'project')
          expect(f.journal.saveResult).not.toHaveBeenCalled();
      },
      15_000,
    );

    it('rejects replacement receipts and retains an omitted receipt on later completion', async () => {
      await using f = await fixture();
      f.journal.claim.mockImplementation(async (binding) => ({
        binding,
        key: KEY,
        generation: GENERATION,
        action: 'observe',
        update: { status: 'pending', receipt: RECEIPT },
      }));
      f.backend.observe.mockResolvedValue({
        status: 'completed',
        receipt: 'replacement-receipt',
        value: 'safe',
      });
      await expect(f.jobs.advance(f.session, f.request)).rejects.toThrow();
      expect(f.journal.record).not.toHaveBeenCalled();
      expect(f.project).not.toHaveBeenCalled();
      f.backend.observe.mockResolvedValue({
        status: 'completed',
        value: 'safe',
      });
      const result = await f.jobs.advance(f.session, f.request);
      if (result.status !== 'continued') throw new Error('Expected completion');
      expect((await result.turn.wait()).finalOutput).toBe('done');
      expect(f.journal.record.mock.calls[0]![1]).toEqual({
        status: 'completed',
        receipt: RECEIPT,
        value: 'safe',
      });
      expect(f.backend.start).not.toHaveBeenCalled();
      f.model.assertExhausted();
    }, 20_000);

    it.each([
      'raw key',
      'escaped key',
      'receipt',
      'API key',
      'UTF8 bytes',
    ] as const)(
      'withholds saved-result %s from native delivery',
      async (kind) => {
        await using f = await fixture({
          maxOutputBytes: kind === 'UTF8 bytes' ? 5 : 1024,
        });
        const raw =
          kind === 'escaped key'
            ? '"\\u006fpaque-private-job-key"'
            : JSON.stringify(
                kind === 'receipt'
                  ? RECEIPT
                  : kind === 'API key'
                    ? API_KEY
                    : kind === 'UTF8 bytes'
                      ? 'éé'
                      : KEY,
              );
        f.journal.claim.mockImplementation(async (binding) => ({
          binding,
          key: KEY,
          generation: GENERATION,
          action: 'deliver',
          resultJson: raw,
          update: { status: 'completed', receipt: RECEIPT },
        }));
        await expect(f.jobs.advance(f.session, f.request)).rejects.toThrow();
        expect(f.model.requests).toHaveLength(1);
        expect(f.journal.saveResult).not.toHaveBeenCalled();
        expect(f.journal.authorize).not.toHaveBeenCalled();
        expect(f.project).not.toHaveBeenCalled();
      },
      15_000,
    );

    it.each([
      ['projected', 'ASCII whitespace', ' \t'],
      ['saved', 'ASCII whitespace', ' \t'],
      ['escaped saved', 'ASCII whitespace', ' \t'],
      ['projected', 'Unicode whitespace', '\u0085\u2003'],
      ['saved', 'Unicode whitespace', '\u0085\u2003'],
      ['escaped saved', 'Unicode whitespace', '\u0085\u2003'],
    ] as const)(
      'withholds %s credentials normalized from %s',
      async (route, _kind, padding) => {
        const effectiveKey =
          route === 'escaped saved' ? `${API_KEY}\\"` : API_KEY;
        await using f = await fixture({
          apiKey: `${padding}${effectiveKey}${padding}`,
        });
        expect(f.model.requestHeaders[0]?.authorization).toBe(
          `Bearer ${effectiveKey}`,
        );
        if (route === 'projected') {
          f.backend.start.mockResolvedValue({
            status: 'completed',
            receipt: RECEIPT,
            value: effectiveKey,
          });
        } else {
          const raw = JSON.stringify(effectiveKey);
          if (route === 'escaped saved')
            expect(raw).not.toContain(effectiveKey);
          f.journal.claim.mockImplementation(async (binding) => ({
            binding,
            key: KEY,
            generation: GENERATION,
            action: 'deliver',
            resultJson: raw,
            update: { status: 'completed', receipt: RECEIPT },
          }));
        }
        await expect(f.jobs.advance(f.session, f.request)).rejects.toThrow();
        expect(f.journal.saveResult).not.toHaveBeenCalled();
        expect(f.model.requests).toHaveLength(1);

        f.journal.claim.mockImplementation(async (binding) => ({
          binding,
          key: KEY,
          generation: GENERATION,
          action: 'deliver',
          resultJson: JSON.stringify('safe-result'),
          update: { status: 'completed', receipt: RECEIPT },
        }));
        const result = await f.jobs.advance(f.session, f.request);
        if (result.status !== 'continued')
          throw new Error('Expected the original request to remain usable');
        expect((await result.turn.wait()).finalOutput).toBe('done');
        f.model.assertExhausted();
      },
      20_000,
    );

    it('withholds a private object key even when the saved result matches its supported object schema', async () => {
      await using f = await objectFixture();
      f.journal.claim.mockImplementation(async (binding) => ({
        binding,
        key: KEY,
        generation: GENERATION,
        action: 'deliver',
        resultJson: JSON.stringify({ [KEY]: 'safe' }),
      }));
      await expect(f.jobs.advance(f.session, f.request)).rejects.toThrow();
      expect(f.model.requests).toHaveLength(1);
      expect(f.journal.authorize).not.toHaveBeenCalled();
      expect(f.project).not.toHaveBeenCalled();
    }, 15_000);

    it('accepts a result exactly at its UTF8 byte limit', async () => {
      await using f = await fixture({ maxOutputBytes: 6 });
      f.backend.start.mockResolvedValue({ status: 'completed', value: 'éé' });
      const result = await f.jobs.advance(f.session, f.request);
      if (result.status !== 'continued')
        throw new Error('Expected bounded result');
      expect((await result.turn.wait()).finalOutput).toBe('done');
      expect(
        Buffer.byteLength(f.journal.saveResult.mock.calls[0]![1], 'utf8'),
      ).toBe(6);
    }, 20_000);

    it('saves and delivers a large shallow array within its byte limit', async () => {
      const value = { values: Array<number>(150_000).fill(0) };
      const maxOutputBytes = 1_048_576;
      expect(Buffer.byteLength(JSON.stringify(value), 'utf8')).toBeLessThan(
        maxOutputBytes,
      );
      await using f = await preparedFixture(
        (name) =>
          deferredTool({
            name,
            description: 'Read a bounded numeric result',
            schemas: (builder) => ({
              parameters: builder.strictObject({ id: builder.string() }),
              result: builder.strictObject({
                values: builder.array(builder.number()),
              }),
            }),
          }),
        (raw) => z.object({ values: z.array(z.number()) }).parse(raw),
        { maxOutputBytes },
      );
      f.backend.start.mockResolvedValue({ status: 'completed', value });
      const result = await f.jobs.advance(f.session, f.request);
      if (result.status !== 'continued')
        throw new Error('Expected bounded array result');
      expect((await result.turn.wait()).finalOutput).toBe('done');
      expect(JSON.parse(f.journal.saveResult.mock.calls[0]![1])).toEqual(value);
      expect(f.backend.start).toHaveBeenCalledTimes(1);
      f.model.assertExhausted();
    }, 20_000);

    it('joins an aborted provider without implicitly cancelling its external job', async () => {
      await using f = await fixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let signal: AbortSignal | undefined;
      f.backend.start.mockImplementation(async (_claim, _input, context) => {
        signal = context.signal;
        entered.resolve();
        await release.promise;
        return { status: 'pending', receipt: RECEIPT };
      });
      const controller = new AbortController();
      let finished = false;
      const advance = f.jobs
        .advance(f.session, f.request, { signal: controller.signal })
        .catch((error: unknown) => error)
        .finally(() => {
          finished = true;
        });
      try {
        await entered.promise;
        controller.abort();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(signal?.aborted).toBe(true);
        expect(finished).toBe(false);
        expect(f.backend.cancel).not.toHaveBeenCalled();
      } finally {
        release.resolve();
      }
      await advance;
      expect(f.backend.cancel).not.toHaveBeenCalled();
      expect(f.journal.saveResult).not.toHaveBeenCalled();
      expect(f.model.requests).toHaveLength(1);
    }, 15_000);

    it.each(['strong', 'weak'] as const)(
      'reconciles a %s creation claim without another start',
      async (strength) => {
        await using f = await fixture({ weak: strength === 'weak' });
        f.journal.claim.mockImplementation(async (binding) => ({
          binding,
          key: KEY,
          generation: GENERATION,
          action: 'reconcileCreation',
        }));
        f.backend.reconcileCreation.mockResolvedValue({
          status: 'completed',
          receipt: RECEIPT,
          value: 'reconciled-safe',
        });
        const result = await f.jobs.advance(f.session, f.request);
        expect(f.backend.start).not.toHaveBeenCalled();
        if (strength === 'strong') {
          expect(f.backend.reconcileCreation).toHaveBeenCalledTimes(1);
          if (result.status !== 'continued')
            throw new Error('Expected reconciled continuation');
          expect((await result.turn.wait()).finalOutput).toBe('done');
          f.model.assertExhausted();
        } else {
          expect(result).toEqual({ status: 'unknown' });
          expect(f.backend.reconcileCreation).not.toHaveBeenCalled();
          expect(f.journal.record).not.toHaveBeenCalled();
          expect(f.model.requests).toHaveLength(1);
        }
      },
      20_000,
    );

    it.each([0, 1000] as const)(
      'starts once and observes at most once with waitMs=%s',
      async (waitMs) => {
        await using f = await fixture();
        f.backend.start.mockResolvedValue({
          status: 'pending',
          receipt: RECEIPT,
        });
        f.backend.observe.mockResolvedValue({
          status: 'pending',
          receipt: RECEIPT,
        });
        expect(await f.jobs.advance(f.session, f.request, { waitMs })).toEqual({
          status: 'pending',
        });
        expect(f.backend.start).toHaveBeenCalledTimes(1);
        expect(f.backend.observe).toHaveBeenCalledTimes(waitMs === 0 ? 0 : 1);
        expect(f.journal.record).toHaveBeenCalledTimes(waitMs === 0 ? 1 : 2);
        expect(f.project).not.toHaveBeenCalled();
        expect(f.model.requests).toHaveLength(1);
      },
      15_000,
    );

    it.each(['provider', 'journal'] as const)(
      'returns unknown after an uncertain %s outcome without retrying',
      async (owner) => {
        await using f = await fixture();
        if (owner === 'provider')
          f.backend.start.mockRejectedValue(
            new Error('private provider failure'),
          );
        else
          f.journal.record.mockRejectedValue(
            new Error('private journal failure'),
          );
        expect(await f.jobs.advance(f.session, f.request)).toEqual({
          status: 'unknown',
        });
        expect(f.backend.start).toHaveBeenCalledTimes(1);
        expect(f.backend.observe).not.toHaveBeenCalled();
        expect(f.backend.reconcileCreation).not.toHaveBeenCalled();
        expect(f.project).not.toHaveBeenCalled();
        expect(f.journal.saveResult).not.toHaveBeenCalled();
        expect(f.model.requests).toHaveLength(1);
      },
      15_000,
    );

    it.each(['provider observation', 'journal observation'] as const)(
      'distinguishes a bounded %s timeout from an uncertain journal outcome',
      async (phase) => {
        await using f = await fixture();
        f.backend.start.mockResolvedValue({
          status: 'pending',
          receipt: RECEIPT,
        });
        if (phase === 'provider observation') {
          f.backend.observe.mockImplementation(async (_claim, { signal }) => {
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else
                signal.addEventListener('abort', () => resolve(), {
                  once: true,
                });
            });
            signal.throwIfAborted();
            return { status: 'unknown' };
          });
        } else {
          f.backend.observe.mockResolvedValue({
            status: 'completed',
            value: 'safe',
          });
          f.journal.record.mockImplementation(async (_claim, update) => {
            if (update.status === 'completed')
              throw new DOMException('private journal timeout', 'TimeoutError');
          });
        }
        expect(
          await f.jobs.advance(f.session, f.request, {
            waitMs: 10,
            timeoutMs: 1000,
          }),
        ).toEqual({
          status: phase === 'provider observation' ? 'pending' : 'unknown',
        });
        expect(f.backend.start).toHaveBeenCalledTimes(1);
        expect(f.backend.observe).toHaveBeenCalledTimes(1);
        expect(f.backend.cancel).not.toHaveBeenCalled();
        expect(f.journal.saveResult).not.toHaveBeenCalled();
        expect(f.model.requests).toHaveLength(1);
      },
      15_000,
    );
  },
);
