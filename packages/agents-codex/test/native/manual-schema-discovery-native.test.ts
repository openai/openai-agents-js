import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  manualTool,
  tool,
  type ActionRequested,
  type Session,
} from '../../src';
import {
  DeferredTools,
  type JobBinding,
  type JobClaim,
  type JobContext,
  type JobUpdate,
} from '../../src/experimental/deferred';
import { deferredTool } from '../../src/experimental/deferred-tool';
import { jsonObject, type JsonObject } from '../../src/runtime/binding';
import { isManualSessionState } from '../../src/runtime/state';
import { ModelServer, call, message } from './fixtures/model-server';

async function providerFor(model: ModelServer) {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: jsonObject.parse(config['model_providers.fixture'])
      .base_url as string,
    apiKey: 'synthetic-manual-discovery',
    supportsWebsockets: false,
  });
}

function search(callId: string): JsonObject {
  return {
    type: 'tool_search_call',
    call_id: callId,
    execution: 'client',
    arguments: { query: 'render pages', limit: 5 },
  };
}

function discovered(request: JsonObject, callId: string) {
  const receipt = (request.input as JsonObject[]).findLast(
    (item) => item.type === 'tool_search_output' && item.call_id === callId,
  );
  expect(receipt).toBeDefined();
  return JSON.stringify(receipt);
}

async function nextAction(session: Session): Promise<ActionRequested> {
  for await (const event of session.events())
    if (event.type === 'action_requested') return event;
  throw new Error('Expected a discovered manual request');
}

