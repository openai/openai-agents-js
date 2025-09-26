import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';
import {
  Agent,
  MaxTurnsExceededError,
  ModelResponse,
  OutputGuardrailTripwireTriggered,
  run,
  Runner,
  setDefaultModelProvider,
  setTraceProcessors,
  setTracingDisabled,
  BatchTraceProcessor,
} from '../src';
import { RunStreamEvent } from '../src/events';
import { handoff } from '../src/handoff';
import {
  RunMessageOutputItem as MessageOutputItem,
  RunToolApprovalItem as ToolApprovalItem,
} from '../src/items';
import { getTurnInput, selectModel } from '../src/run';
import { RunContext } from '../src/runContext';
import { RunState } from '../src/runState';
import * as protocol from '../src/types/protocol';
import { Usage } from '../src/usage';
import {
  FakeModel,
  fakeModelMessage,
  FakeModelProvider,
  FakeTracingExporter,
  TEST_MODEL_MESSAGE,
  TEST_MODEL_RESPONSE_BASIC,
  TEST_TOOL,
} from './stubs';
import { Model, ModelProvider, ModelRequest } from '../src/model';

describe('Runner.run', () => {
  beforeAll(() => {
    setTracingDisabled(true);
    setDefaultModelProvider(new FakeModelProvider());
  });

  describe('basic', () => {
    it('should run a basic agent', async () => {
      const agent = new Agent({
        name: 'Test',
      });

      const result = await run(agent, 'Hello');

      expect(result.finalOutput).toBe('Hello World');
      expectTypeOf(result.finalOutput).toEqualTypeOf<string | undefined>();
    });

    it('sholuld handle structured output', async () => {
      const fakeModel = new FakeModel([
        {
          ...TEST_MODEL_RESPONSE_BASIC,
          output: [fakeModelMessage('{"city": "San Francisco"}')],
        },
      ]);

      const runner = new Runner();
      const agent = new Agent({
        name: 'Test',
        model: fakeModel,
        outputType: z.object({
          city: z.string(),
        }),
      });

      const result = await runner.run(
        agent,
        'What is the weather in San Francisco?',
      );

      expect(result.finalOutput).toEqual({ city: 'San Francisco' });
      expectTypeOf(result.finalOutput).toEqualTypeOf<
        { city: string } | undefined
      >();
    });

    it('returns static final output when tool execution is rejected', async () => {
      const agent = new Agent({
        name: 'RejectTest',
        toolUseBehavior: 'stop_on_first_tool',
      });

      const rawItem = {
        name: 'toolZ',
        callId: 'c1',
        type: 'function_call',
        arguments: '{}',
      } as any;
      const approvalItem = new ToolApprovalItem(rawItem, agent);
      const state = new RunState(new RunContext(), '', agent, 1);
      state._currentStep = {
        type: 'next_step_interruption',
        data: { interruptions: [approvalItem] },
      };
      state.reject(approvalItem);

      state._generatedItems.push(approvalItem);

      state._lastTurnResponse = {
        output: [],
        usage: {
          requests: 1,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        responseId: 'abc',
      } as any;

      state._lastProcessedResponse = {
        newItems: [],
        functions: [
          {
            toolCall: rawItem,
            tool: {
              name: 'toolZ',
              invoke: async () => 'wrong path',
              needsApproval: async () => true,
            },
          },
        ],
        handoffs: [],
        mcpApprovalRequests: [],
        computerActions: [],
      } as any;

      const result = await run(agent, state);

      expect(result.finalOutput).toBe('Tool execution was not approved.');
    });

    it('propagates model errors', async () => {
      const agent = new Agent({ name: 'Fail', model: new FakeModel() });

      await expect(run(agent, 'fail')).rejects.toThrow('No response found');
    });

    it('emits agent_end lifecycle event for non-streaming agents', async () => {
      const agent = new Agent({
        name: 'TestAgent',
      });

      // Track agent_end events on both the agent and runner
      const agentEndEvents: Array<{ context: any; output: string }> = [];
      const runnerEndEvents: Array<{
        context: any;
        agent: any;
        output: string;
      }> = [];

      agent.on('agent_end', (context, output) => {
        agentEndEvents.push({ context, output });
      });

      const runner = new Runner();
      runner.on('agent_end', (context, agent, output) => {
        runnerEndEvents.push({ context, agent, output });
      });

      const result = await runner.run(agent, 'test input');

      // Verify the result has the expected output
      expect(result.finalOutput).toBe('Hello World');

      // Verify agent_end was called on both agent and runner
      expect(agentEndEvents).toHaveLength(1);
      expect(agentEndEvents[0].output).toBe('Hello World');

      expect(runnerEndEvents).toHaveLength(1);
      expect(runnerEndEvents[0].agent).toBe(agent);
      expect(runnerEndEvents[0].output).toBe('Hello World');
    });
  });

  describe('additional scenarios', () => {
    class StreamingModel extends FakeModel {
      constructor(resp: protocol.AssistantMessageItem) {
        super([{ output: [resp], usage: new Usage() }]);
        this._resp = resp;
      }
      private _resp: protocol.AssistantMessageItem;
      override async *getStreamedResponse(): AsyncIterable<protocol.StreamEvent> {
        yield {
          type: 'output_text_delta',
          delta: 'hi',
          providerData: {},
        } as any;
        yield {
          type: 'response_done',
          response: {
            id: 'r1',
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            output: [this._resp],
          },
        } as any;
      }
    }

    it('resumes from serialized RunState', async () => {
      const agent = new Agent({
        name: 'Resume',
        model: new FakeModel([
          { output: [fakeModelMessage('hi')], usage: new Usage() },
        ]),
      });
      const first = await run(agent, 'hi');
      const json = first.state.toJSON();
      delete (json as any).currentAgentSpan;
      const restored = await RunState.fromString(agent, JSON.stringify(json));
      const resumed = await run(agent, restored);
      expect(resumed.finalOutput).toBe(first.finalOutput);
    });

    it('input guardrail executes only once', async () => {
      const firstResponse: ModelResponse = {
        output: [
          {
            id: 'f1',
            type: 'function_call',
            name: 'test',
            callId: 'c1',
            status: 'completed',
            arguments: '{}',
          },
        ],
        usage: new Usage(),
      };
      const secondResponse: ModelResponse = {
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      };
      const guardrailFn = vi.fn(async () => ({
        tripwireTriggered: false,
        outputInfo: {},
      }));
      const runner = new Runner({
        inputGuardrails: [{ name: 'ig', execute: guardrailFn }],
      });
      const agent = new Agent({
        name: 'Guard',
        model: new FakeModel([firstResponse, secondResponse]),
        tools: [TEST_TOOL],
      });
      const result = await runner.run(agent, 'start');
      expect(result.finalOutput).toBe('done');
      expect(guardrailFn).toHaveBeenCalledTimes(1);
    });

    it('output guardrail success', async () => {
      const guardrailFn = vi.fn(async () => ({
        tripwireTriggered: false,
        outputInfo: {},
      }));
      const runner = new Runner({
        outputGuardrails: [{ name: 'og', execute: guardrailFn }],
      });
      const agent = new Agent({
        name: 'Out',
        model: new FakeModel([
          { output: [fakeModelMessage('hi')], usage: new Usage() },
        ]),
      });
      const result = await runner.run(agent, 'input');
      expect(result.finalOutput).toBe('hi');
      expect(guardrailFn).toHaveBeenCalledTimes(1);
    });

    it('output guardrail tripwire throws', async () => {
      const guardrailFn = vi.fn(async () => ({
        tripwireTriggered: true,
        outputInfo: { bad: true },
      }));
      const runner = new Runner({
        outputGuardrails: [{ name: 'og', execute: guardrailFn }],
      });
      const agent = new Agent({
        name: 'Out',
        model: new FakeModel([
          { output: [fakeModelMessage('x')], usage: new Usage() },
        ]),
      });
      await expect(runner.run(agent, 'input')).rejects.toBeInstanceOf(
        OutputGuardrailTripwireTriggered,
      );
    });

    it('executes tool calls and records output', async () => {
      const first: ModelResponse = {
        output: [
          {
            id: 't1',
            type: 'function_call',
            name: 'test',
            callId: 'c1',
            status: 'completed',
            arguments: '{}',
          },
        ],
        usage: new Usage(),
      };
      const second: ModelResponse = {
        output: [fakeModelMessage('final')],
        usage: new Usage(),
      };
      const agent = new Agent({
        name: 'Tool',
        model: new FakeModel([first, second]),
        tools: [TEST_TOOL],
      });
      const result = await run(agent, 'do');
      const types = result.newItems.map((i) => i.type);
      expect(types).toContain('tool_call_item');
      expect(types).toContain('tool_call_output_item');
      expect(result.rawResponses.length).toBeGreaterThanOrEqual(2);
      expect(result.finalOutput).toBe('final');
    });

    it('switches agents via handoff', async () => {
      const agentB = new Agent({
        name: 'B',
        model: new FakeModel([
          { output: [fakeModelMessage('done B')], usage: new Usage() },
        ]),
      });
      const callItem: protocol.FunctionCallItem = {
        id: 'h1',
        type: 'function_call',
        name: handoff(agentB).toolName,
        callId: 'c1',
        status: 'completed',
        arguments: '{}',
      };
      const agentA = new Agent({
        name: 'A',
        model: new FakeModel([{ output: [callItem], usage: new Usage() }]),
        handoffs: [handoff(agentB)],
      });
      const runner = new Runner();
      const result = await runner.run(agentA, 'hi');
      expect(result.finalOutput).toBe('done B');
      expect(result.state._currentAgent).toBe(agentB);
    });

    it('streamed run produces same final output', async () => {
      const msg = fakeModelMessage('stream');
      const agent1 = new Agent({ name: 'S1', model: new StreamingModel(msg) });
      const agent2 = new Agent({ name: 'S2', model: new StreamingModel(msg) });
      const streamRes = await run(agent1, 'hi', { stream: true });
      const events: RunStreamEvent[] = [];
      for await (const e of streamRes.toStream()) {
        events.push(e);
      }
      await streamRes.completed;
      const normalRes = await run(agent2, 'hi');
      expect(streamRes.finalOutput).toBe(normalRes.finalOutput);
      expect(streamRes.finalOutput).toBe('stream');
      expect(events.length).toBeGreaterThan(0);
    });

    it('records one model response per turn', async () => {
      const first: ModelResponse = {
        output: [
          {
            id: 'rc1',
            type: 'function_call',
            name: 'test',
            callId: 'c1',
            status: 'completed',
            arguments: '{}',
          },
        ],
        usage: new Usage(),
      };
      const second: ModelResponse = {
        output: [fakeModelMessage('end')],
        usage: new Usage(),
      };
      const agent = new Agent({
        name: 'Record',
        model: new FakeModel([first, second]),
        tools: [TEST_TOOL],
      });
      const result = await run(agent, 'go');
      expect(result.state._modelResponses).toHaveLength(2);
      expect(result.state._modelResponses[0]).toBe(first);
      expect(result.state._modelResponses[1]).toBe(second);
    });

    it('records one model response per turn for streaming runs', async () => {
      const first: ModelResponse = {
        output: [
          {
            id: 'sc1',
            type: 'function_call',
            name: 'test',
            callId: 'c1',
            status: 'completed',
            arguments: '{}',
          },
        ],
        usage: new Usage(),
      };
      const second: ModelResponse = {
        output: [fakeModelMessage('final')],
        usage: new Usage(),
      };
      class SimpleStreamingModel implements Model {
        constructor(private resps: ModelResponse[]) {}
        async getResponse(_req: ModelRequest): Promise<ModelResponse> {
          const r = this.resps.shift();
          if (!r) {
            throw new Error('No response found');
          }
          return r;
        }
        async *getStreamedResponse(
          req: ModelRequest,
        ): AsyncIterable<protocol.StreamEvent> {
          const r = await this.getResponse(req);
          yield {
            type: 'response_done',
            response: {
              id: 'r',
              usage: {
                requests: 1,
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
              },
              output: r.output,
            },
          } as any;
        }
      }
      const agent = new Agent({
        name: 'StreamRecord',
        model: new SimpleStreamingModel([first, second]),
        tools: [TEST_TOOL],
      });
      const res = await run(agent, 'go', { stream: true });
      for await (const _ of res.toStream()) {
        // consume
      }
      await res.completed;
      expect(res.state._modelResponses).toHaveLength(2);
    });

    it('max turn exceeded throws', async () => {
      const agent = new Agent({
        name: 'Max',
        model: new FakeModel([
          { output: [fakeModelMessage('nope')], usage: new Usage() },
        ]),
      });
      await expect(run(agent, 'x', { maxTurns: 0 })).rejects.toBeInstanceOf(
        MaxTurnsExceededError,
      );
    });

    it('does nothing when no input guardrails are configured', async () => {
      setTracingDisabled(false);
      setTraceProcessors([new BatchTraceProcessor(new FakeTracingExporter())]);
      const agent = new Agent({
        name: 'NoIG',
        model: new FakeModel([
          { output: [fakeModelMessage('ok')], usage: new Usage() },
        ]),
      });
      const result = await run(agent, 'hi');
      expect(result.inputGuardrailResults).toEqual([]);
      expect(result.state._currentAgentSpan?.error).toBeNull();
      setTracingDisabled(true);
    });

    it('does nothing when no output guardrails are configured', async () => {
      setTracingDisabled(false);
      const agent = new Agent({
        name: 'NoOG',
        model: new FakeModel([
          { output: [fakeModelMessage('ok')], usage: new Usage() },
        ]),
      });
      const spy = vi.spyOn(agent, 'processFinalOutput');
      const result = await run(agent, 'input');
      expect(result.outputGuardrailResults).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
      expect(result.state._currentAgentSpan?.error).toBeNull();
      setTracingDisabled(true);
    });

    it('getTurnInput assembles history correctly', () => {
      const msgItem = new MessageOutputItem(
        TEST_MODEL_MESSAGE,
        new Agent({ name: 'X' }),
      );
      const result1 = getTurnInput('hello', [msgItem]);
      expect(result1[0]).toEqual({
        type: 'message',
        role: 'user',
        content: 'hello',
      });
      expect(result1[1]).toEqual(msgItem.rawItem);
      const result2 = getTurnInput(
        [{ type: 'message', role: 'user', content: 'a' }],
        [msgItem],
      );
      expect(result2[0]).toEqual({
        type: 'message',
        role: 'user',
        content: 'a',
      });
      expect(result2[1]).toEqual(msgItem.rawItem);
    });

    it('run() helper reuses underlying runner', async () => {
      const spy = vi.spyOn(Runner.prototype, 'run');
      const agentA = new Agent({ name: 'AA' });
      const agentB = new Agent({ name: 'BB' });
      await run(agentA, '1');
      await run(agentB, '2');
      expect(spy.mock.instances[0]).toBe(spy.mock.instances[1]);
      spy.mockRestore();
    });
  });

  describe('gpt-5 default model adjustments', () => {
    class InspectableModel extends FakeModel {
      lastRequest: ModelRequest | undefined;

      constructor(response: ModelResponse) {
        super([response]);
      }

      override async getResponse(
        request: ModelRequest,
      ): Promise<ModelResponse> {
        this.lastRequest = request;
        return await super.getResponse(request);
      }
    }

    class InspectableModelProvider implements ModelProvider {
      constructor(private readonly model: Model) {}

      async getModel(_name: string): Promise<Model> {
        return this.model;
      }
    }

    let originalDefaultModel: string | undefined;

    beforeEach(() => {
      originalDefaultModel = process.env.OPENAI_DEFAULT_MODEL;
      process.env.OPENAI_DEFAULT_MODEL = 'gpt-5o';
    });

    afterEach(() => {
      if (originalDefaultModel === undefined) {
        delete process.env.OPENAI_DEFAULT_MODEL;
      } else {
        process.env.OPENAI_DEFAULT_MODEL = originalDefaultModel;
      }
    });

    function createGpt5ModelSettings() {
      return {
        temperature: 0.42,
        providerData: {
          reasoning: { effort: 'high' },
          text: { verbosity: 'high' },
          reasoning_effort: 'medium',
          keep: 'value',
        },
        reasoning: { effort: 'high', summary: 'detailed' },
        text: { verbosity: 'medium' },
      };
    }

    it('strips GPT-5-only settings when the runner model is not a GPT-5 string', async () => {
      const modelResponse: ModelResponse = {
        output: [fakeModelMessage('Hello non GPT-5')],
        usage: new Usage(),
      };
      const inspectableModel = new InspectableModel(modelResponse);
      const agent = new Agent({
        name: 'NonGpt5Runner',
        model: inspectableModel,
        modelSettings: createGpt5ModelSettings(),
      });

      const runner = new Runner();
      const result = await runner.run(agent, 'hello');

      expect(result.finalOutput).toBe('Hello non GPT-5');
      expect(inspectableModel.lastRequest).toBeDefined();

      const requestSettings = inspectableModel.lastRequest!.modelSettings;
      expect(requestSettings.temperature).toBe(0.42);
      expect(requestSettings.providerData?.keep).toBe('value');
      expect(requestSettings.providerData?.reasoning).toBeUndefined();
      expect(requestSettings.providerData?.text?.verbosity).toBeUndefined();
      expect(
        (requestSettings.providerData as any)?.reasoning_effort,
      ).toBeUndefined();
      expect(requestSettings.reasoning?.effort).toBeUndefined();
      expect(requestSettings.reasoning?.summary).toBeUndefined();
      expect(requestSettings.text?.verbosity).toBeUndefined();
    });

    it('keeps GPT-5-only settings when the agent relies on the default model', async () => {
      const modelResponse: ModelResponse = {
        output: [fakeModelMessage('Hello default GPT-5')],
        usage: new Usage(),
      };
      const inspectableModel = new InspectableModel(modelResponse);
      const runner = new Runner({
        modelProvider: new InspectableModelProvider(inspectableModel),
      });

      const agent = new Agent({
        name: 'DefaultModelAgent',
        modelSettings: createGpt5ModelSettings(),
      });

      const result = await runner.run(agent, 'hello');

      expect(result.finalOutput).toBe('Hello default GPT-5');
      expect(inspectableModel.lastRequest).toBeDefined();

      const requestSettings = inspectableModel.lastRequest!.modelSettings;
      expect(requestSettings.providerData?.reasoning).toEqual({
        effort: 'high',
      });
      expect(requestSettings.providerData?.text?.verbosity).toBe('high');
      expect((requestSettings.providerData as any)?.reasoning_effort).toBe(
        'medium',
      );
      expect(requestSettings.reasoning?.effort).toBe('high');
      expect(requestSettings.reasoning?.summary).toBe('detailed');
      expect(requestSettings.text?.verbosity).toBe('medium');
    });
  });

  describe('selectModel', () => {
    const MODEL_A = 'gpt-4o';
    const MODEL_B = 'gpt-4.1-mini';

    it("returns the agent's model when it is a non-empty string and no override is provided", () => {
      const result = selectModel(MODEL_A, undefined);
      expect(result).toBe(MODEL_A);
    });

    it("returns the agent's model when it is a non-empty string even when an override is provided", () => {
      const result = selectModel(MODEL_A, MODEL_B);
      expect(result).toBe(MODEL_A);
    });

    it("returns the agent's model when it is a Model instance and no override is provided", () => {
      const fakeModel = new FakeModel();
      const result = selectModel(fakeModel, undefined);
      expect(result).toBe(fakeModel);
    });

    it("returns the agent's model when it is a Model instance even when an override is provided", () => {
      const fakeModel = new FakeModel();
      const result = selectModel(fakeModel, MODEL_B);
      expect(result).toBe(fakeModel);
    });

    it('returns the override model when the agent model is the default placeholder', () => {
      const result = selectModel(Agent.DEFAULT_MODEL_PLACEHOLDER, MODEL_B);
      expect(result).toBe(MODEL_B);
    });

    it('returns the default placeholder when both agent and override models are the default placeholder / undefined', () => {
      const result = selectModel(Agent.DEFAULT_MODEL_PLACEHOLDER, undefined);
      expect(result).toBe(Agent.DEFAULT_MODEL_PLACEHOLDER);
    });
  });
});
