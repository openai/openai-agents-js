import { describe, it, expect, vi } from 'vitest';

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
