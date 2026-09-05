import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RealtimeSession } from '../src/realtimeSession';
import { RealtimeAgent } from '../src/realtimeAgent';
import { FakeTransport } from './stubs';
import { ToolTimeoutError, tool } from '@openai/agents-core';
import { z } from 'zod';
import logger from '../src/logger';
import { waitForEvent } from './realtimeSessionTestUtils';

describe('RealtimeSession', () => {
  let transport: FakeTransport;
  let session: RealtimeSession;

  beforeEach(async () => {
    transport = new FakeTransport();
    const agent = new RealtimeAgent({ name: 'A', handoffs: [] });
    session = new RealtimeSession(agent, { transport });
    await session.connect({ apiKey: 'test' });
  });

  it('returns a timeout message when a function tool exceeds timeoutMs', async () => {
    vi.useFakeTimers();
    const localTransport = new FakeTransport();
    const timedTool = tool({
      name: 'timed_tool',
      description: 'timed tool',
      parameters: z.object({}),
      timeoutMs: 5,
      execute: async () => new Promise(() => {}),
    });
    try {
      const agent = new RealtimeAgent({
        name: 'A',
        handoffs: [],
        tools: [timedTool],
      });
      const localSession = new RealtimeSession(agent, {
        transport: localTransport,
      });
      await localSession.connect({ apiKey: 'test' });

      const outputPromise = localTransport.waitForNextFunctionCallOutput();
      localTransport.emit('function_call', {
        type: 'function_call',
        name: 'timed_tool',
        callId: 'c-timeout',
        status: 'completed',
        arguments: '{}',
        responseId: 'timeout-response',
      } as any);

      await vi.advanceTimersByTimeAsync(5);
      const [, output, startResponse] = await outputPromise;
      expect(output).toBe("Tool 'timed_tool' timed out after 5ms.");
      expect(startResponse).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits an error when timeoutBehavior is raise_exception', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const localTransport = new FakeTransport();
    const timedTool = tool({
      name: 'timed_tool',
      description: 'timed tool',
      parameters: z.object({}),
      timeoutMs: 5,
      timeoutBehavior: 'raise_exception',
      execute: async () => new Promise(() => {}),
    });
    try {
      const agent = new RealtimeAgent({
        name: 'A',
        handoffs: [],
        tools: [timedTool],
      });
      const localSession = new RealtimeSession(agent, {
        transport: localTransport,
      });
      await localSession.connect({ apiKey: 'test' });

      const errorEvent = waitForEvent<any[]>(localSession, 'error');
      localTransport.emit('function_call', {
        type: 'function_call',
        name: 'timed_tool',
        callId: 'c-timeout-raise',
        status: 'completed',
        arguments: '{}',
        responseId: 'timeout-raise-response',
      } as any);

      await vi.advanceTimersByTimeAsync(5);
      const [error] = await errorEvent;
      expect(error.error).toBeInstanceOf(ToolTimeoutError);
      expect(localTransport.sendFunctionCallOutputCalls.length).toBe(0);
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
