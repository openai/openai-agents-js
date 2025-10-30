import { Buffer } from 'node:buffer';
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
  Session,
  ModelInputData,
  type AgentInputItem,
  run,
  Runner,
  setDefaultModelProvider,
  setTraceProcessors,
  setTracingDisabled,
  BatchTraceProcessor,
  user,
  assistant,
} from '../src';
import { RunStreamEvent } from '../src/events';
import { handoff } from '../src/handoff';
import {
  RunMessageOutputItem as MessageOutputItem,
  RunToolApprovalItem as ToolApprovalItem,
  RunToolCallOutputItem as ToolCallOutputItem,
} from '../src/items';
import { getTurnInput, selectModel } from '../src/run';
import { RunContext } from '../src/runContext';
import { RunState } from '../src/runState';
import * as protocol from '../src/types/protocol';
import { Usage } from '../src/usage';
import { tool, hostedMcpTool } from '../src/tool';
import {
  FakeModel,
  fakeModelMessage,
  FakeModelProvider,
  FakeTracingExporter,
  TEST_MODEL_MESSAGE,
  TEST_MODEL_RESPONSE_BASIC,
  TEST_TOOL,
} from './stubs';
import {
  Model,
  ModelProvider,
  ModelRequest,
  ModelSettings,
} from '../src/model';

