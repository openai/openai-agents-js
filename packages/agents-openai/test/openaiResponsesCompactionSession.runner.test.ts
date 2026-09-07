import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  MemorySession,
  Runner,
  RunContext,
  RunState,
  tool,
  type AgentInputItem,
  type NonStreamRunOptions,
} from '@openai/agents-core';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
} from '@openai/agents-core/testing';
import { OpenAIResponsesCompactionSession } from '../src';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function user(text: string): AgentInputItem {
  return {
    type: 'message',
    role: 'user',
    content: text,
  };
}

function setup(underlyingSession = new MemorySession()) {
  const compacted = assistantMessage('compacted history');
  const compact = vi.fn().mockResolvedValue({
    output: [compacted],
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
  });
  const decision = vi.fn(() => true);
  const session = new OpenAIResponsesCompactionSession({
    underlyingSession,
    client: { responses: { compact } } as any,
    shouldTriggerCompaction: decision,
  });
  const runner = new Runner({ tracingDisabled: true });
  return { session, runner, compact, compacted, decision };
}

function startRun(
  runner: Runner,
  agent: Agent,
  stream: boolean,
  options: NonStreamRunOptions<unknown, Agent>,
) {
  return stream
    ? runner.run<Agent, unknown>(agent, 'hello', { ...options, stream: true })
    : runner.run<Agent, unknown>(agent, 'hello', options);
}

