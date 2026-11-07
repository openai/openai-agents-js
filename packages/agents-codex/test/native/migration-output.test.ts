import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Runner,
  RunHooks,
  Usage,
  OutputGuardrailTripwireTriggered,
  setTracingDisabled,
  tool,
} from '@openai/agents/classic';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponder,
  modelResponse,
} from '@openai/agents/classic/testing';
import { SDKRunner, type MigrationRunResult } from '@openai/agents/migration';

setTracingDisabled(true);

describe('structured migration output on the native loop', () => {
  it('preserves the classic object schema through a selected native function round trip', async () => {
    const schema = z.object({ title: z.string(), count: z.number() });
    const value = { title: 'Native report', count: 7 };
    const execute = vi.fn(() => 'native-function-reply');
    const reply = {
      responseId: 'structured-final',
      requestId: 'request-structured-final',
      output: [
        assistantMessage(JSON.stringify(value), { id: 'structured-message' }),
      ],
      usage: new Usage({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
    };
    const selected = new ScriptedModel([
      modelResponse({
        responseId: 'structured-tool',
        requestId: 'request-structured-tool',
        output: [
          functionCall('read_count', '{}', { callId: 'structured-call' }),
        ],
        usage: new Usage({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
      }),
      modelResponder((call) => {
        expect(call.request.input).toContainEqual(
          expect.objectContaining({
            type: 'function_call_result',
            callId: 'structured-call',
            name: 'read_count',
            output: 'native-function-reply',
          }),
        );
        return reply;
      }),
    ]);
    const fallback = new ScriptedModel([]);
    const provider = { getModel: vi.fn(() => selected) };
    const agent = Agent.create({
      name: 'Structured native function',
      instructions: 'Use read_count and return the declared report.',
      model: 'selected-structured',
      modelSettings: {},
      outputType: schema,
      tools: [
        tool({
          name: 'read_count',
          description: 'Read the synthetic count.',
          parameters: z.object({}),
          execute,
        }),
      ],
    });

    const result = await SDKRunner.run(agent, 'Report.', {
      context: undefined,
      modelProvider: provider,
      model: fallback,
    });
    expectTypeOf(result.finalOutput).toEqualTypeOf<z.infer<typeof schema>>();
    expectTypeOf(result.finalOutput.title).toEqualTypeOf<string>();
    expectTypeOf(result.finalOutput.count).toEqualTypeOf<number>();
    expectTypeOf<MigrationRunResult['finalOutput']>().toEqualTypeOf<string>();
    const _textRun = SDKRunner.run<unknown>;
    expectTypeOf<
      Awaited<ReturnType<typeof _textRun>>['finalOutput']
    >().toEqualTypeOf<string>();
    expect(result.finalOutput).toEqual(value);
    expect(provider.getModel).toHaveBeenCalledExactlyOnceWith(
      'selected-structured',
    );
    expect(fallback.calls).toHaveLength(0);
    expect(selected.calls).toHaveLength(2);
    expect(execute).toHaveBeenCalledOnce();
    expect(result.native.sessionId).toEqual(expect.any(String));
    expect(result.native.turnId).toEqual(expect.any(String));
    expect(
      result.modelResponses.map((response) => response.responseId),
    ).toEqual(['structured-tool', 'structured-final']);
    expect(result.modelResponses.map((response) => response.requestId)).toEqual(
      ['request-structured-tool', 'request-structured-final'],
    );
    expect(result.newItems.map((item) => item.type)).toEqual([
      'tool_call_item',
      'tool_call_output_item',
      'message_output_item',
    ]);
    expect(result.newItems[1]).toMatchObject({
      output: 'native-function-reply',
      rawItem: { callId: 'structured-call', output: 'native-function-reply' },
    });
    expect(selected.calls[0]!.request.outputType).toMatchObject({
      type: 'json_schema',
      name: 'output',
      strict: true,
      schema: {
        type: 'object',
        properties: { title: { type: 'string' }, count: { type: 'number' } },
        required: ['title', 'count'],
        additionalProperties: false,
      },
    });
    expect(selected.calls[1]!.request.outputType).toEqual(
      selected.calls[0]!.request.outputType,
    );
    selected.assertComplete();

    const classicModel = new ScriptedModel([modelResponse(reply)]);
    const classic = await new Runner({ tracingDisabled: true }).run(
      agent.clone({ model: classicModel }),
      'Report.',
    );
    expect(classic.finalOutput).toEqual(result.finalOutput);
    expect(classicModel.calls).toHaveLength(1);
    expect(classicModel.calls[0]!.request.outputType).toEqual(
      selected.calls[0]!.request.outputType,
    );
    classicModel.assertComplete();
  }, 30_000);

  it('parses one checked object for guards, both end hooks and repeated completed-facade reads', async () => {
    let parses = 0;
    const schema = z
      .object({ title: z.string(), count: z.number() })
      .superRefine(() => {
        ++parses;
      });
    const value = { title: 'Checked once', count: 3 };
    const seen: unknown[] = [];
    const order: string[] = [];
    const model = new ScriptedModel([
      modelResponse({
        responseId: 'checked-response',
        output: [assistantMessage(JSON.stringify(value))],
        usage: new Usage(),
      }),
    ]);
    const guard = {
      name: 'checked structured output',
      execute: async ({
        agentOutput,
      }: {
        agentOutput: z.infer<typeof schema>;
      }) => {
        expectTypeOf(agentOutput.count).toEqualTypeOf<number>();
        seen.push(agentOutput);
        order.push('guard');
        expect(parses).toBe(1);
        return { tripwireTriggered: false, outputInfo: 'accepted' };
      },
    };
    const agent = Agent.create({
      name: 'Checked output',
      instructions: 'Return the report.',
      model,
      modelSettings: {},
      outputType: schema,
      outputGuardrails: [guard],
    });
    const hooks = new RunHooks<unknown, typeof schema>();
    hooks.on('agent_end', (_context, _agent, output) => {
      seen.push(output);
      order.push('runner end');
    });
    agent.on('agent_end', (_context, output) => {
      seen.push(output);
      order.push('agent end');
    });

    const result = await SDKRunner.run(agent, 'Report.', {
      context: undefined,
      hooks,
    });
    expectTypeOf(result.finalOutput).toEqualTypeOf<z.infer<typeof schema>>();
    expect(result.finalOutput).toEqual(value);
    expect(order).toEqual(['guard', 'runner end', 'agent end']);
    expect(seen).toHaveLength(3);
    expect(seen.every((output) => output === result.finalOutput)).toBe(true);
    expect(result.outputGuardrailResults[0]?.agentOutput).toBe(
      result.finalOutput,
    );
    expect(result.lastAgent).toBe(agent);
    expectTypeOf(result.lastAgent).toEqualTypeOf<typeof agent>();
    await result.completed;
    expect(result.history).toEqual(result.toInputList());
    expect(result.history).toEqual(result.history);
    expect(result.output).toEqual(result.newItems.map((item) => item.rawItem));
    expect(result.rawResponses[0]).toBe(result.modelResponses[0]);
    const events = await Array.fromAsync(result.replayEvents());
    expect(
      events.map((event) =>
        event.type === 'run_item_stream_event' ? event.name : event.type,
      ),
    ).toEqual(['message_output_created']);
    expect(await Array.fromAsync(result.replayEvents())).toEqual(events);
    expect(result.finalOutput).toBe(seen[0]);
    expect(parses).toBe(1);
    expect(model.calls).toHaveLength(1);
    model.assertComplete();
  }, 30_000);

  it.each([
    ['invalid JSON', '{not JSON'],
    ['schema-invalid JSON', '{"title":"Rejected","count":"not a number"}'],
  ])(
    'withholds result and end publication for %s',
    async (_kind, text) => {
      const schema = z.object({ title: z.string(), count: z.number() });
      const model = new ScriptedModel([
        modelResponse({
          responseId: 'rejected-output',
          output: [assistantMessage(text)],
          usage: new Usage(),
        }),
      ]);
      const guard = vi.fn(async () => ({
        tripwireTriggered: false,
        outputInfo: 'must not run',
      }));
      const agent = Agent.create({
        name: 'Invalid output',
        instructions: 'Return the report.',
        model,
        modelSettings: {},
        outputType: schema,
        outputGuardrails: [{ name: 'after validation', execute: guard }],
      });
      const hooks = new RunHooks<unknown, typeof schema>();
      const agentEnd = vi.fn();
      const runnerEnd = vi.fn();
      agent.on('agent_end', agentEnd);
      hooks.on('agent_end', runnerEnd);
      let published = false;
      const running = SDKRunner.run(agent, 'Report.', {
        context: undefined,
        hooks,
      }).then((result) => {
        published = true;
        return result;
      });
      await expect(running).rejects.toThrow(
        'Final output did not match the requested output type',
      );
      expect(published).toBe(false);
      expect(guard).not.toHaveBeenCalled();
      expect(agentEnd).not.toHaveBeenCalled();
      expect(runnerEnd).not.toHaveBeenCalled();
      expect(model.calls).toHaveLength(1);
      model.assertComplete();
    },
    30_000,
  );

  it('withholds the completed facade and both end hooks when a structured output guard trips', async () => {
    const schema = z.object({ title: z.string(), count: z.number() });
    const value = { title: 'Guarded', count: 2 };
    const model = new ScriptedModel([
      modelResponse({
        responseId: 'guarded-output',
        output: [assistantMessage(JSON.stringify(value))],
        usage: new Usage(),
      }),
    ]);
    const agent = Agent.create({
      name: 'Guarded output',
      instructions: 'Return the report.',
      model,
      modelSettings: {},
      outputType: schema,
    });
    const hooks = new RunHooks<unknown, typeof schema>();
    const agentEnd = vi.fn();
    const runnerEnd = vi.fn();
    agent.on('agent_end', agentEnd);
    hooks.on('agent_end', runnerEnd);
    const guard = vi.fn(async ({ agentOutput }: { agentOutput: unknown }) => {
      expect(agentOutput).toEqual(value);
      return { tripwireTriggered: true, outputInfo: 'rejected report' };
    });
    let published = false;
    const running = SDKRunner.run(agent, 'Report.', {
      context: undefined,
      hooks,
      outputGuardrails: [{ name: 'reject report', execute: guard }],
    }).then((result) => {
      published = true;
      return result;
    });
    await expect(running).rejects.toBeInstanceOf(
      OutputGuardrailTripwireTriggered,
    );
    expect(guard).toHaveBeenCalledOnce();
    expect(published).toBe(false);
    expect(agentEnd).not.toHaveBeenCalled();
    expect(runnerEnd).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(1);
    model.assertComplete();
  }, 30_000);

  it('refuses an unrepresentable object schema before provider, Model or tool effects', async () => {
    const schema = z.object({ when: z.date() });
    const model = new ScriptedModel([]);
    const resolveModel = vi.fn(() => model);
    const execute = vi.fn(() => 'must not execute');
    const agent = Agent.create({
      name: 'Unsupported output',
      instructions: 'Return the declared object.',
      model: 'selected-unsupported-output',
      modelSettings: {},
      outputType: schema,
      tools: [
        tool({
          name: 'must_not_execute',
          description: 'Must remain untouched.',
          parameters: z.object({}),
          execute,
        }),
      ],
    });
    const started = vi.fn();
    agent.on('agent_start', started);
    await expect(
      SDKRunner.run(agent, 'Report.', {
        context: undefined,
        modelProvider: { getModel: resolveModel },
      }),
    ).rejects.toThrow();
    expect(resolveModel).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
  }, 30_000);
});