class RestoringAgent extends Agent {
  readonly restoredRequests: ActionRequested[] = [];
  override async session(...args: Parameters<Agent['session']>) {
    const session = await super.session(...args);
    try {
      if (args[0]?.state) this.restoredRequests.push(await nextAction(session));
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
}

function deferredFixture() {
  const declaration = deferredTool({
    name: 'render',
    description: 'Render a page report',
    deferLoading: true,
    schemas: (builder) => ({
      parameters: builder.strictObject({ pages: builder.number().int() }),
      result: builder.string(),
    }),
  });
  const journal = {
    prepare: vi.fn(
      async (
        _json: string,
        _bindings: readonly JobBinding[],
        _context: JobContext,
      ) => {},
    ),
    claim: vi.fn(
      async (
        binding: JobBinding,
        _operation: 'advance' | 'respond' | 'cancel',
        _context: JobContext,
      ): Promise<JobClaim> => ({
        binding,
        key: 'synthetic-render-job',
        generation: '1',
        action: 'start',
      }),
    ),
    authorize: vi.fn(
      async (_claim: JobClaim, _action: string, _context: JobContext) => {},
    ),
    record: vi.fn(
      async (_claim: JobClaim, _update: JobUpdate, _context: JobContext) => {},
    ),
    saveResult: vi.fn(
      async (_claim: JobClaim, _json: string, _context: JobContext) => {},
    ),
  };
  const backend = {
    start: vi.fn(
      async (
        _claim: JobClaim,
        _input: { pages: number },
        _context: JobContext,
      ): Promise<JobUpdate> => ({
        status: 'completed',
        receipt: 'synthetic-render-receipt',
        value: 'rendered',
      }),
    ),
    observe: vi.fn(
      async (_claim: JobClaim, _context: JobContext): Promise<JobUpdate> => ({
        status: 'unknown',
      }),
    ),
    reconcileCreation: vi.fn(
      async (
        _claim: JobClaim,
        _input: { pages: number },
        _context: JobContext,
      ): Promise<JobUpdate> => ({ status: 'unknown' }),
    ),
  };
  const jobs = new DeferredTools({ tenant: 'tenant', runId: 'run', journal });
  jobs.register(declaration, {
    providerId: 'render-provider',
    provider: backend,
    project: String,
  });
  return { declaration, journal, backend, jobs };
}

afterEach(async () => {
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'manual schema discovery',
  () => {
    it('discovers an exact manual declaration and excludes an omitted destructive tool', async () => {
      const declaration = manualTool({
        name: 'render',
        description: 'Render a page report',
        deferLoading: true,
        parameters: z.object({ pages: z.number().int() }),
        result: z.string(),
      });
      const destroy = vi.fn(() => 'destroyed');
      const omitted = tool({
        name: 'render_delete',
        description: 'Destroy rendered page reports',
        deferLoading: true,
        parameters: z.object({ pages: z.number().int() }),
        execute: destroy,
      });
      const model = new ModelServer([
        [search('manual-schema')],
        [call('render', { pages: 2 }, { callId: 'render-once' })],
        [call('render_delete', { pages: 2 }, { callId: 'forbidden' })],
        [message('rendered safely')],
      ]);
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Render only the selected report.',
        model: 'gpt-5.5',
        provider,
        tools: [declaration, omitted],
        programmaticToolCalling: false,
      }).session();
      const turn = await session.submit('Render two pages.', {
        tools: [declaration],
      });
      const request = await nextAction(session);
      const exact = declaration.match(request);
      expect(exact).toBe(request);
      expect(exact?.arguments).toEqual({ pages: 2 });
      expect(exact?.callId).toBe('render-once');
      expect(discovered(model.requests[1], 'manual-schema')).toContain(
        'render',
      );
      expect(discovered(model.requests[1], 'manual-schema')).not.toContain(
        'render_delete',
      );
      expect(JSON.stringify(model.requests[0].tools)).toContain('tool_search');
      expect(JSON.stringify(model.requests[0].tools)).not.toContain(
        '"name":"render"',
      );
      await session.respond(exact!.reply('rendered'));
      expect((await turn.wait()).finalOutput).toBe('rendered safely');
      expect(await session.pendingInteractions()).toEqual([]);
      expect(destroy).not.toHaveBeenCalled();
      model.assertExhausted();
    }, 20_000);

    it('keeps prompted output and current restored authority for a discovered deferred tool', async () => {
      const f = deferredFixture();
      const model = new ModelServer([
        [search('deferred-schema')],
        [call('render', { pages: 2 }, { callId: 'render-once' })],
        [message('{"report":"typed prompted","pages":2}')],
        [message('{"response":"future native"}')],
      ]);
      await using provider = await providerFor(model);
      const agent = new RestoringAgent({
        instructions: 'Render a report.',
        model: 'gpt-5.5',
        provider,
        tools: [f.declaration],
        outputType: { mode: 'native', schema: z.string() },
        programmaticToolCalling: false,
      });
      await using source = await agent.session();
      const original = await source.submit('Render two pages.', {
        outputType: {
          mode: 'prompted',
          schema: z.object({ report: z.string(), pages: z.number().int() }),
        },
      });
      const completion = original.wait().catch((error: unknown) => error);
      const request = await nextAction(source);
      expect(f.declaration.match(request)).toBe(request);
      expect(request.arguments).toEqual({ pages: 2 });
      expect(discovered(model.requests[1], 'deferred-schema')).toContain(
        'render',
      );
      for (const operation of Object.values(f.backend))
        expect(operation).not.toHaveBeenCalled();
      await f.jobs.start(source, request, {}, async ({ session, outcome }) => {
        expect(f.journal.prepare).toHaveBeenCalledTimes(1);
        expect(agent.restoredRequests).toHaveLength(1);
        const current = agent.restoredRequests[0]!;
        expect(current).not.toBe(request);
        expect(f.declaration.match(current)).toBe(current);
        expect(current.callId).toBe(request.callId);
        await expect(source.respond(request.reply('stale'))).rejects.toThrow();
        if (outcome.status !== 'continued')
          throw new Error('Expected a discovered deferred continuation');
        expect((await outcome.turn.wait()).finalOutput).toEqual({
          report: 'typed prompted',
          pages: 2,
        });
        expect((await (await session.submit('Next.')).wait()).finalOutput).toBe(
          'future native',
        );
      });
      expect(await completion).toBeInstanceOf(InteractionRequired);
      expect(f.backend.start).toHaveBeenCalledTimes(1);
      expect(f.backend.start.mock.calls[0]![1]).toEqual({ pages: 2 });
      expect(f.journal.saveResult).toHaveBeenCalledTimes(1);
      model.assertExhausted();
    }, 20_000);

    it.each([false, true])(
      'prepares a target-only deferred checkpoint with an unrelated root manual=%s',
      async (rootManual) => {
        const f = deferredFixture();
        const model = new ModelServer([
          [call('transfer_to_b', {}, { callId: 'handoff' })],
          [search('target-schema')],
          [call('render', { pages: 2 }, { callId: 'target-render' })],
        ]);
        await using provider = await providerFor(model);
        const target = new Agent({
          name: 'B',
          instructions: 'Render.',
          tools: [f.declaration],
        });
        const spare = manualTool({
          name: 'spare',
          description: 'An unrelated root tool.',
          parameters: z.object({}),
          result: z.number(),
        });
        const agent = new Agent({
          name: 'A',
          instructions: 'Hand off to B.',
          model: 'gpt-5.5',
          provider,
          tools: rootManual ? [spare] : [],
          handoffs: [target],
        });
        await using session = await agent.session();
        const turn = await session.submit('Prepare two pages.');
        const completion = turn.wait().catch((error: unknown) => error);
        const request = await nextAction(session);
        const state = await f.jobs.prepare(session, request);
        if (!isManualSessionState(state))
          throw new Error('Expected manual checkpoint');
        expect(await completion).toBeInstanceOf(InteractionRequired);
        expect(state.manual_continuation.pending_manual).toMatchObject([
          { call_id: 'target-render', name: 'render' },
        ]);
        expect(
          state.manual_context.result_schemas.map((entry) => entry.name),
        ).toEqual(['render']);
        expect(f.journal.prepare).toHaveBeenCalledTimes(1);
        for (const operation of Object.values(f.backend))
          expect(operation).not.toHaveBeenCalled();
        model.assertExhausted();
      },
      20_000,
    );

    it.each(['missing', 'wrong id', 'server', 'unfinished'] as const)(
      'rejects a %s native search receipt before restoring manual work',
      async (invalidReceipt) => {
        const f = deferredFixture();
        const model = new ModelServer([
          [search('schema-receipt')],
          [call('render', { pages: 2 }, { callId: 'pending-render' })],
        ]);
        await using provider = await providerFor(model);
        const agent = new Agent({
          instructions: 'Render.',
          model: 'gpt-5.5',
          provider,
          tools: [f.declaration],
          programmaticToolCalling: false,
        });
        await using source = await agent.session();
        const original = await source.submit('Prepare two pages.');
        const completion = original.wait().catch((error: unknown) => error);
        const request = await nextAction(source);
        const state = structuredClone(await f.jobs.prepare(source, request));
        expect(await completion).toBeInstanceOf(InteractionRequired);
        const receipts = state.history.filter((row) => {
          if (row.type !== 'response_item') return false;
          const payload = jsonObject.parse(row.payload);
          return (
            payload.type === 'tool_search_output' &&
            payload.call_id === 'schema-receipt'
          );
        });
        expect(receipts).toHaveLength(1);
        const receipt = receipts[0]!;
        if (invalidReceipt === 'missing')
          state.history = state.history.filter((row) => row !== receipt);
        else {
          const payload = jsonObject.parse(receipt.payload);
          if (invalidReceipt === 'wrong id')
            payload.call_id = 'not-the-native-call';
          else if (invalidReceipt === 'server') payload.execution = 'server';
          else payload.status = 'in_progress';
          receipt.payload = payload;
        }
        const before = model.requests.length;
        let unexpected: Session | undefined;
        try {
          await expect(
            agent.session({ state }).then((session) => {
              unexpected = session;
              return session;
            }),
          ).rejects.toThrow();
        } finally {
          await unexpected?.close();
        }
        expect(model.requests).toHaveLength(before);
        for (const operation of Object.values(f.backend))
          expect(operation).not.toHaveBeenCalled();
        model.assertExhausted();
      },
      20_000,
    );
  },
);
