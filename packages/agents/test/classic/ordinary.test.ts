import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, MemorySession, Runner, tool } from '../../src/classic';
import {
  assistantMessage,
  functionCall,
  modelResponse,
  ScriptedModel,
} from '../../src/classic/testing';

describe('explicit classic API', () => {
  it('runs a custom Model and tool, persists complete history, and streams the next turn', async () => {
    let effects = 0;
    const model = new ScriptedModel([
      modelResponse([
        functionCall('echo', { value: 'hello' }, { callId: 'call-1' }),
      ]),
      modelResponse([assistantMessage('hello')]),
      modelResponse([assistantMessage('continued')]),
    ]);
    const echo = tool({
      name: 'echo',
      description: 'Echo a value.',
      parameters: z.object({ value: z.string() }),
      execute: ({ value }) => {
        effects += 1;
        return value;
      },
    });
    const agent = new Agent({ name: 'classic', model, tools: [echo] });
    const runner = new Runner({ tracingDisabled: true });
    const session = new MemorySession({ sessionId: 'classic-history' });
    const completed = await runner.run(agent, 'first', { session });
    expect(completed.finalOutput).toBe('hello');
    expect(completed.lastAgent).toBe(agent);
    expect(effects).toBe(1);
    const stored = await session.getItems();
    expect(stored.map((item) => item.type)).toEqual([
      'message',
      'function_call',
      'function_call_result',
      'message',
    ]);
    const streamed = await runner.run(agent, 'second', {
      session,
      stream: true,
    });
    const events = [];
    for await (const event of streamed) events.push(event);
    await streamed.completed;
    expect(streamed.finalOutput).toBe('continued');
    expect(
      events.some((event) => event.type === 'raw_model_stream_event'),
    ).toBe(true);
    expect(model.calls).toHaveLength(3);
    expect(model.calls[2].streamed).toBe(true);
    expect(model.calls[2].request.input).toHaveLength(stored.length + 1);
    expect(effects).toBe(1);
  });
});
