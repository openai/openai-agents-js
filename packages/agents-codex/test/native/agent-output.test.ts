import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  type AgentOutput,
  type AgentOptions,
  type ActionRequested,
  type Session,
  type SessionOptions,
} from '../../src';
import { DeferredTools } from '../../src/experimental/deferred';
import { deferredTool } from '../../src/experimental/deferred-tool';
import { ModelServer, call, message } from './fixtures/model-server';

const gate = () => Promise.withResolvers<void>();
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'fixture',
    supportsWebsockets: false,
  });
}

async function nextAction(session: Session<unknown>): Promise<ActionRequested> {
  for await (const event of session.events())
    if (event.type === 'action_requested') return event;
  throw new Error('Expected a manual request');
}

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe('Agent output views', () => {
  it('refuses unadapted subclasses before invoking a property-based policy or acquiring a provider', async () => {
    class PropertyPolicy extends Agent {
      checked = 0;
      override async session(options: SessionOptions = {}) {
        this.checked++;
        expect(this.outputType).toBeUndefined();
        return super.session(options);
      }
    }
    const agent = new PropertyPolicy({ instructions: 'Answer.' });
    const acquire = vi.spyOn(agent.provider, '_acquire');
    const view = agent.withOutputType(z.number());
    try {
      await expect(view.session()).rejects.toThrow('supportsOutputVariants');
      await expect(view.run('Count')).rejects.toThrow('supportsOutputVariants');
      expect(agent.checked).toBe(0);
      expect(acquire).not.toHaveBeenCalled();
    } finally {
      await agent.provider.close();
    }
  });

  it('preserves private-field hooks and constructor identity, with typed reusable output and unchanged defaults', async () => {
    const schema = z.object({ count: z.number() });
    let initializations = 0;
    class PolicyAgent extends Agent {
      #calls = 0;
      readonly receivers: PolicyAgent[] = [];
      readonly observed: Promise<number>[] = [];
      constructor(options: AgentOptions) {
        super(options);
        initializations++;
      }
      protected override supportsOutputVariants() {
        return true;
      }
      get calls() {
        return this.#calls;
      }
      override async session(options: SessionOptions = {}) {
        this.#calls++;
        this.receivers.push(this);
        if (this.outputTypeFor(options) === denied)
          throw new Error('Output denied by application policy');
        const session = await super.session({ ...options });
        this.observed.push(
          (async () => {
            let finished = 0;
            for await (const event of session.events())
              if (event.type === 'turn_finished') finished++;
            return finished;
          })(),
        );
        return session;
      }
    }
    const denied = z.boolean();
    const server = new ModelServer([
      [message('{"count":2}')],
      [message('{"count":3}')],
      [message('ordinary text')],
    ]);
    const provider = await providerFor(server);
    const agent = new PolicyAgent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    });
    const view = agent.withOutputType(schema);
    expectTypeOf(view).toEqualTypeOf<
      AgentOutput<undefined, { count: number }>
    >();
    try {
      const acquire = vi.spyOn(provider, '_acquire');
      await expect(agent.withOutputType(denied).session()).rejects.toThrow(
        'Output denied',
      );
      expect(acquire).not.toHaveBeenCalled();
      const first = await view.run('FIRST', { returnState: true });
      expectTypeOf(first.finalOutput).toEqualTypeOf<{ count: number }>();
      expect(first.finalOutput).toEqual({ count: 2 });
      expect(first.state).toBeDefined();
      const session = await view.session();
      expectTypeOf(session).toEqualTypeOf<
        Session<{ count: number }, undefined>
      >();
      try {
        expect(
          (await (await session.submit('SECOND')).wait()).finalOutput,
        ).toEqual({ count: 3 });
      } finally {
        await session.close();
      }
      expect((await agent.run('PLAIN')).finalOutput).toBe('ordinary text');
      expect(initializations).toBe(1);
      expect(agent.calls).toBe(4);
      expect(agent.receivers).toEqual([agent, agent, agent, agent]);
      expect(await Promise.all(agent.observed)).toEqual([1, 1, 1]);
      expect(agent.outputType).toBeUndefined();
      expect(view.outputType).toBe(schema);
      expect(view).not.toBeInstanceOf(Agent);
      expect(Object.isFrozen(view)).toBe(true);
      server.assertExhausted();
    } finally {
      await provider.close();
    }
  });

  it('keeps concurrent openings independent across a rejected opening and changing Agent defaults', async () => {
    const number = z.number();
    const object = z.object({ label: z.string() });
    const denied = z.boolean();
    const numberEntered = gate(),
      objectEntered = gate(),
      failedEntered = gate();
    const releaseNumber = gate(),
      releaseObject = gate(),
      releaseFailed = gate();
    class ConcurrentAgent extends Agent {
      protected override supportsOutputVariants() {
        return true;
      }
      override async session(options: SessionOptions = {}) {
        const output = this.outputTypeFor(options);
        if (output === number) {
          numberEntered.resolve();
          await releaseNumber.promise;
        }
        if (output === object) {
          objectEntered.resolve();
          await releaseObject.promise;
        }
        if (output === denied) {
          failedEntered.resolve();
          await releaseFailed.promise;
          throw new Error('Opening refused');
        }
        return super.session({ ...options });
      }
    }
    const server = new ModelServer([
      [message('plain')],
      [message('{"label":"object"}')],
      [message('{"response":7}')],
    ]);
    const provider = await providerFor(server);
    const agent = new ConcurrentAgent({
      instructions: 'Before views.',
      model: 'gpt-5',
      provider,
    });
    const numbers = agent.withOutputType(number);
    const objects = agent.withOutputType(object);
    agent.instructions = 'Current opening instructions.';
    const pendingNumber = numbers.run('NUMBER');
    const pendingObject = objects.run('OBJECT');
    const failed = agent
      .withOutputType(denied)
      .run('DENIED')
      .catch((error) => error);
    try {
      await Promise.all([
        numberEntered.promise,
        objectEntered.promise,
        failedEntered.promise,
      ]);
      expect(agent.outputType).toBeUndefined();
      expect((await agent.run('PLAIN')).finalOutput).toBe('plain');
      releaseFailed.resolve();
      expect(await failed).toMatchObject({ message: 'Opening refused' });
      releaseObject.resolve();
      expect((await pendingObject).finalOutput).toEqual({ label: 'object' });
      releaseNumber.resolve();
      expect((await pendingNumber).finalOutput).toBe(7);
      expect(agent.outputType).toBeUndefined();
      expect(server.requests[0]).not.toHaveProperty('text.format');
      expect(server.requests[1].text).toMatchObject({
        format: { schema: { properties: { label: { type: 'string' } } } },
      });
      expect(server.requests[2].text).toMatchObject({
        format: { schema: { properties: { response: { type: 'number' } } } },
      });
      for (const request of server.requests)
        expect(JSON.stringify(request)).toContain(
          'Current opening instructions.',
        );
      server.assertExhausted();
    } finally {
      releaseNumber.resolve();
      releaseObject.resolve();
      releaseFailed.resolve();
      await Promise.allSettled([pendingNumber, pendingObject, failed]);
      await provider.close();
    }
  });

  it('restores the selected output contract and retains per-operation output choices', async () => {
    const server = new ModelServer([
      [message('{"response":4}')],
      [message('per-operation text')],
      [message('{"label":"queued"}')],
      [message('{"response":5}')],
    ]);
    const provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    });
    const view = agent.withOutputType(z.number());
    try {
      const first = await view.run('FIRST', { returnState: true });
      expect(first.finalOutput).toBe(4);
      const acquire = vi.spyOn(provider, '_acquire');
      await expect(agent.session({ state: first.state! })).rejects.toThrow(
        'matching current output contract',
      );
      expect(acquire).not.toHaveBeenCalled();
      const restored = await view.session({ state: first.state! });
      try {
        const plain = await restored.submit('PLAIN', {
          outputType: z.string(),
        });
        expect((await plain.wait()).finalOutput).toBe('per-operation text');
        const queued = await restored.enqueue('QUEUED', {
          outputType: z.object({ label: z.string() }),
        });
        expectTypeOf((await queued.wait()).finalOutput).toEqualTypeOf<{
          label: string;
        }>();
        expect((await queued.wait()).finalOutput).toEqual({ label: 'queued' });
        expect(
          (await (await restored.submit('DEFAULT')).wait()).finalOutput,
        ).toBe(5);
      } finally {
        await restored.close();
      }
      expect(agent.outputType).toBeUndefined();
      server.assertExhausted();
    } finally {
      await provider.close();
    }
  });

  it('captures prompted output choices while preserving required context and run validation', async () => {
    const schema = z.object({ answer: z.string() });
    const output = { mode: 'prompted' as const, schema, maxRetries: 0 };
    const server = new ModelServer([[message('{"answer":"selected"}')]]);
    const provider = await providerFor(server);
    const agent = new Agent<{ tenant: string }>({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    });
    const view = agent.withOutputType(output);
    output.maxRetries = 2;
    output.schema = z.object({ answer: z.string().min(100) });
    try {
      const acquire = vi.spyOn(provider, '_acquire');
      await expect(
        view.run('INVALID', {
          context: { tenant: 'one' },
          tools: [],
        } as Parameters<typeof view.run>[1]),
      ).rejects.toThrow('Run tool selection');
      expect(acquire).not.toHaveBeenCalled();
      const result = await view.run('PROMPTED', { context: { tenant: 'one' } });
      expectTypeOf(result.finalOutput).toEqualTypeOf<{ answer: string }>();
      expect(result.finalOutput).toEqual({ answer: 'selected' });
      expect(view.outputType).toMatchObject({
        mode: 'prompted',
        schema,
        maxRetries: 0,
      });
      expect(server.requests[0]).not.toHaveProperty('text.format');
      expect(JSON.stringify(server.requests[0])).toContain('Return only JSON');
      expectTypeOf(view.session).parameters.toEqualTypeOf<
        [
          options: SessionOptions<{ tenant: string }> & {
            context: { tenant: string };
          },
        ]
      >();
      expectTypeOf<keyof typeof view>().toEqualTypeOf<
        'outputType' | 'session' | 'run'
      >();
      server.assertExhausted();
    } finally {
      await provider.close();
    }
  });

  it('reopens deferred work through the original private-field hook with the captured declaration', async () => {
    const schema = z.object({ answer: z.string() });
    const output = { mode: 'prompted' as const, schema };
    const job = deferredTool({
      name: 'job',
      description: 'Read a result.',
      schemas: (builder) => ({
        parameters: builder.strictObject({}),
        result: builder.string(),
      }),
    });
    class DeferredAgent extends Agent {
      #calls = 0;
      readonly declarations: unknown[] = [];
      protected override supportsOutputVariants() {
        return true;
      }
      get calls() {
        return this.#calls;
      }
      override async session(options: SessionOptions = {}) {
        this.#calls++;
        this.declarations.push(this.outputTypeFor(options));
        return super.session({ ...options });
      }
    }
    const server = new ModelServer([
      [call('job', {}, { callId: 'job-call' })],
      [message('{"answer":"done"}')],
    ]);
    const provider = await providerFor(server);
    const agent = new DeferredAgent({
      instructions: 'Use job.',
      model: 'gpt-5',
      provider,
      tools: [job],
    });
    const jobs = new DeferredTools({
      tenant: 'tenant',
      runId: 'run',
      journal: {
        async prepare() {},
        async claim(binding) {
          return { binding, key: 'key', generation: '1', action: 'start' };
        },
        async authorize() {},
        async record() {},
        async saveResult() {},
      },
    });
    jobs.register(job, {
      providerId: 'fixture',
      provider: {
        async start() {
          return { status: 'completed', value: 'ready' };
        },
        async observe() {
          return { status: 'unknown' };
        },
        async reconcileCreation() {
          return { status: 'unknown' };
        },
      },
      project: (value) => z.string().parse(value),
    });
    const view = agent.withOutputType(output);
    const session = await view.session();
    try {
      const turn = await session.submit('ASK');
      const completion = turn.wait().catch((error) => error);
      const request = await nextAction(session);
      agent.outputType = z.string();
      output.schema = z.object({ answer: z.string().min(100) });
      const result = await jobs.start(
        session,
        request,
        {},
        async ({ outcome }) => {
          if (outcome.status !== 'continued')
            throw new Error('Expected continuation');
          return (await outcome.turn.wait()).finalOutput;
        },
      );
      await completion;
      expect(result).toEqual({ answer: 'done' });
      expect(agent.calls).toBe(2);
      expect(agent.declarations).toHaveLength(2);
      for (const declaration of agent.declarations) {
        expect(declaration).toBe(view.outputType);
        expect(declaration).toMatchObject({ mode: 'prompted', schema });
      }
      server.assertExhausted();
    } finally {
      await session.close();
      await provider.close();
    }
  });
});
