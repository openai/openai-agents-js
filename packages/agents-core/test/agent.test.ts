import { describe, it, expect } from 'vitest';
import { Agent } from '../src/agent';
import { RunContext } from '../src/runContext';
import { Handoff, handoff } from '../src/handoff';
import { z } from 'zod/v3';
import {
  JsonSchemaDefinition,
  setDefaultModelProvider,
  RunResult,
} from '../src';
import { FakeModelProvider } from './stubs';

describe('Agent', () => {
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
      'An error occurred while running the tool. Please try again. Error: Error: Invalid JSON input for tool',
    );
    setDefaultModelProvider(new FakeModelProvider());
    const result2 = await tool.invoke(
      {} as any,
      '{"input":"hey how are you?"}',
    );
    expect(result2).toBe('Hello World');
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

  it('should return a RunResult when returnRunResult option is true', async () => {
    const agent = new Agent({
      name: 'Test Agent',
      instructions: 'You do tests.',
    });
    const tool = agent.asTool({ returnRunResult: true });
    setDefaultModelProvider(new FakeModelProvider());
    const result = await tool.invoke({} as any, '{"input":"hello"}');
    expect(result).toBeInstanceOf(RunResult);
    expect((result as RunResult<any, Agent<any, any>>).finalOutput).toBe(
      'Hello World',
    );
  });

  it('should expose finalOutput with stopAtToolNames using returnRunResult', async () => {
    setDefaultModelProvider(new FakeModelProvider());

    const subAgent = new Agent({
      name: 'Echo',
      instructions: 'Repeat what the user says.',
    });

    const queryTool = subAgent.asTool({
      toolName: 'query_action_logs',
      toolDescription: 'Echo tool that represents a long-running tool',
    });

    const outerAgent = new Agent({
      name: 'Parent',
      instructions: 'Use the tool then stop.',
      tools: [queryTool],
      toolUseBehavior: { stopAtToolNames: ['query_action_logs'] },
    });

    const outerToolDefault = outerAgent.asTool({
      toolName: 'get_action_logs',
    });

    const outerToolWithRunResult = outerAgent.asTool({
      toolName: 'get_action_logs_rich',
      returnRunResult: true,
    });

    const input = JSON.stringify({ input: 'hello' });

    const resultDefault = await outerToolDefault.invoke(
      new RunContext({}),
      input,
    );
    expect(resultDefault).toBe('Hello World');

    const resultWithRunResult = await outerToolWithRunResult.invoke(
      new RunContext({}),
      input,
    );
    expect(
      (resultWithRunResult as RunResult<any, Agent<any, any>>).finalOutput,
    ).toBe('Hello World');
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
