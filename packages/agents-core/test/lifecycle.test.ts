import { describe, it, expect, expectTypeOf, vi } from 'vitest';

import { AgentHooks, EventEmitterDelegate, RunHooks } from '../src/lifecycle';
import type { EventEmitter } from '@openai/agents-core/_shims';
import type { RunContext } from '../src/runContext';
import type { Agent } from '../src/agent';
import type { Tool } from '../src/tool';
import type * as protocol from '../src/types/protocol';

type TestEvents = {
  ping: [number];
};

class StubEventEmitter implements EventEmitter<TestEvents> {
  on = vi.fn(() => this);
  off = vi.fn(() => this);
  emit = vi.fn(() => true);
  once = vi.fn(() => this);
}

class StubDelegate extends EventEmitterDelegate<TestEvents> {
  protected eventEmitter = new StubEventEmitter();
}

describe('EventEmitterDelegate', () => {
  it('proxies to the underlying emitter implementation', () => {
    const delegate = new StubDelegate();
    const handler = vi.fn();
    const emitter = (delegate as any).eventEmitter as StubEventEmitter;

    const returnedOn = delegate.on('ping', handler);
    expect(emitter.on).toHaveBeenCalledWith('ping', handler);
    expect(returnedOn).toBe(emitter);

    const returnedOnce = delegate.once('ping', handler);
    expect(emitter.once).toHaveBeenCalledWith('ping', handler);
    expect(returnedOnce).toBe(emitter);

    const emitted = delegate.emit('ping', 123);
    expect(emitter.emit).toHaveBeenCalledWith('ping', 123);
    expect(emitted).toBe(true);

    const returnedOff = delegate.off('ping', handler);
    expect(emitter.off).toHaveBeenCalledWith('ping', handler);
    expect(returnedOff).toBe(emitter);
  });
});

describe('AgentHooks and RunHooks', () => {
  it('preserves protected Node emitter methods, chaining, and listener types', () => {
    type Context = { label: string };
    class AgentHookProbe extends AgentHooks<Context> {
      configure() {
        this.eventEmitter
          .once('agent_start', (context) => {
            expectTypeOf(context).toEqualTypeOf<RunContext<Context>>();
          })
          .setMaxListeners(12);
        return this.eventEmitter
          .on('agent_end', (_context, output) => {
            expectTypeOf(output).toEqualTypeOf<string>();
          })
          .getMaxListeners();
      }
    }
    class RunHookProbe extends RunHooks<Context> {
      configure() {
        this.eventEmitter
          .once('agent_start', (context) => {
            expectTypeOf(context).toEqualTypeOf<RunContext<Context>>();
          })
          .setMaxListeners(12);
        return this.eventEmitter
          .on('agent_end', (_context, _agent, output) => {
            expectTypeOf(output).toEqualTypeOf<string>();
          })
          .getMaxListeners();
      }
    }
    expect(new AgentHookProbe().configure()).toBe(12);
    expect(new RunHookProbe().configure()).toBe(12);
  });

  it('emit lifecycle events with typed payloads', () => {
    const agentHooks = new AgentHooks();
    const runHooks = new RunHooks();

    const context = { runId: 'ctx-1' } as unknown as RunContext<any>;
    const agent = { name: 'Agent' } as unknown as Agent<any, any>;
    const tool = { name: 'tool' } as unknown as Tool<any>;
    const toolCall = { id: 'call_1' } as protocol.ToolCallItem;

    const agentStart = vi.fn();
    const toolEnd = vi.fn();
    const runHandoff = vi.fn();

    agentHooks.on('agent_start', agentStart);
    agentHooks.on('agent_tool_end', toolEnd);
    runHooks.on('agent_handoff', runHandoff);

    agentHooks.emit('agent_start', context, agent);
    agentHooks.emit('agent_tool_end', context, tool, 'done', { toolCall });
    runHooks.emit('agent_handoff', context, agent, agent);

    expect(agentStart).toHaveBeenCalledWith(context, agent);
    expect(toolEnd).toHaveBeenCalledWith(context, tool, 'done', { toolCall });
    expect(runHandoff).toHaveBeenCalledWith(context, agent, agent);
  });
});

it('keeps run-tool observations assignable without erasing context or agent types', () => {
  type Context = { accountId: string };
  const hooks = new RunHooks<Context>();
  const context = { runId: 'ctx' } as unknown as RunContext<Context>;
  const agent = { name: 'Observer' } as Agent<Context>;
  const original = { name: 'observed' } as Tool<Context>;
  const toolCall = { id: 'call_observation' } as protocol.ToolCallItem;
  const seen: unknown[][] = [];
  hooks.on('agent_tool_start', (ctx, current, observed, details) => {
    expectTypeOf(ctx).toEqualTypeOf<RunContext<Context>>();
    expectTypeOf(current).toEqualTypeOf<Agent<Context>>();
    expectTypeOf(observed).toEqualTypeOf<Tool<any>>();
    const legacyObservation: Tool = observed;
    seen.push([ctx, current, legacyObservation, details]);
  });
  hooks.on('agent_tool_end', (ctx, current, observed, result, details) => {
    expectTypeOf(ctx).toEqualTypeOf<RunContext<Context>>();
    expectTypeOf(current).toEqualTypeOf<Agent<Context>>();
    expectTypeOf(observed).toEqualTypeOf<Tool<any>>();
    const legacyObservation: Tool = observed;
    seen.push([ctx, current, legacyObservation, result, details]);
  });
  const details = { toolCall };
  hooks.emit('agent_tool_start', context, agent, original, details);
  hooks.emit('agent_tool_end', context, agent, original, 'done', details);
  expect(seen).toEqual([
    [context, agent, original, details],
    [context, agent, original, 'done', details],
  ]);
  expect(seen[0]![2]).toBe(original);
  expect(seen[1]![2]).toBe(original);
});
