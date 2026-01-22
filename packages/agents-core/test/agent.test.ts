import { describe, it, expect, vi, afterEach } from 'vitest';
import { Agent } from '../src/agent';
import { RunContext } from '../src/runContext';
import { Handoff, handoff } from '../src/handoff';
import { tool } from '../src/tool';
import { z } from 'zod';
import { JsonSchemaDefinition, setDefaultModelProvider } from '../src';
import {
  FakeModel,
  FakeModelProvider,
  TEST_MODEL_RESPONSE_BASIC,
  TEST_MODEL_RESPONSE_WITH_FUNCTION,
} from './stubs';
import { Runner, RunConfig } from '../src/run';
import logger from '../src/logger';

describe('Agent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create an agent with default values', () => {
    const agent = new Agent({ name: 'TestAgent' });

    expect(agent.name).toBe('TestAgent');
    expect(agent.instructions).toBe('');
    expect(agent.handoffDescription).toBe('');
    expect(agent.handoffs).toEqual([]);
    expect(agent.model).toBe('');
    expect(agent.modelSettings).toEqual({});
    expect(agent.tools).toEqual([]);
    expect(agent.mcpServers).toEqual([]);
    expect(agent.inputGuardrails).toEqual([]);
    expect(agent.outputGuardrails).toEqual([]);
    expect(agent.outputType).toBe('text');
    expect(agent.toolUseBehavior).toBe('run_llm_again');
    expect(agent.resetToolChoice).toBe(true);
  });

  it('should throw if name is missing', () => {
    expect(() => new Agent({} as any)).toThrow('Agent must have a name.');
    expect(() => new Agent({ name: '' } as any)).toThrow(
      'Agent must have a name.',
    );
  });

  it('should create an agent with provided values', () => {
    const agent = new Agent({
      name: 'CustomAgent',
      instructions: 'Custom instructions',
      handoffDescription: 'Custom handoff description',
      model: 'gpt-4',
      modelSettings: { temperature: 0.7 },
      outputType: 'text',
      toolUseBehavior: 'stop_on_first_tool',
      resetToolChoice: false,
    });

    expect(agent.name).toBe('CustomAgent');
    expect(agent.instructions).toBe('Custom instructions');
    expect(agent.handoffDescription).toBe('Custom handoff description');
    expect(agent.model).toBe('gpt-4');
    expect(agent.modelSettings).toEqual({ temperature: 0.7 });
    expect(agent.outputType).toBe('text');
    expect(agent.toolUseBehavior).toBe('stop_on_first_tool');
    expect(agent.resetToolChoice).toBe(false);
  });

  it('should clone an agent with modified values', () => {
    const originalAgent = new Agent({
      name: 'OriginalAgent',
      instructions: 'Original instructions',
    });

    const clonedAgent = originalAgent.clone({
      name: 'ClonedAgent',
      instructions: 'Cloned instructions',
    });

    expect(clonedAgent.name).toBe('ClonedAgent');
    expect(clonedAgent.instructions).toBe('Cloned instructions');
    expect(clonedAgent.handoffDescription).toBe(
      originalAgent.handoffDescription,
    );
    expect(clonedAgent.model).toBe(originalAgent.model);
    expect(clonedAgent.modelSettings).toEqual(originalAgent.modelSettings);
    expect(clonedAgent.outputType).toBe(originalAgent.outputType);
    expect(clonedAgent.toolUseBehavior).toBe(originalAgent.toolUseBehavior);
    expect(clonedAgent.resetToolChoice).toBe(originalAgent.resetToolChoice);
  });

  it('should return static instructions as system prompt', async () => {
    const agent = new Agent({
      name: 'StaticPromptAgent',
      instructions: 'Static instructions',
    });

    const prompt = await agent.getSystemPrompt(new RunContext({}));

    expect(prompt).toBe('Static instructions');
  });

  it('should return dynamic instructions as system prompt', async () => {
    const context = { value: 'test' };

    const agent = new Agent<typeof context>({
      name: 'DynamicPromptAgent',
      instructions: (runContext) =>
        `Dynamic instructions with context: ${runContext.context.value}`,
    });

    const prompt = await agent.getSystemPrompt(new RunContext(context));

    expect(prompt).toBe('Dynamic instructions with context: test');
  });

  it('should initialize with handoffs', async () => {
    const subAgent = new Agent({
      name: 'SubAgent',
      instructions: 'Sub instructions',
    });
    const agent1 = new Agent({
      name: 'StaticPromptAgent',
      instructions: 'Static instructions',
      handoffs: [subAgent],
    });
    expect(agent1.handoffs).toEqual([subAgent]);

    const agent2 = new Agent({
      name: 'StaticPromptAgent',
      instructions: 'Static instructions',
      handoffs: [handoff(subAgent)],
    });
    expect((agent2.handoffs[0] as Handoff).agent).toEqual(subAgent);
  });

  it('should handle Zod outputType properly', async () => {
    const foo = z.object({
      foo: z.string(),
    });
    const agent = new Agent({
      name: 'Test Agent',
      instructions: 'You do tests.',
      outputType: foo,
    });
    expect(agent.outputSchemaName).toBe('ZodOutput');
  });

  it('should handle JsonSchema outputType properly', async () => {
    const foo: JsonSchemaDefinition = {
      type: 'json_schema',
      name: 'Foo',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          foo: { type: 'string' },
        },
        required: ['foo'],
        additionalProperties: false,
      },
    };
    const agent = new Agent({
      name: 'Test Agent',
      instructions: 'You do tests.',
      outputType: foo,
    });
    expect(agent.outputSchemaName).toBe('Foo');
  });

  it('should generate a tool from an agent', async () => {
    const agent = new Agent({
      name: 'Test Agent',
      instructions: 'You do tests.',
    });
    const tool = agent.asTool({
      toolName: 'Test Agent Tool',
      toolDescription: 'You act as a tool.',
    });
    expect(tool.name).toEqual('Test_Agent_Tool');
    expect(tool.description).toEqual('You act as a tool.');

    const result1 = await tool.invoke({} as any, 'hey how are you?');
    expect(result1).toBe(
      'An error occurred while running the tool. Please try again. Error: InvalidToolInputError: Invalid JSON input for tool',
    );
    setDefaultModelProvider(new FakeModelProvider());
    const result2 = await tool.invoke(
      {} as any,
      '{"input":"hey how are you?"}',
    );
    expect(result2).toBe('Hello World');
  });

  it('warns when using asTool with stopAtToolNames behavior without custom extractor', async () => {
    const warnSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const runSpy = vi.spyOn(Runner.prototype, 'run').mockResolvedValue({
      rawResponses: [{ output: [] }],
    } as any);

    const agent = new Agent({
      name: 'Stopper Agent',
      instructions: 'Stop instructions.',
      toolUseBehavior: { stopAtToolNames: ['report'] },
    });

    const tool = agent.asTool({
      toolDescription: 'desc',
    });

    await tool.invoke(new RunContext(), '{"input":"value"}');

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      `You're passing the agent (name: Stopper Agent) with toolUseBehavior.stopAtToolNames configured as a tool to a different agent; this may not work as you expect. You may want to have a wrapper function tool to consistently return the final output.`,
    );
  });

  it('allows configuring needsApproval when using an agent as a tool', async () => {
    const approval = vi.fn().mockResolvedValue(true);
    const agent = new Agent({
      name: 'Approver Agent',
      instructions: 'Check approvals.',
    });
    const tool = agent.asTool({
      toolDescription: 'desc',
      needsApproval: approval,
    });

    const rawArgs = { input: 'hello' };
    const decision = await tool.needsApproval(
      new RunContext(),
      rawArgs,
      'call-id',
    );

    expect(approval).toHaveBeenCalledWith(
      expect.any(RunContext),
      rawArgs,
      'call-id',
    );
    expect(decision).toBe(true);
  });

  it('passes runConfig and runOptions to the runner when used as a tool', async () => {
    const agent = new Agent({
      name: 'Configurable Agent',
      instructions: 'You do tests.',
    });
    const mockResult = {} as any;
    const runSpy = vi
      .spyOn(Runner.prototype, 'run')
      .mockImplementation(async () => mockResult);

    const runConfig: Partial<RunConfig> = {
      model: 'gpt-5',
      modelSettings: {
        reasoning: { effort: 'low' },
      },
    };
    const runOptions = {
      maxTurns: 3,
      previousResponseId: 'prev-response',
    };
    const customOutputExtractor = vi.fn().mockReturnValue('custom output');

    const tool = agent.asTool({
      toolDescription: 'You act as a tool.',
      runConfig,
      runOptions,
      customOutputExtractor,
    });

    const runContext = new RunContext({ locale: 'en-US' });
    const inputPayload = { input: 'translate this' };
    const result = await tool.invoke(runContext, JSON.stringify(inputPayload));

    expect(result).toBe('custom output');
    expect(customOutputExtractor).toHaveBeenCalledWith(mockResult);
    expect(runSpy).toHaveBeenCalledTimes(1);

    const [calledAgent, calledInput, calledOptions] = runSpy.mock.calls[0];
    expect(calledAgent).toBe(agent);
    expect(calledInput).toBe(inputPayload.input);
    expect(calledOptions).toMatchObject({
      context: runContext,
      maxTurns: runOptions.maxTurns,
      previousResponseId: runOptions.previousResponseId,
    });

    const runnerInstance = runSpy.mock.instances[0] as unknown as Runner;
    expect(runnerInstance.config.model).toBe(runConfig.model);
    expect(runnerInstance.config.modelSettings).toEqual(
      runConfig.modelSettings,
    );
  });

  it('uses handled final output when maxTurns error handler completes the tool run', async () => {
    const agent = new Agent({
      name: 'MaxTurnsTool',
      instructions: 'Short runs.',
      model: new FakeModel([TEST_MODEL_RESPONSE_BASIC]),
    });
    const tool = agent.asTool({
      toolDescription: 'desc',
      runOptions: {
        maxTurns: 0,
        errorHandlers: {
          maxTurns: () => ({ finalOutput: 'handled output' }),
        },
      },
    });

    const output = await tool.invoke(new RunContext(), '{"input":"hi"}');

    expect(output).toBe('handled output');
  });

  it('prefers error handler output when maxTurns is exceeded after a model response', async () => {
    const testTool = tool({
      name: 'test',
      description: 'desc',
      parameters: z.object({}),
      execute: async () => 'ok',
    });
    const agent = new Agent({
      name: 'MaxTurnsToolAfterResponse',
      instructions: 'Short runs.',
      model: new FakeModel([
        TEST_MODEL_RESPONSE_WITH_FUNCTION,
        TEST_MODEL_RESPONSE_BASIC,
      ]),
      tools: [testTool],
      toolUseBehavior: 'run_llm_again',
    });
    const agentTool = agent.asTool({
      toolDescription: 'desc',
      runOptions: {
        maxTurns: 1,
        errorHandlers: {
          maxTurns: () => ({ finalOutput: 'handled summary' }),
        },
      },
    });

    const output = await agentTool.invoke(new RunContext(), '{"input":"hi"}');

    expect(output).toBe('handled summary');
  });

  it('falls back to final output when the last response has no output text', async () => {
    const agent = new Agent({
      name: 'FinalOutputFallback',
      instructions: 'Fallback to tool output.',
    });
    const runSpy = vi.spyOn(Runner.prototype, 'run').mockResolvedValue({
      rawResponses: [{ output: [] }],
      finalOutput: 'tool output',
    } as any);
    const tool = agent.asTool({
      toolDescription: 'desc',
    });

    const output = await tool.invoke(new RunContext(), '{"input":"hi"}');

    expect(output).toBe('tool output');
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('streams nested agent events when onStream is provided and still returns final text', async () => {
    const agent = new Agent({
      name: 'Streamer Agent',
      instructions: 'Stream things.',
    });
    const streamEvents = [
      { type: 'raw_model_stream_event', data: { type: 'response_started' } },
      {
        type: 'raw_model_stream_event',
        data: { type: 'output_text_delta', delta: 'hi' },
      },
    ] as any[];
    const streamResult = {
      rawResponses: [
        {
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'final text' }],
            },
          ],
        },
      ],
      completed: Promise.resolve(),
      interruptions: [],
      [Symbol.asyncIterator]: async function* () {
        for (const ev of streamEvents) {
          yield ev;
        }
      },
    };
    const runSpy = vi
      .spyOn(Runner.prototype, 'run')
      .mockResolvedValue(streamResult as any);
    const onStream = vi.fn();

    const tool = agent.asTool({
      toolDescription: 'Stream as tool',
      onStream,
    });

    const output = await tool.invoke(
      new RunContext(),
      '{"input":"run streaming"}',
    );

    expect(output).toBe('final text');
    expect(runSpy).toHaveBeenCalledWith(
      agent,
      'run streaming',
      expect.objectContaining({ stream: true }),
    );
    expect(onStream).toHaveBeenCalledTimes(streamEvents.length);
    expect(onStream).toHaveBeenCalledWith(
      expect.objectContaining({
        event: streamEvents[0],
        agent,
        toolCall: undefined,
      }),
    );
  });

  it('includes toolCall when streaming from nested agent tools', async () => {
    const agent = new Agent({
      name: 'Streamer Agent',
      instructions: 'Stream things.',
    });
    const toolCall = { callId: 'call-123' } as any;
    const streamEvents = [
      { type: 'raw_model_stream_event', data: { type: 'response_started' } },
    ] as any[];
    const streamResult = {
      rawResponses: [
        {
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'tool output' }],
            },
          ],
        },
      ],
      completed: Promise.resolve(),
      interruptions: [],
      [Symbol.asyncIterator]: async function* () {
        for (const ev of streamEvents) {
          yield ev;
        }
      },
    };
    const runSpy = vi
      .spyOn(Runner.prototype, 'run')
      .mockResolvedValue(streamResult as any);
    const onStream = vi.fn();

    const tool = agent.asTool({
      toolDescription: 'Stream as tool',
      onStream,
    });

    const output = await tool.invoke(
      new RunContext(),
      '{"input":"run streaming"}',
      { toolCall },
    );

    expect(output).toBe('tool output');
    expect(runSpy).toHaveBeenCalledWith(
      agent,
      'run streaming',
      expect.objectContaining({ stream: true }),
    );
    expect(onStream).toHaveBeenCalledWith(
      expect.objectContaining({
        agent,
        toolCall,
        event: streamEvents[0],
      }),
    );
  });

  it('supports event handlers registered via on (agent tool only) and wildcard handlers', async () => {
    const agent = new Agent({
      name: 'Streamer Agent',
      instructions: 'Stream things.',
    });
    const streamEvents = [
      { type: 'raw_model_stream_event', data: { type: 'response_started' } },
      {
        type: 'run_item_stream_event',
        name: 'message_output_created',
        item: { type: 'message_output_item' },
      },
    ] as any[];
    const streamResult = {
      rawResponses: [
        {
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'tool output' }],
            },
          ],
        },
      ],
      completed: Promise.resolve(),
      interruptions: [],
      [Symbol.asyncIterator]: async function* () {
        for (const ev of streamEvents) {
          yield ev;
        }
      },
    };
    const runSpy = vi
      .spyOn(Runner.prototype, 'run')
      .mockResolvedValue(streamResult as any);
    const rawHandler = vi.fn();
    const wildcardHandler = vi.fn();

    const tool = agent.asTool({
      toolDescription: 'Stream as tool',
    });

    tool.on('raw_model_stream_event', rawHandler).on('*', wildcardHandler);

    const toolCall = { callId: 'call-abc' } as any;
    const output = await tool.invoke(
      new RunContext(),
      '{"input":"run streaming"}',
      { toolCall },
    );

    expect(output).toBe('tool output');
    expect(runSpy).toHaveBeenCalledWith(
      agent,
      'run streaming',
      expect.objectContaining({ stream: true }),
    );
    expect(rawHandler).toHaveBeenCalledTimes(1);
    expect(rawHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        agent,
        toolCall,
        event: streamEvents[0],
      }),
    );
    expect(wildcardHandler).toHaveBeenCalledTimes(streamEvents.length);
  });

  it('enables streaming when handlers are registered even without onStream', async () => {
    const agent = new Agent({
      name: 'Handler Agent',
      instructions: 'Stream things.',
    });
    const streamEvents = [
      { type: 'raw_model_stream_event', data: { type: 'response_started' } },
    ] as any[];
    const streamResult = {
      rawResponses: [
        {
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'tool output' }],
            },
          ],
        },
      ],
      completed: Promise.resolve(),
      interruptions: [],
      [Symbol.asyncIterator]: async function* () {
        for (const ev of streamEvents) {
          yield ev;
        }
      },
    };
    const runSpy = vi
      .spyOn(Runner.prototype, 'run')
      .mockResolvedValue(streamResult as any);
    const handler = vi.fn();

    const tool = agent.asTool({
      toolDescription: 'Stream as tool',
    });

    tool.on('raw_model_stream_event', handler);

    const toolCall = { callId: 'call-xyz' } as any;
    const output = await tool.invoke(
      new RunContext(),
      '{"input":"run streaming"}',
      { toolCall },
    );

    expect(output).toBe('tool output');
    expect(runSpy).toHaveBeenCalledWith(
      agent,
      'run streaming',
      expect.objectContaining({ stream: true }),
    );
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        agent,
        toolCall,
        event: streamEvents[0],
      }),
    );
  });

  it('filters tools using isEnabled predicates', async () => {
    const conditionalTool = tool({
      name: 'conditional',
      description: 'conditionally available',
      parameters: z.object({}),
      execute: async () => 'ok',
      isEnabled: ({
        runContext,
      }: {
        runContext: RunContext<unknown>;
        agent: Agent<any, any>;
      }) => (runContext.context as { allowed: boolean }).allowed,
    });
    const agent = new Agent<{ allowed: boolean }>({
      name: 'Conditional Agent',
      instructions: 'test',
      tools: [conditionalTool],
    });

    const disabledTools = await agent.getAllTools(
      new RunContext({ allowed: false }),
    );
    expect(disabledTools).toEqual([]);

    const enabledTools = await agent.getAllTools(
      new RunContext({ allowed: true }),
    );
    expect(enabledTools.map((t) => t.name)).toEqual(['conditional']);
  });

  it('respects isEnabled option on Agent.asTool', async () => {
    const nestedAgent = new Agent({
      name: 'Nested',
      instructions: 'nested',
    });
    const nestedTool = nestedAgent.asTool({
      toolDescription: 'nested',
      isEnabled: ({
        runContext,
        agent,
      }: {
        runContext: RunContext<unknown>;
        agent: Agent<any, any>;
      }) => {
        expect(agent).toBe(hostAgent);
        return (runContext.context as { enabled: boolean }).enabled;
      },
    });

    const hostAgent = new Agent<{ enabled: boolean }>({
      name: 'Host',
      instructions: 'host',
      tools: [nestedTool],
    });

    const disabled = await hostAgent.getAllTools(
      new RunContext({ enabled: false }),
    );
    expect(disabled).toEqual([]);

    const enabled = await hostAgent.getAllTools(
      new RunContext({ enabled: true }),
    );
    expect(enabled.map((t) => t.name)).toEqual([nestedTool.name]);
  });

  it('enables agent tools based on language preference predicates', async () => {
    type LanguagePreference = 'spanish_only' | 'french_spanish' | 'european';

    type AppContext = {
      languagePreference: LanguagePreference;
    };

    const spanishAgent = new Agent<AppContext>({
      name: 'spanish_agent',
      instructions: 'Always respond in Spanish.',
    });

    const frenchAgent = new Agent<AppContext>({
      name: 'french_agent',
      instructions: 'Always respond in French.',
    });

    const italianAgent = new Agent<AppContext>({
      name: 'italian_agent',
      instructions: 'Always respond in Italian.',
    });

    const orchestrator = new Agent<AppContext>({
      name: 'orchestrator',
      instructions: 'Use language specialists.',
      tools: [
        spanishAgent.asTool({
          toolName: 'respond_spanish',
          toolDescription: 'Respond in Spanish.',
          isEnabled: true,
        }),
        frenchAgent.asTool({
          toolName: 'respond_french',
          toolDescription: 'Respond in French.',
          isEnabled: ({ runContext }) =>
            ['french_spanish', 'european'].includes(
              runContext.context.languagePreference,
            ),
        }),
        italianAgent.asTool({
          toolName: 'respond_italian',
          toolDescription: 'Respond in Italian.',
          isEnabled: ({ runContext }) =>
            runContext.context.languagePreference === 'european',
        }),
      ],
    });

    const collect = async (preference: LanguagePreference) =>
      (
        await orchestrator.getAllTools(
          new RunContext<AppContext>({ languagePreference: preference }),
        )
      ).map((toolInstance) => toolInstance.name);

    await expect(collect('spanish_only')).resolves.toEqual(['respond_spanish']);
    await expect(collect('french_spanish')).resolves.toEqual([
      'respond_spanish',
      'respond_french',
    ]);
    await expect(collect('european')).resolves.toEqual([
      'respond_spanish',
      'respond_french',
      'respond_italian',
    ]);
  });

  it('should process final output (text)', async () => {
    const agent = new Agent({
      name: 'Test Agent',
      instructions: 'You do tests.',
      outputType: 'text',
    });
    const result1 = agent.processFinalOutput('Hi, how are you?');
    expect(result1).toBe('Hi, how are you?');
  });
  it('should process final output (zod)', async () => {
    const agent = new Agent({
      name: 'Test Agent',
      instructions: 'You do tests.',
      outputType: z.object({ message: z.string() }),
    });
    const result1 = agent.processFinalOutput('{"message": "Hi, how are you?"}');
    expect(result1).toEqual({ message: 'Hi, how are you?' });
  });
  it('should process final output (json schema)', async () => {
    const agent = new Agent({
      name: 'Test Agent',
      instructions: 'You do tests.',
      outputType: {
        type: 'json_schema',
        name: 'TestOutput',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
          required: ['message'],
          additionalProperties: false,
        },
      },
    });
    const result1 = agent.processFinalOutput('{"message": "Hi, how are you?"}');
    expect(result1).toEqual({ message: 'Hi, how are you?' });
  });
  it('should create an instance using create method', async () => {
    const agent = Agent.create({
      name: 'Test Agent',
      instructions: 'You do tests.',
      outputType: z.object({ message: z.string() }),
    });
    const result1 = agent.processFinalOutput('{"message": "Hi, how are you?"}');
    expect(result1).toEqual({ message: 'Hi, how are you?' });
  });
  it('should create an instance using create method + handoffs', async () => {
    const agent = Agent.create({
      name: 'Test Agent',
      instructions: 'You do tests.',
      outputType: z.object({ message: z.string() }),
      handoffs: [
        Agent.create({
          name: 'Test Agent 2',
          instructions: 'You do tests.',
          outputType: z.object({ message: z.string() }),
        }),
      ],
    });
    const result1 = agent.processFinalOutput('{"message": "Hi, how are you?"}');
    expect(result1).toEqual({ message: 'Hi, how are you?' });
  });
});