describe('Runner compaction ownership', () => {
  it('reconciles an acknowledged-lost append without regaining compaction ownership', async () => {
    class UnacknowledgedSession extends MemorySession {
      failNextAppend = false;
      override async addItems(items: AgentInputItem[]) {
        await super.addItems(items);
        if (this.failNextAppend) {
          this.failNextAppend = false;
          throw new Error('append acknowledgement lost');
        }
      }
    }
    const underlying = new UnacknowledgedSession();
    const { session, runner, compact, decision } = setup(underlying);
    decision.mockReturnValue(false);
    const execute = vi.fn(async () => 'tool done');
    const agent = new Agent({
      name: 'approval recovery',
      model: new ScriptedModel([
        [functionCall('approved', '{}', { callId: 'call-1' })],
      ]),
      tools: [
        tool({
          name: 'approved',
          description: 'Approved action.',
          parameters: z.object({}),
          needsApproval: true,
          execute,
        }),
      ],
      toolUseBehavior: 'stop_on_first_tool',
    });
    const paused = await runner.run(agent, 'hello', { session });
    paused.state.approve(paused.interruptions[0]);
    underlying.failNextAppend = true;
    decision.mockReturnValue(true);
    await expect(runner.run(agent, paused.state, { session })).rejects.toThrow(
      'append acknowledgement lost',
    );
    const committed = await session.getItems();
    const result = await runner.run(agent, paused.state, { session });
    expect(result.finalOutput).toBe('tool done');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await session.getItems()).toEqual(committed);
    expect(compact).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'skips a stale history read (stream=%s)',
    async (stream) => {
      const { session, runner, compact, decision } = setup();
      const read = deferred();
      const proceed = deferred();
      const reply = assistantMessage('done');
      const agent = new Agent({
        name: 'test',
        model: new ScriptedModel([[reply]]),
      });
      const running = startRun(runner, agent, stream, {
        session,
        sessionInputCallback: async (history, input) => {
          read.resolve();
          await proceed.promise;
          return [...history, ...input];
        },
      });
      await read.promise;
      const foreign = user('concurrent write');
      await session.addItems([foreign]);
      proceed.resolve();
      const result = await running;
      if ('completed' in result) await result.completed;
      expect(result.finalOutput).toBe('done');
      expect(await session.getItems()).toEqual([foreign, user('hello'), reply]);
      expect(decision).not.toHaveBeenCalled();
      expect(compact).not.toHaveBeenCalled();
      expect(
        (result.runContext.usage.requestUsageEntries ?? []).filter(
          (entry) => entry.endpoint === 'responses.compact',
        ),
      ).toEqual([]);
    },
  );

  it.each([false, true])(
    'skips compaction after a queued append (stream=%s)',
    async (stream) => {
      // Gate the real backend acknowledgement while the wrapper owns its mutation queue.
      class GatedSession extends MemorySession {
        readonly appended = deferred();
        readonly proceed = deferred();
        private gated = false;
        override async addItems(items: AgentInputItem[]) {
          await super.addItems(items);
          if (!this.gated) {
            this.gated = true;
            this.appended.resolve();
            await this.proceed.promise;
          }
        }
      }
      const underlying = new GatedSession();
      const { session, runner, compact } = setup(underlying);
      const reply = assistantMessage('done');
      const running = startRun(
        runner,
        new Agent({ name: 'test', model: new ScriptedModel([[reply]]) }),
        stream,
        { session },
      );
      await underlying.appended.promise;
      const foreign = user('concurrent write');
      const mutation = session.addItems([foreign]);
      underlying.proceed.resolve();
      await mutation;
      const result = await running;
      if ('completed' in result) await result.completed;
      expect(result.finalOutput).toBe('done');
      const items = await session.getItems();
      expect(
        items.filter((item) => item.type === 'message' && item.role === 'user'),
      ).toEqual([user('hello'), foreign]);
      expect(
        items.filter(
          (item) => item.type === 'message' && item.role === 'assistant',
        ),
      ).toEqual([reply]);
      expect(items).toHaveLength(3);
      expect(compact).not.toHaveBeenCalled();
    },
  );

  it.each(['pop', 'clear'] as const)(
    'revokes a read after %s',
    async (mutation) => {
      const original = user('original');
      const { session, runner, compact } = setup(
        new MemorySession({ initialItems: [original] }),
      );
      const reply = assistantMessage('done');
      const result = await startRun(
        runner,
        new Agent({ name: 'test', model: new ScriptedModel([[reply]]) }),
        false,
        {
          session,
          sessionInputCallback: async (history, input) => {
            if (mutation === 'pop') await session.popItem();
            else await session.clearSession();
            return [...history, ...input];
          },
        },
      );
      expect(result.finalOutput).toBe('done');
      expect(await session.getItems()).toEqual([user('hello'), reply]);
      expect(compact).not.toHaveBeenCalled();
    },
  );

  it('isolates concurrent runs sharing a caller RunContext and preserves manual compaction', async () => {
    const { session, runner, compact, compacted } = setup();
    const context = new RunContext({ shared: true });
    const read = deferred();
    const proceed = deferred();
    const firstReply = assistantMessage('first reply');
    const first = runner.run(
      new Agent({ name: 'first', model: new ScriptedModel([[firstReply]]) }),
      'first',
      {
        session,
        context,
        sessionInputCallback: async (history, input) => {
          read.resolve();
          await proceed.promise;
          return [...history, ...input];
        },
      },
    );
    await read.promise;
    await runner.run(
      new Agent({
        name: 'second',
        model: new ScriptedModel([[assistantMessage('second reply')]]),
      }),
      'second',
      { session, context },
    );
    expect(compact).toHaveBeenCalledTimes(1);
    proceed.resolve();
    await first;
    expect(compact).toHaveBeenCalledTimes(1);
    expect(await session.getItems()).toEqual([
      compacted,
      user('first'),
      firstReply,
    ]);
    await session.runCompaction({ force: true, compactionMode: 'input' });
    expect(compact).toHaveBeenCalledTimes(2);
    expect(compact.mock.calls[1][0].input).toHaveLength(3);
  });

  it.each([false, true])(
    'compacts an uncontended run and accounts usage once (stream=%s)',
    async (stream) => {
      const { session, runner, compact, compacted } = setup();
      const result = await startRun(
        runner,
        new Agent({
          name: 'test',
          model: new ScriptedModel([[assistantMessage('done')]]),
        }),
        stream,
        { session },
      );
      if ('completed' in result) await result.completed;
      expect(result.finalOutput).toBe('done');
      expect(compact).toHaveBeenCalledTimes(1);
      expect(await session.getItems()).toEqual([compacted]);
      expect(
        (result.runContext.usage.requestUsageEntries ?? []).filter(
          (entry) => entry.endpoint === 'responses.compact',
        ),
      ).toHaveLength(1);
      expect(result.runContext.usage.totalTokens).toBe(10);
    },
  );

  it.each([false, true])(
    'settles pending compaction without replaying tools (serialized=%s)',
    async (serialized) => {
      const { session, runner, compact, decision } = setup();
      decision.mockReturnValue(false);
      const execute = vi.fn(async () => 'tool done');
      const agent = new Agent({
        name: 'approval',
        model: new ScriptedModel([
          [functionCall('approved', '{}', { callId: 'call-1' })],
        ]),
        tools: [
          tool({
            name: 'approved',
            description: 'Approved action.',
            parameters: z.object({}),
            needsApproval: true,
            execute,
          }),
        ],
        toolUseBehavior: 'stop_on_first_tool',
      });
      const paused = await runner.run<typeof agent, unknown>(agent, 'hello', {
        session,
      });
      paused.state.approve(paused.interruptions[0]);
      decision.mockReturnValue(true);
      compact.mockRejectedValueOnce(new Error('compact unavailable'));
      await expect(
        runner.run(agent, paused.state, { session }),
      ).rejects.toThrow('compact unavailable');
      expect(execute).toHaveBeenCalledTimes(1);
      const before = await session.getItems();
      const state = serialized
        ? await RunState.fromString(agent, paused.state.toString())
        : paused.state;
      const result = await runner.run(agent, state, { session });
      expect(result.finalOutput).toBe('tool done');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(compact).toHaveBeenCalledTimes(serialized ? 1 : 2);
      if (serialized) expect(await session.getItems()).toEqual(before);
    },
  );
});