function getFirstTextContent(item: AgentInputItem): string | undefined {
  if (item.type !== 'message') {
    return undefined;
  }
  if (typeof item.content === 'string') {
    return item.content;
  }
  if (Array.isArray(item.content)) {
    const first = item.content[0] as { text?: string };
    return first?.text;
  }
  return undefined;
}

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

    it('sets overridePromptModel when agent supplies a prompt and explicit model', async () => {
      class CapturingModel implements Model {
        lastRequest?: ModelRequest;
        async getResponse(request: ModelRequest): Promise<ModelResponse> {
          this.lastRequest = request;
          return {
            output: [fakeModelMessage('override')],
            usage: new Usage(),
          };
        }
        async *getStreamedResponse(
          _request: ModelRequest,
        ): AsyncIterable<protocol.StreamEvent> {
          yield* [];
          throw new Error('Not implemented');
        }
      }

      const capturingModel = new CapturingModel();

      const agent = new Agent({
        name: 'Prompted',
        instructions: 'Use the prompt.',
        model: capturingModel,
        prompt: { promptId: 'prompt_123' },
      });

      await run(agent, 'hello');

      expect(capturingModel.lastRequest?.prompt).toBeDefined();
      expect(capturingModel.lastRequest?.overridePromptModel).toBe(true);
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

    describe('sessions', () => {
      class MemorySession implements Session {
        #history: AgentInputItem[];
        #added: AgentInputItem[][] = [];
        sessionId?: string;

        constructor(history: AgentInputItem[] = []) {
          this.#history = [...history];
        }

        get added(): AgentInputItem[][] {
          return this.#added;
        }

        async getSessionId(): Promise<string> {
          if (!this.sessionId) {
            this.sessionId = 'conv_test';
          }
          return this.sessionId;
        }

        async getItems(limit?: number): Promise<AgentInputItem[]> {
          if (limit == null) {
            return [...this.#history];
          }
          return this.#history.slice(-limit);
        }

        async addItems(items: AgentInputItem[]): Promise<void> {
          this.#added.push(items);
          this.#history.push(...items);
        }

        async popItem(): Promise<AgentInputItem | undefined> {
          return this.#history.pop();
        }

        async clearSession(): Promise<void> {
          this.#history = [];
          this.sessionId = undefined;
        }
      }

      class RecordingModel extends FakeModel {
        lastRequest: ModelRequest | undefined;

        override async getResponse(
          request: ModelRequest,
        ): Promise<ModelResponse> {
          this.lastRequest = request;
          return super.getResponse(request);
        }
      }

      it('uses session history and stores run results', async () => {
        const model = new RecordingModel([
          {
            ...TEST_MODEL_RESPONSE_BASIC,
            output: [fakeModelMessage('response')],
          },
        ]);
        const agent = new Agent({ name: 'SessionAgent', model });
        const historyItem = fakeModelMessage(
          'earlier message',
        ) as AgentInputItem;
        const session = new MemorySession([historyItem]);
        const runner = new Runner();

        await runner.run(agent, 'How are you?', { session });

        const recordedInput = model.lastRequest?.input as AgentInputItem[];
        expect(Array.isArray(recordedInput)).toBe(true);
        expect(recordedInput[0]).toEqual(historyItem);
        expect(recordedInput[1]).toMatchObject({
          role: 'user',
          content: 'How are you?',
        });

        expect(session.added).toHaveLength(1);
        expect(session.added[0][0]).toMatchObject({
          role: 'user',
          content: 'How are you?',
        });
        expect(session.added[0][1]).toMatchObject({ role: 'assistant' });
        const savedAssistant = session
          .added[0][1] as protocol.AssistantMessageItem;
        const firstPart = Array.isArray(savedAssistant.content)
          ? (savedAssistant.content[0] as { providerData?: unknown })
          : undefined;
        expect(firstPart?.providerData).toEqual({ annotations: [] });
      });

      it('rejects list inputs when using session history', async () => {
        const runner = new Runner();
        const agent = new Agent({ name: 'ListSession' });
        const session = new MemorySession();

        await expect(
          runner.run(agent, [user('Hello')], {
            session,
          }),
        ).rejects.toThrow('RunConfig.sessionInputCallback');
      });

      it('allows list inputs when session input callback is provided', async () => {
        const model = new RecordingModel([
          {
            ...TEST_MODEL_RESPONSE_BASIC,
            output: [fakeModelMessage('response')],
          },
        ]);
        const agent = new Agent({ name: 'SessionCallbackAgent', model });
        const sessionHistory: AgentInputItem[] = [
          user('Keep this history item'),
          assistant('Drop this assistant reply'),
        ];
        const session = new MemorySession([...sessionHistory]);
        const runner = new Runner({
          sessionInputCallback: (history, newItems) => {
            return history
              .filter(
                (item) =>
                  item.type === 'message' &&
                  'role' in item &&
                  item.role === 'user',
              )
              .concat(newItems);
          },
        });

        await runner.run(agent, [user('New message')], { session });

        const recordedInput = model.lastRequest?.input as AgentInputItem[];
        expect(Array.isArray(recordedInput)).toBe(true);
        expect(recordedInput).toHaveLength(2);
        expect(
          recordedInput[0].type === 'message' &&
            'role' in recordedInput[0] &&
            recordedInput[0].role,
        ).toBe('user');
        expect(getFirstTextContent(recordedInput[0])).toBe(
          'Keep this history item',
        );
        expect(
          recordedInput[1].type === 'message' &&
            'role' in recordedInput[1] &&
            recordedInput[1].role,
        ).toBe('user');
        expect(getFirstTextContent(recordedInput[1])).toBe('New message');
      });

      it('supports async session input callback', async () => {
        const model = new RecordingModel([
          {
            ...TEST_MODEL_RESPONSE_BASIC,
            output: [fakeModelMessage('response')],
          },
        ]);
        const agent = new Agent({ name: 'AsyncSessionCallback', model });
        const session = new MemorySession([
          user('Older message'),
          user('Newest history'),
        ]);
        const runner = new Runner();

        await runner.run(agent, [user('Fresh input')], {
          session,
          sessionInputCallback: async (history, newItems) => {
            await Promise.resolve();
            return history.slice(-1).concat(newItems);
          },
        });

        const recordedInput = model.lastRequest?.input as AgentInputItem[];
        expect(Array.isArray(recordedInput)).toBe(true);
        expect(recordedInput).toHaveLength(2);
        expect(getFirstTextContent(recordedInput[0])).toBe('Newest history');
        expect(getFirstTextContent(recordedInput[1])).toBe('Fresh input');
      });

      it('persists transformed session input from callback', async () => {
        const model = new RecordingModel([
          {
            ...TEST_MODEL_RESPONSE_BASIC,
            output: [fakeModelMessage('session response')],
          },
        ]);
        const agent = new Agent({ name: 'SessionTransform', model });
        const session = new MemorySession();
        const runner = new Runner();
        const original = 'Sensitive payload';
        const redacted = '[redacted]';

        await runner.run(agent, original, {
          session,
          sessionInputCallback: (history, newItems) => {
            expect(history).toHaveLength(0);
            if (newItems[0] && typeof newItems[0] === 'object') {
              (newItems[0] as protocol.UserMessageItem).content = redacted;
            }
            return history.concat(newItems);
          },
        });

        const recordedInput = model.lastRequest?.input as AgentInputItem[];
        expect(recordedInput[recordedInput.length - 1]).toMatchObject({
          role: 'user',
          content: redacted,
        });

        expect(session.added).toHaveLength(1);
        const persistedTurn = session.added[0];
        expect(persistedTurn[0]).toMatchObject({
          role: 'user',
          content: redacted,
        });
      });

      it('does not duplicate history when callback clones entries', async () => {
        const model = new RecordingModel([
          {
            ...TEST_MODEL_RESPONSE_BASIC,
            output: [fakeModelMessage('clone response')],
          },
        ]);
        const history = [user('Existing history item')];
        const session = new MemorySession(history);
        const agent = new Agent({ name: 'CloneSession', model });
        const runner = new Runner();

        await runner.run(agent, [user('Fresh input')], {
          session,
          sessionInputCallback: (incomingHistory, newItems) => {
            const clonedHistory = incomingHistory.map((item) =>
              structuredClone(item),
            );
            const clonedNewItems = newItems.map((item) =>
              structuredClone(item),
            );
            return clonedHistory.concat(clonedNewItems);
          },
        });

        expect(session.added).toHaveLength(1);
        const [persistedItems] = session.added;
        const persistedUsers = persistedItems.filter(
          (item): item is protocol.UserMessageItem =>
            item.type === 'message' && 'role' in item && item.role === 'user',
        );
        expect(persistedUsers).toHaveLength(1);
        expect(getFirstTextContent(persistedUsers[0])).toBe('Fresh input');
      });

      it('persists reordered new items ahead of matching history', async () => {
        const model = new RecordingModel([
          {
            ...TEST_MODEL_RESPONSE_BASIC,
            output: [fakeModelMessage('reordered response')],
          },
        ]);
        const historyMessage = user('Repeatable message');
        const newMessage = user('Repeatable message');
        const session = new MemorySession([historyMessage]);
        const agent = new Agent({ name: 'ReorderedSession', model });
        const runner = new Runner({
          sessionInputCallback: (history, newItems) => newItems.concat(history),
        });

        await runner.run(agent, [newMessage], { session });

        expect(session.added).toHaveLength(1);
        const [persisted] = session.added;
        const persistedUsers = persisted.filter(
          (item): item is protocol.UserMessageItem =>
            item.type === 'message' && 'role' in item && item.role === 'user',
        );
        expect(persistedUsers).toHaveLength(1);
        expect(getFirstTextContent(persistedUsers[0])).toBe(
          'Repeatable message',
        );
      });

      it('persists binary payloads that share prefixes with history', async () => {
        const model = new RecordingModel([
          {
            ...TEST_MODEL_RESPONSE_BASIC,
            output: [fakeModelMessage('binary response')],
          },
        ]);
        const historyPayload = new Uint8Array(32);
        const newPayload = new Uint8Array(32);
        for (let i = 0; i < 32; i++) {
          const value = i < 20 ? 0xaa : i;
          historyPayload[i] = value;
          newPayload[i] = value;
        }
        historyPayload[31] = 0xbb;
        newPayload[31] = 0xcc;

        const session = new MemorySession([
          user('History with binary', { payload: historyPayload }),
        ]);
        const agent = new Agent({ name: 'BinarySession', model });
        const runner = new Runner();

        await runner.run(agent, [user('Binary input')], {
          session,
          sessionInputCallback: (history, newItems) => {
            const clonedHistory = history.map((item) => structuredClone(item));
            const updatedNewItems = newItems.map((item) => {
              const cloned = structuredClone(item);
              cloned.providerData = { payload: newPayload };
              return cloned;
            });
            return clonedHistory.concat(updatedNewItems);
          },
        });

        expect(session.added).toHaveLength(1);
        const [persistedItems] = session.added;
        const persistedPayloads = persistedItems
          .filter(
            (item): item is protocol.UserMessageItem =>
              item.type === 'message' &&
              'role' in item &&
              item.role === 'user' &&
              item.providerData?.payload,
          )
          .map((item) => item.providerData?.payload);
        const expectedNewPayload = `data:text/plain;base64,${Buffer.from(newPayload).toString('base64')}`;
        const expectedHistoryPayload = `data:text/plain;base64,${Buffer.from(historyPayload).toString('base64')}`;
        expect(persistedPayloads).toContain(expectedNewPayload);
        expect(persistedPayloads).not.toContain(expectedHistoryPayload);
      });

      it('throws when session input callback returns invalid data', async () => {
        const model = new RecordingModel([
          {
            ...TEST_MODEL_RESPONSE_BASIC,
            output: [fakeModelMessage('response')],
          },
        ]);
        const agent = new Agent({ name: 'InvalidCallback', model });
        const session = new MemorySession([user('history')]);
        const runner = new Runner();

        await expect(
          runner.run(agent, 'Hello', {
            session,
            sessionInputCallback: () =>
              'not-an-array' as unknown as AgentInputItem[],
          }),
        ).rejects.toThrow(
          'Session input callback must return an array of AgentInputItem objects.',
        );
      });

      it('stores function tool call and structured output in session', async () => {
        const functionCall: protocol.FunctionCallItem = {
          type: 'function_call',
          callId: 'call-weather',
          name: 'weather_lookup',
          status: 'completed',
          arguments: JSON.stringify({ city: 'San Francisco' }),
          providerData: { source: 'openai' },
        } as protocol.FunctionCallItem;

        const model = new FakeModel([
          {
            output: [functionCall],
            usage: new Usage(),
          },
          {
            output: [fakeModelMessage('Weather retrieved.')],
            usage: new Usage(),
          },
        ]);

        const weatherTool = tool({
          name: 'weather_lookup',
          description: 'Looks up weather information',
          parameters: z.object({ city: z.string() }),
          execute: async ({ city }) => [
            {
              type: 'text',
              text: `Weather for ${city}`,
            },
          ],
        });

        const agent = new Agent({
          name: 'FunctionToolAgent',
          model,
          tools: [weatherTool],
        });

        const session = new MemorySession();
        const runner = new Runner();

        await runner.run(agent, 'What is the weather in San Francisco?', {
          session,
        });

        expect(session.added).toHaveLength(1);
        const savedItems = session.added[0];
        expect(savedItems).toHaveLength(4);
        const savedFunctionCall = savedItems[1] as protocol.FunctionCallItem;
        expect(savedFunctionCall.providerData).toEqual({ source: 'openai' });
        expect(savedFunctionCall.arguments).toBe(
          JSON.stringify({ city: 'San Francisco' }),
        );
        const savedResult = savedItems[2] as protocol.FunctionCallResultItem & {
          output: protocol.ToolCallStructuredOutput[];
        };
        expect(Array.isArray(savedResult.output)).toBe(true);
        expect(savedResult.output[0]).toMatchObject({
          type: 'input_text',
          text: 'Weather for San Francisco',
        });
      });

      it('stores hosted tool call metadata when approval is required', async () => {
        const hostedCall: protocol.HostedToolCallItem = {
          type: 'hosted_tool_call',
          id: 'approval-1',
          name: 'mcp_approval_request',
          status: 'completed',
          providerData: {
            type: 'mcp_approval_request',
            server_label: 'demo_server',
            name: 'file_search',
            id: 'approval-1',
            arguments: '{"query":"invoices"}',
          },
        } as protocol.HostedToolCallItem;

        const model = new FakeModel([
          {
            output: [hostedCall],
            usage: new Usage(),
          },
        ]);

        const hostedTool = hostedMcpTool({
          serverLabel: 'demo_server',
          serverUrl: 'https://example.com',
          requireApproval: {
            always: { toolNames: ['file_search'] },
          },
        });

        const agent = new Agent({
          name: 'HostedToolAgent',
          model,
          tools: [hostedTool],
        });

        const session = new MemorySession();
        const runner = new Runner();

        const result = await runner.run(agent, 'Find latest invoices', {
          session,
        });

        expect(result.interruptions).toHaveLength(1);
        expect(session.added).toHaveLength(1);
        const savedItems = session.added[0];
        expect(savedItems).toHaveLength(2);
        const savedHostedCall = savedItems[1] as protocol.HostedToolCallItem & {
          providerData: Record<string, unknown>;
        };
        expect(savedHostedCall.providerData).toEqual(hostedCall.providerData);
        expect(savedHostedCall.id).toBe('approval-1');
      });
    });
  });

  describe('callModelInputFilter', () => {
    class FilterTrackingModel extends FakeModel {
      lastRequest?: ModelRequest;

      override async getResponse(
        request: ModelRequest,
      ): Promise<ModelResponse> {
        this.lastRequest = request;
        return await super.getResponse(request);
      }
    }

    class FilterStreamingModel implements Model {
      lastRequest?: ModelRequest;

      constructor(private readonly response: ModelResponse) {}

      async getResponse(request: ModelRequest): Promise<ModelResponse> {
        this.lastRequest = request;
        return this.response;
      }

      async *getStreamedResponse(
        request: ModelRequest,
      ): AsyncIterable<protocol.StreamEvent> {
        this.lastRequest = request;
        yield {
          type: 'response_done',
          response: {
            id: 'stream-filter',
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            },
            output: this.response.output,
          },
        } as protocol.StreamEvent;
      }
    }

    it('modifies model input for non-streaming runs', async () => {
      const model = new FilterTrackingModel([
        {
          ...TEST_MODEL_RESPONSE_BASIC,
          output: [fakeModelMessage('filtered result')],
        },
      ]);
      const agent = new Agent({
        name: 'FilterAgent',
        instructions: 'Base instructions',
        model,
      });

      const runner = new Runner({
        callModelInputFilter: ({ modelData }) => {
          return {
            instructions: `${modelData.instructions ?? ''} ::filtered`,
            input: modelData.input.slice(-1),
          };
        },
      });

      await runner.run(agent, [user('First input'), user('Second input')]);

      expect(model.lastRequest?.systemInstructions).toBe(
        'Base instructions ::filtered',
      );
      const sentInput = model.lastRequest?.input as AgentInputItem[];
      expect(Array.isArray(sentInput)).toBe(true);
      expect(sentInput).toHaveLength(1);
      expect(
        sentInput[0].type === 'message' &&
          'role' in sentInput[0] &&
          sentInput[0].role,
      ).toBe('user');
      expect(getFirstTextContent(sentInput[0])).toBe('Second input');
    });

    it('supports async filters for streaming runs', async () => {
      const streamingModel = new FilterStreamingModel({
        output: [fakeModelMessage('stream response')],
        usage: new Usage(),
      });
      const agent = new Agent({
        name: 'StreamFilterAgent',
        instructions: 'Stream instructions',
        model: streamingModel,
      });

      const runner = new Runner({
        callModelInputFilter: async ({ modelData }) => {
          await Promise.resolve();
          return {
            instructions: `${modelData.instructions ?? ''} ::stream`,
            input: modelData.input.slice(0, 1),
          };
        },
      });

      const result = await runner.run(agent, [user('Alpha'), user('Beta')], {
        stream: true,
      });

      const events: RunStreamEvent[] = [];
      for await (const e of result.toStream()) {
        events.push(e);
      }
      await result.completed;

      expect(streamingModel.lastRequest?.systemInstructions).toBe(
        'Stream instructions ::stream',
      );
      const streamInput = streamingModel.lastRequest?.input as AgentInputItem[];
      expect(Array.isArray(streamInput)).toBe(true);
      expect(streamInput).toHaveLength(1);
      expect(
        streamInput[0].type === 'message' &&
          'role' in streamInput[0] &&
          streamInput[0].role,
      ).toBe('user');
      expect(getFirstTextContent(streamInput[0])).toBe('Alpha');
    });

    it('does not mutate run history when filter mutates input items', async () => {
      const model = new FilterTrackingModel([
        {
          ...TEST_MODEL_RESPONSE_BASIC,
        },
      ]);
      const agent = new Agent({
        name: 'HistoryFilterAgent',
        model,
      });

      const originalText = 'Top secret message';
      const redactedText = '[redacted]';

      const runner = new Runner({
        callModelInputFilter: ({ modelData }) => {
          const first = modelData.input[0];
          if (
            first?.type === 'message' &&
            Array.isArray(first.content) &&
            first.content.length > 0
          ) {
            const firstChunk = first.content[0] as { text?: string };
            if (firstChunk) {
              firstChunk.text = redactedText;
            }
          }
          return modelData;
        },
      });

      const result = await runner.run(agent, [user(originalText)]);

      const sentInput = model.lastRequest?.input as AgentInputItem[];
      expect(Array.isArray(sentInput)).toBe(true);
      expect(getFirstTextContent(sentInput[0])).toBe(redactedText);

      const history = result.history;
      expect(getFirstTextContent(history[0])).toBe(originalText);
    });

    it('does not duplicate existing session history when filters run', async () => {
      class TrackingSession implements Session {
        #history: AgentInputItem[];
        added: AgentInputItem[][] = [];
        sessionId?: string;

        constructor(history: AgentInputItem[]) {
          this.#history = [...history];
          this.sessionId = 'filter-session';
        }

        async getSessionId(): Promise<string> {
          if (!this.sessionId) {
            this.sessionId = 'filter-session';
          }
          return this.sessionId;
        }

        async getItems(): Promise<AgentInputItem[]> {
          return [...this.#history];
        }

        async addItems(items: AgentInputItem[]): Promise<void> {
          this.added.push(items);
          this.#history.push(...items);
        }

        async popItem(): Promise<AgentInputItem | undefined> {
          return this.#history.pop();
        }

        async clearSession(): Promise<void> {
          this.#history = [];
          this.sessionId = undefined;
        }
      }

      const model = new FilterTrackingModel([
        {
          ...TEST_MODEL_RESPONSE_BASIC,
        },
      ]);
      const agent = new Agent({
        name: 'FilterSessionAgent',
        model,
      });
      const historyMessage = user('Persisted history');
      const session = new TrackingSession([historyMessage]);
      const runner = new Runner({
        callModelInputFilter: ({ modelData }) => ({
          instructions: modelData.instructions,
          input: modelData.input,
        }),
      });

      await runner.run(agent, 'Fresh input', { session });

      expect(session.added).toHaveLength(1);
      const [persisted] = session.added;
      const persistedUsers = persisted.filter(
        (item) => 'role' in item && item.role === 'user',
      );
      expect(persistedUsers).toHaveLength(1);
      const persistedTexts = persistedUsers
        .map((item) => {
          if ('content' in item && typeof item.content === 'string') {
            return item.content;
          }
          return getFirstTextContent(item);
        })
        .filter((text): text is string => typeof text === 'string');
      expect(persistedTexts).toContain('Fresh input');
      expect(persistedTexts).not.toContain('Persisted history');
    });

    it('does not persist raw inputs when filters drop every item', async () => {
      class RecordingSession implements Session {
        #history: AgentInputItem[] = [];
        added: AgentInputItem[][] = [];
        #sessionId: string | undefined = 'empty-filter-session';

        async getSessionId(): Promise<string> {
          if (!this.#sessionId) {
            this.#sessionId = 'empty-filter-session';
          }
          return this.#sessionId;
        }

        async getItems(): Promise<AgentInputItem[]> {
          return [...this.#history];
        }

        async addItems(items: AgentInputItem[]): Promise<void> {
          this.added.push(items);
          this.#history.push(...items);
        }

        async popItem(): Promise<AgentInputItem | undefined> {
          return this.#history.pop();
        }

        async clearSession(): Promise<void> {
          this.#history = [];
          this.#sessionId = undefined;
        }
      }

      const model = new FilterTrackingModel([
        {
          ...TEST_MODEL_RESPONSE_BASIC,
        },
      ]);
      const agent = new Agent({
        name: 'EmptyFilterAgent',
        model,
      });
      const session = new RecordingSession();

      const runner = new Runner({
        callModelInputFilter: ({ modelData }) => ({
          instructions: modelData.instructions,
          input: [],
        }),
      });

      const secret = 'sensitive payload';
      const result = await runner.run(agent, secret, { session });

      expect(result.finalOutput).toBe('Hello World');
      expect(model.lastRequest?.input).toEqual([]);

      expect(session.added).toHaveLength(1);
      const persisted = session.added[0];
      const persistedTexts = persisted
        .map((item) => getFirstTextContent(item))
        .filter((text): text is string => typeof text === 'string');
      expect(persistedTexts).not.toContain(secret);
      const userItems = persisted.filter(
        (item) => 'role' in item && item.role === 'user',
      );
      expect(userItems).toHaveLength(0);
    });

    it('keeps original inputs when filters prepend new items', async () => {
      class RecordingSession implements Session {
        #history: AgentInputItem[] = [];
        added: AgentInputItem[][] = [];
        #sessionId: string | undefined = 'prepended-filter-session';

        async getSessionId(): Promise<string> {
          if (!this.#sessionId) {
            this.#sessionId = 'prepended-filter-session';
          }
          return this.#sessionId;
        }

        async getItems(): Promise<AgentInputItem[]> {
          return [...this.#history];
        }

        async addItems(items: AgentInputItem[]): Promise<void> {
          this.added.push(items);
          this.#history.push(...items);
        }

        async popItem(): Promise<AgentInputItem | undefined> {
          return this.#history.pop();
        }

        async clearSession(): Promise<void> {
          this.#history = [];
          this.#sessionId = undefined;
        }
      }

      const model = new FilterTrackingModel([
        {
          ...TEST_MODEL_RESPONSE_BASIC,
        },
      ]);
      const agent = new Agent({
        name: 'PrependedFilterAgent',
        model,
      });
      const session = new RecordingSession();

      const runner = new Runner({
        callModelInputFilter: ({ modelData }) => ({
          instructions: modelData.instructions,
          input: [assistant('primer'), ...modelData.input],
        }),
      });

      await runner.run(agent, 'Persist me', { session });

      expect(session.added).toHaveLength(1);
      const [persisted] = session.added;
      const persistedTexts = persisted
        .map((item) => getFirstTextContent(item))
        .filter((text): text is string => typeof text === 'string');
      expect(persistedTexts).toContain('Persist me');
    });

    it('throws when filter returns invalid data', async () => {
      const model = new FilterTrackingModel([
        {
          ...TEST_MODEL_RESPONSE_BASIC,
        },
      ]);
      const agent = new Agent({
        name: 'InvalidFilterAgent',
        model,
      });
      const runner = new Runner({
        callModelInputFilter: () =>
          ({
            instructions: 'invalid',
          }) as unknown as ModelInputData,
      });

      await expect(runner.run(agent, 'Hello')).rejects.toThrow(
        'ModelInputData',
      );
    });

    it('prefers per-run callModelInputFilter over runner config', async () => {
      const model = new FilterTrackingModel([
        {
          ...TEST_MODEL_RESPONSE_BASIC,
        },
      ]);
      const agent = new Agent({
        name: 'OverrideFilterAgent',
        model,
      });

      const defaultFilter = vi.fn(({ modelData }) => ({
        instructions: `${modelData.instructions ?? ''} default`,
        input: modelData.input,
      }));
      const overrideFilter = vi.fn((payload) => ({
        instructions: 'override instructions',
        input: payload.modelData.input,
      }));

      const runner = new Runner({
        callModelInputFilter: defaultFilter,
      });

      const context = { tenant: 'acme' };

      await runner.run(agent, 'Hello override', {
        callModelInputFilter: overrideFilter,
        context,
      });

      expect(defaultFilter).not.toHaveBeenCalled();
      expect(overrideFilter).toHaveBeenCalledTimes(1);
      const args = overrideFilter.mock.calls[0][0];
      expect(args.context).toEqual(context);

      expect(model.lastRequest?.systemInstructions).toBe(
        'override instructions',
      );
      const sentInput = model.lastRequest?.input as AgentInputItem[];
      expect(Array.isArray(sentInput)).toBe(true);
      expect(sentInput).toHaveLength(1);
      expect(getFirstTextContent(sentInput[0])).toBe('Hello override');
    });

    it('keeps server conversation tracking aligned with filtered inputs', async () => {
      class ConversationTrackingModel implements Model {
        requests: ModelRequest[] = [];

        constructor(private readonly responses: ModelResponse[]) {}

        async getResponse(request: ModelRequest): Promise<ModelResponse> {
          const cloned: ModelRequest = {
            ...request,
            input: Array.isArray(request.input)
              ? (JSON.parse(JSON.stringify(request.input)) as AgentInputItem[])
              : request.input,
          };
          this.requests.push(cloned);
          const response = this.responses.shift();
          if (!response) {
            throw new Error('No response configured');
          }
          return response;
        }

        getStreamedResponse(
          _request: ModelRequest,
        ): AsyncIterable<protocol.StreamEvent> {
          throw new Error('Not implemented');
        }
      }

      const model = new ConversationTrackingModel([
        {
          output: [
            fakeModelMessage('call the tool'),
            {
              id: 'call-1',
              type: 'function_call',
              name: 'filterTool',
              callId: 'call-1',
              status: 'completed',
              arguments: JSON.stringify({ test: 'value' }),
            } as protocol.FunctionCallItem,
          ],
          usage: new Usage(),
          responseId: 'resp-1',
        },
        {
          output: [fakeModelMessage('all done')],
          usage: new Usage(),
          responseId: 'resp-2',
        },
      ]);

      const filterTool = tool({
        name: 'filterTool',
        description: 'test tool',
        parameters: z.object({ test: z.string() }),
        execute: async ({ test }) => `result:${test}`,
      });

      let filterCalls = 0;
      const runner = new Runner({
        callModelInputFilter: ({ modelData }) => {
          filterCalls += 1;
          if (filterCalls === 1) {
            return {
              instructions: modelData.instructions,
              input: modelData.input
                .slice(1)
                .map((item) => structuredClone(item)),
            };
          }
          return modelData;
        },
      });

      const agent = new Agent({
        name: 'TrackerFilterAgent',
        model,
        tools: [filterTool],
      });

      const result = await runner.run(
        agent,
        [user('First input'), user('Second input')],
        { conversationId: 'conv-filter-tracker' },
      );

      expect(result.finalOutput).toBe('all done');
      expect(filterCalls).toBe(2);
      expect(model.requests).toHaveLength(2);

      const firstInput = model.requests[0].input as AgentInputItem[];
      expect(Array.isArray(firstInput)).toBe(true);
      expect(firstInput).toHaveLength(1);
      expect(getFirstTextContent(firstInput[0])).toBe('Second input');

      const secondInput = model.requests[1].input as AgentInputItem[];
      expect(Array.isArray(secondInput)).toBe(true);
      const secondMessages = secondInput.filter(
        (item) => item.type === 'message',
      );
      expect(secondMessages).toHaveLength(1);
      expect(getFirstTextContent(secondMessages[0])).toBe('First input');

      expect(
        secondInput.some(
          (item) =>
            item.type === 'function_call_result' &&
            (item as protocol.FunctionCallResultItem).callId === 'call-1',
        ),
      ).toBe(true);
    });

    it('stops requeuing sanitized inputs when filters replace them', async () => {
      class RedactionTrackingModel implements Model {
        requests: ModelRequest[] = [];

        constructor(private readonly responses: ModelResponse[]) {}

        async getResponse(request: ModelRequest): Promise<ModelResponse> {
          const cloned: ModelRequest = {
            ...request,
            input: Array.isArray(request.input)
              ? (JSON.parse(JSON.stringify(request.input)) as AgentInputItem[])
              : request.input,
          };
          this.requests.push(cloned);
          const response = this.responses.shift();
          if (!response) {
            throw new Error('No response configured');
          }
          return response;
        }

        getStreamedResponse(
          _request: ModelRequest,
        ): AsyncIterable<protocol.StreamEvent> {
          throw new Error('Not implemented');
        }
      }

      const model = new RedactionTrackingModel([
        {
          output: [
            fakeModelMessage('call the tool'),
            {
              id: 'call-1',
              type: 'function_call',
              name: 'filterTool',
              callId: 'call-1',
              status: 'completed',
              arguments: JSON.stringify({ test: 'value' }),
            } as protocol.FunctionCallItem,
          ],
          usage: new Usage(),
          responseId: 'resp-redact-1',
        },
        {
          output: [fakeModelMessage('all done')],
          usage: new Usage(),
          responseId: 'resp-redact-2',
        },
      ]);

      const filterTool = tool({
        name: 'filterTool',
        description: 'test tool',
        parameters: z.object({ test: z.string() }),
        execute: async ({ test }) => `result:${test}`,
      });

      let filterCalls = 0;
      const runner = new Runner({
        callModelInputFilter: ({ modelData }) => {
          filterCalls += 1;
          if (filterCalls === 1) {
            return {
              instructions: modelData.instructions,
              input: modelData.input.map((item) => {
                if (
                  item?.type === 'message' &&
                  'role' in item &&
                  item.role === 'user'
                ) {
                  const clone = structuredClone(item);
                  if (typeof clone.content === 'string') {
                    clone.content = '[redacted]';
                  } else if (Array.isArray(clone.content)) {
                    const firstChunk = clone.content[0] as { text?: string };
                    if (firstChunk) {
                      firstChunk.text = '[redacted]';
                    }
                  }
                  return clone;
                }
                return structuredClone(item);
              }),
            };
          }
          return modelData;
        },
      });

      const agent = new Agent({
        name: 'RedactionFilterAgent',
        model,
        tools: [filterTool],
      });

      const result = await runner.run(agent, [user('Sensitive payload')], {
        conversationId: 'conv-filter-redact',
      });

      expect(result.finalOutput).toBe('all done');
      expect(filterCalls).toBe(2);
      expect(model.requests).toHaveLength(2);

      const firstInput = model.requests[0].input as AgentInputItem[];
      expect(Array.isArray(firstInput)).toBe(true);
      expect(getFirstTextContent(firstInput[0])).toBe('[redacted]');

      const secondInput = model.requests[1].input as AgentInputItem[];
      const secondTexts = secondInput
        .map((item) => getFirstTextContent(item))
        .filter((text): text is string => typeof text === 'string');
      expect(secondTexts).not.toContain('[redacted]');
      expect(secondTexts).not.toContain('Sensitive payload');
    });

    it('preserves providerData when saving streaming session items', async () => {
      class MetadataStreamingModel implements Model {
        constructor(private readonly response: ModelResponse) {}

        async getResponse(_request: ModelRequest): Promise<ModelResponse> {
          return this.response;
        }

        async *getStreamedResponse(
          _request: ModelRequest,
        ): AsyncIterable<protocol.StreamEvent> {
          yield {
            type: 'response_done',
            response: {
              id: 'meta-stream',
              usage: {
                requests: 1,
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
              },
              output: this.response.output,
            },
          } as protocol.StreamEvent;
        }
      }

      const assistantMessage: protocol.AssistantMessageItem = {
        ...fakeModelMessage('assistant with metadata'),
        providerData: { annotations: ['keep-me'] },
      };
      const model = new MetadataStreamingModel({
        output: [assistantMessage],
        usage: new Usage(),
      });

      const agent = new Agent({
        name: 'StreamSessionMetadata',
        model,
      });

      class RecordingSession implements Session {
        #history: AgentInputItem[] = [];
        added: AgentInputItem[][] = [];
        sessionId = 'stream-session';

        async getSessionId(): Promise<string> {
          return this.sessionId;
        }

        async getItems(): Promise<AgentInputItem[]> {
          return [...this.#history];
        }

        async addItems(items: AgentInputItem[]): Promise<void> {
          this.added.push(items);
          this.#history.push(...items);
        }

        async popItem(): Promise<AgentInputItem | undefined> {
          return this.#history.pop();
        }

        async clearSession(): Promise<void> {
          this.#history = [];
        }
      }

      const session = new RecordingSession();
      const runner = new Runner();

      const result = await runner.run(agent, 'Hi stream', {
        stream: true,
        session,
      });

      for await (const _event of result.toStream()) {
        // exhaust stream so the run finishes
      }
      await result.completed;

      expect(session.added).toHaveLength(2);
      const streamedItems = session.added[1];
      expect(streamedItems).toHaveLength(1);
      const savedAssistant = streamedItems[0] as protocol.AssistantMessageItem;
      expect(savedAssistant.providerData).toEqual({ annotations: ['keep-me'] });
      expect(getFirstTextContent(savedAssistant)).toBe(
        'assistant with metadata',
      );
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

    function createGpt5ModelSettings(): ModelSettings {
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

  describe('server-managed conversation state', () => {
    type TurnResponse = ModelResponse;

    class RecordingSession implements Session {
      public added: AgentInputItem[][] = [];

      async getSessionId(): Promise<string> {
        return 'server-managed-session';
      }

      async getItems(): Promise<AgentInputItem[]> {
        return [];
      }

      async addItems(items: AgentInputItem[]): Promise<void> {
        this.added.push(items);
      }

      async popItem(): Promise<AgentInputItem | undefined> {
        return undefined;
      }

      async clearSession(): Promise<void> {
        this.added = [];
      }
    }

    class TrackingModel implements Model {
      public requests: ModelRequest[] = [];
      public firstRequest: ModelRequest | undefined;
      public lastRequest: ModelRequest | undefined;

      constructor(private readonly responses: TurnResponse[]) {}

      private recordRequest(request: ModelRequest) {
        const clonedInput: string | AgentInputItem[] =
          typeof request.input === 'string'
            ? request.input
            : (JSON.parse(JSON.stringify(request.input)) as AgentInputItem[]);

        const recorded: ModelRequest = {
          ...request,
          input: clonedInput,
        };

        this.requests.push(recorded);
        this.lastRequest = recorded;
        this.firstRequest ??= recorded;
      }

      async getResponse(request: ModelRequest): Promise<ModelResponse> {
        this.recordRequest(request);
        const response = this.responses.shift();
        if (!response) {
          throw new Error('No response configured');
        }
        return response;
      }

      getStreamedResponse(
        _request: ModelRequest,
      ): AsyncIterable<protocol.StreamEvent> {
        throw new Error('Not implemented');
      }
    }

    const buildResponse = (
      items: protocol.ModelItem[],
      responseId?: string,
    ): ModelResponse => ({
      output: JSON.parse(JSON.stringify(items)) as protocol.ModelItem[],
      usage: new Usage(),
      responseId,
    });

    const buildToolCall = (
      callId: string,
      arg: string,
    ): protocol.FunctionCallItem => ({
      id: callId,
      type: 'function_call',
      name: 'test',
      callId,
      status: 'completed',
      arguments: JSON.stringify({ test: arg }),
    });

    const serverTool = tool({
      name: 'test',
      description: 'test tool',
      parameters: z.object({ test: z.string() }),
      execute: async ({ test }) => `result:${test}`,
    });

    it('skips persisting turns when the server manages conversation history via conversationId', async () => {
      const model = new TrackingModel([
        {
          ...TEST_MODEL_RESPONSE_BASIC,
          output: [fakeModelMessage('response')],
        },
      ]);
      const agent = new Agent({ name: 'ServerManagedConversation', model });
      // Deliberately combine session with conversationId to ensure callbacks and state helpers remain usable without duplicating remote history.
      const session = new RecordingSession();
      const runner = new Runner();

      await runner.run(agent, 'Hello there', {
        session,
        conversationId: 'conv-server-managed',
      });

      expect(session.added).toHaveLength(0);
      expect(model.lastRequest?.conversationId).toBe('conv-server-managed');
    });

    it('skips persisting turns when the server manages conversation history via previousResponseId', async () => {
      const model = new TrackingModel([
        {
          ...TEST_MODEL_RESPONSE_BASIC,
          output: [fakeModelMessage('response')],
        },
      ]);
      const agent = new Agent({ name: 'ServerManagedPrevious', model });
      // Deliberately combine session with previousResponseId to ensure we honor server-side transcripts while keeping session utilities available.
      const session = new RecordingSession();
      const runner = new Runner();

      await runner.run(agent, 'Hi again', {
        session,
        previousResponseId: 'resp-existing',
      });

      expect(session.added).toHaveLength(0);
      expect(model.lastRequest?.previousResponseId).toBe('resp-existing');
    });

    it('preserves user input when the session callback only reuses history with conversationId', async () => {
      const model = new TrackingModel([
        {
          ...TEST_MODEL_RESPONSE_BASIC,
          output: [fakeModelMessage('response')],
        },
      ]);
      const agent = new Agent({ name: 'ServerManagedReuse', model });
      const persistedHistory: AgentInputItem[] = [
        assistant('Persisted reply from history'),
      ];
      const session: Session = {
        async getSessionId() {
          return 'server-managed-session';
        },
        async getItems() {
          return persistedHistory;
        },
        async addItems(items) {
          persistedHistory.push(...items);
        },
        async popItem() {
          return persistedHistory.pop();
        },
        async clearSession() {
          persistedHistory.length = 0;
        },
      };
      const runner = new Runner();

      await runner.run(agent, 'Latest user input', {
        session,
        conversationId: 'conv-history-only',
        sessionInputCallback: (historyItems) => historyItems,
      });

      const firstInput = model.firstRequest?.input;
      expect(Array.isArray(firstInput)).toBe(true);
      const sentItems = firstInput as AgentInputItem[];
      expect(sentItems).toHaveLength(1);
      expect(getFirstTextContent(sentItems[0])).toBe('Latest user input');
    });

    it('only sends new items when using conversationId across turns', async () => {
      const model = new TrackingModel([
        buildResponse(
          [fakeModelMessage('a_message'), buildToolCall('call-1', 'foo')],
          'resp-1',
        ),
        buildResponse(
          [fakeModelMessage('b_message'), buildToolCall('call-2', 'bar')],
          'resp-2',
        ),
        buildResponse([fakeModelMessage('done')], 'resp-3'),
      ]);

      const agent = new Agent({
        name: 'Test',
        model,
        tools: [serverTool],
      });

      const runner = new Runner();
      const result = await runner.run(agent, 'user_message', {
        conversationId: 'conv-test-123',
      });

      expect(result.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(3);
      expect(model.requests.map((req) => req.conversationId)).toEqual([
        'conv-test-123',
        'conv-test-123',
        'conv-test-123',
      ]);

      const firstInput = model.requests[0].input;
      expect(Array.isArray(firstInput)).toBe(true);
      expect(firstInput as AgentInputItem[]).toHaveLength(1);
      const userMessage = (firstInput as AgentInputItem[])[0] as any;
      expect(userMessage.role).toBe('user');
      expect(userMessage.content).toBe('user_message');

      const secondInput = model.requests[1].input;
      expect(Array.isArray(secondInput)).toBe(true);
      const secondItems = secondInput as AgentInputItem[];
      expect(secondItems).toHaveLength(1);
      expect(secondItems[0]).toMatchObject({
        type: 'function_call_result',
        callId: 'call-1',
      });

      const thirdInput = model.requests[2].input;
      expect(Array.isArray(thirdInput)).toBe(true);
      const thirdItems = thirdInput as AgentInputItem[];
      expect(thirdItems).toHaveLength(1);
      expect(thirdItems[0]).toMatchObject({
        type: 'function_call_result',
        callId: 'call-2',
      });
    });

    it('only sends new items and updates previousResponseId across turns', async () => {
      const model = new TrackingModel([
        buildResponse(
          [fakeModelMessage('a_message'), buildToolCall('call-1', 'foo')],
          'resp-789',
        ),
        buildResponse([fakeModelMessage('done')], 'resp-900'),
      ]);

      const agent = new Agent({
        name: 'Test',
        model,
        tools: [serverTool],
      });

      const runner = new Runner();
      const result = await runner.run(agent, 'user_message', {
        previousResponseId: 'initial-response-123',
      });

      expect(result.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);

      expect(model.requests[0].previousResponseId).toBe('initial-response-123');

      const secondRequest = model.requests[1];
      expect(secondRequest.previousResponseId).toBe('resp-789');
      expect(Array.isArray(secondRequest.input)).toBe(true);
      const secondItems = secondRequest.input as AgentInputItem[];
      expect(secondItems).toHaveLength(1);
      expect(secondItems[0]).toMatchObject({
        type: 'function_call_result',
        callId: 'call-1',
      });
    });

    it('does not resend prior items when resuming with conversationId', async () => {
      const approvalTool = tool({
        name: 'test',
        description: 'tool that requires approval',
        parameters: z.object({ test: z.string() }),
        needsApproval: async () => true,
        execute: async ({ test }) => `result:${test}`,
      });

      const model = new TrackingModel([
        buildResponse([buildToolCall('call-approved', 'foo')], 'resp-1'),
        buildResponse([fakeModelMessage('done')], 'resp-2'),
      ]);

      const agent = new Agent({
        name: 'ApprovalAgent',
        model,
        tools: [approvalTool],
      });

      const runner = new Runner();
      const firstResult = await runner.run(agent, 'user_message', {
        conversationId: 'conv-approval',
      });

      expect(firstResult.interruptions).toHaveLength(1);
      const approvalItem = firstResult.interruptions[0];
      firstResult.state.approve(approvalItem);

      const secondResult = await runner.run(agent, firstResult.state, {
        conversationId: 'conv-approval',
      });

      expect(secondResult.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);

      const firstInput = model.requests[0].input;
      expect(Array.isArray(firstInput)).toBe(true);
      const firstItems = firstInput as AgentInputItem[];
      expect(firstItems).toHaveLength(1);
      expect(firstItems[0]).toMatchObject({
        role: 'user',
        content: 'user_message',
      });

      const secondRequest = model.requests[1];
      expect(secondRequest.conversationId).toBe('conv-approval');
      expect(Array.isArray(secondRequest.input)).toBe(true);
      const secondItems = secondRequest.input as AgentInputItem[];
      expect(secondItems).toHaveLength(1);
      expect(secondItems[0]).toMatchObject({
        type: 'function_call_result',
        callId: 'call-approved',
      });
    });

    it('does not resend prior items when resuming with previousResponseId', async () => {
      const approvalTool = tool({
        name: 'test',
        description: 'tool that requires approval',
        parameters: z.object({ test: z.string() }),
        needsApproval: async () => true,
        execute: async ({ test }) => `result:${test}`,
      });

      const model = new TrackingModel([
        buildResponse([buildToolCall('call-prev', 'foo')], 'resp-prev-1'),
        buildResponse([fakeModelMessage('done')], 'resp-prev-2'),
      ]);

      const agent = new Agent({
        name: 'ApprovalPrevAgent',
        model,
        tools: [approvalTool],
      });

      const runner = new Runner();
      const firstResult = await runner.run(agent, 'user_message', {
        previousResponseId: 'initial-response',
      });

      expect(firstResult.interruptions).toHaveLength(1);
      const approvalItem = firstResult.interruptions[0];
      firstResult.state.approve(approvalItem);

      const secondResult = await runner.run(agent, firstResult.state, {
        previousResponseId: 'initial-response',
      });

      expect(secondResult.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);

      expect(model.requests[0].previousResponseId).toBe('initial-response');

      const secondRequest = model.requests[1];
      expect(secondRequest.previousResponseId).toBe('resp-prev-1');
      expect(Array.isArray(secondRequest.input)).toBe(true);
      const secondItems = secondRequest.input as AgentInputItem[];
      expect(secondItems).toHaveLength(1);
      expect(secondItems[0]).toMatchObject({
        type: 'function_call_result',
        callId: 'call-prev',
      });
    });

    it('does not resend items when resuming multiple times without new approvals', async () => {
      const approvalTool = tool({
        name: 'test',
        description: 'approval tool',
        parameters: z.object({ test: z.string() }),
        needsApproval: async () => true,
        execute: async ({ test }) => `result:${test}`,
      });

      const model = new TrackingModel([
        buildResponse([buildToolCall('call-repeat', 'foo')], 'resp-repeat-1'),
        buildResponse([fakeModelMessage('done')], 'resp-repeat-2'),
      ]);

      const agent = new Agent({
        name: 'RepeatAgent',
        model,
        tools: [approvalTool],
      });

      const runner = new Runner();
      const firstResult = await runner.run(agent, 'user_message', {
        conversationId: 'conv-repeat',
      });

      expect(firstResult.interruptions).toHaveLength(1);
      const approvalItem = firstResult.interruptions[0];
      firstResult.state.approve(approvalItem);

      const secondResult = await runner.run(agent, firstResult.state, {
        conversationId: 'conv-repeat',
      });

      expect(secondResult.finalOutput).toBe('done');

      const thirdResult = await runner.run(agent, secondResult.state, {
        conversationId: 'conv-repeat',
      });

      expect(thirdResult.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);
    });

    it('sends newly appended generated items when resuming', async () => {
      const approvalTool = tool({
        name: 'test',
        description: 'approval tool',
        parameters: z.object({ test: z.string() }),
        needsApproval: async () => true,
        execute: async ({ test }) => `result:${test}`,
      });

      const model = new TrackingModel([
        buildResponse([buildToolCall('call-extra', 'foo')], 'resp-extra-1'),
        buildResponse([fakeModelMessage('done')], 'resp-extra-2'),
      ]);

      const agent = new Agent({
        name: 'ExtraAgent',
        model,
        tools: [approvalTool],
      });

      const runner = new Runner();
      const firstResult = await runner.run(agent, 'user_message', {
        conversationId: 'conv-extra',
      });

      expect(firstResult.interruptions).toHaveLength(1);
      const approvalItem = firstResult.interruptions[0];

      const extraMessage = new MessageOutputItem(
        fakeModelMessage('cached note'),
        agent,
      );
      firstResult.state._generatedItems.push(extraMessage);

      firstResult.state.approve(approvalItem);

      const secondResult = await runner.run(agent, firstResult.state, {
        conversationId: 'conv-extra',
      });

      expect(secondResult.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);

      const secondItems = model.requests[1].input as AgentInputItem[];
      expect(secondItems).toHaveLength(2);
      expect(secondItems[0]).toMatchObject({
        type: 'message',
        content: expect.arrayContaining([
          expect.objectContaining({ text: 'cached note' }),
        ]),
      });
      expect(secondItems[1]).toMatchObject({
        type: 'function_call_result',
        callId: 'call-extra',
      });
    });

    it('sends only approved items when mixing function and MCP approvals', async () => {
      const functionTool = tool({
        name: 'test',
        description: 'function tool',
        parameters: z.object({ test: z.string() }),
        needsApproval: async () => true,
        execute: async ({ test }) => `result:${test}`,
      });

      const mcpTool = hostedMcpTool({
        serverLabel: 'demo_server',
        serverUrl: 'https://example.com',
        requireApproval: {
          always: { toolNames: ['demo_tool'] },
        },
      });

      const mcpApprovalCall: protocol.HostedToolCallItem = {
        type: 'hosted_tool_call',
        id: 'approval-id',
        name: 'mcp_approval_request',
        status: 'completed',
        providerData: {
          type: 'mcp_approval_request',
          server_label: 'demo_server',
          name: 'demo_tool',
          id: 'approval-id',
          arguments: '{}',
        },
      } as protocol.HostedToolCallItem;

      const model = new TrackingModel([
        buildResponse(
          [mcpApprovalCall, buildToolCall('call-mixed', 'foo')],
          'resp-mixed-1',
        ),
        buildResponse([fakeModelMessage('still waiting')], 'resp-mixed-2'),
      ]);

      const agent = new Agent({
        name: 'MixedAgent',
        model,
        tools: [functionTool, mcpTool],
      });

      const runner = new Runner();
      const firstResult = await runner.run(agent, 'user_message', {
        conversationId: 'conv-mixed',
      });

      const functionApproval = firstResult.interruptions.find(
        (item) => item.rawItem.type === 'function_call',
      );
      const mcpApproval = firstResult.interruptions.find(
        (item) => item.rawItem.type === 'hosted_tool_call',
      );

      expect(functionApproval).toBeDefined();
      expect(mcpApproval).toBeDefined();

      firstResult.state.approve(functionApproval!);

      const secondResult = await runner.run(agent, firstResult.state, {
        conversationId: 'conv-mixed',
      });

      expect(model.requests).toHaveLength(1);

      const toolOutputs = secondResult.newItems.filter(
        (item) =>
          item instanceof ToolCallOutputItem &&
          item.rawItem.type === 'function_call_result' &&
          item.rawItem.callId === 'call-mixed',
      );
      expect(toolOutputs).toHaveLength(1);

      expect(secondResult.interruptions).toHaveLength(1);
      expect(secondResult.interruptions[0].rawItem).toMatchObject({
        providerData: { id: 'approval-id', type: 'mcp_approval_request' },
      });
      expect(secondResult.state._currentStep?.type).toBe(
        'next_step_interruption',
      );
    });

    it('sends full history when no server-managed state is provided', async () => {
      const model = new TrackingModel([
        buildResponse(
          [fakeModelMessage('a_message'), buildToolCall('call-1', 'foo')],
          'resp-789',
        ),
        buildResponse([fakeModelMessage('done')], 'resp-900'),
      ]);

      const agent = new Agent({
        name: 'Test',
        model,
        tools: [serverTool],
      });

      const runner = new Runner();
      const result = await runner.run(agent, 'user_message');

      expect(result.finalOutput).toBe('done');
      expect(model.requests).toHaveLength(2);

      const secondInput = model.requests[1].input;
      expect(Array.isArray(secondInput)).toBe(true);
      const secondItems = secondInput as AgentInputItem[];
      expect(secondItems).toHaveLength(4);
      expect(secondItems[0]).toMatchObject({ role: 'user' });
      expect(secondItems[1]).toMatchObject({ role: 'assistant' });
      expect(secondItems[2]).toMatchObject({
        type: 'function_call',
        name: 'test',
      });
      expect(secondItems[3]).toMatchObject({
        type: 'function_call_result',
        callId: 'call-1',
      });
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
