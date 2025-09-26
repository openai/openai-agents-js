import { describe, it, expect, beforeAll } from 'vitest';
import { MockAgentFactory } from '../../src/testing/mockAgentFactory';
import { MockToolFactory } from '../../src/testing/mockToolFactory';
import { Runner } from '../../src/run';
import { setDefaultModelProvider, setTracingDisabled } from '../../src';
import { FakeModelProvider } from '../stubs';

describe('MockAgentFactory', () => {
  beforeAll(() => {
    setTracingDisabled(true);
    setDefaultModelProvider(new FakeModelProvider());
  });

  describe('createAgent', () => {
    it('should create a mock agent with predefined responses', async () => {
      const agent = MockAgentFactory.createAgent({
        name: 'TestMockAgent',
        responses: [{ text: 'First response' }, { text: 'Second response' }],
      });

      expect(agent.name).toBe('TestMockAgent');
      expect(agent.instructions).toBe('I am a mock agent for testing');

      const runner = new Runner();

      // First run should get first response
      const result1 = await runner.run(agent, 'Hello');
      expect(result1.finalOutput).toBe('First response');

      // Second run should get second response
      const result2 = await runner.run(agent, 'Hello again');
      expect(result2.finalOutput).toBe('Second response');

      // Third run should get last response (second response)
      const result3 = await runner.run(agent, 'Hello once more');
      expect(result3.finalOutput).toBe('Second response');
    });

    it('should cycle through responses when cycleResponses is true', async () => {
      const agent = MockAgentFactory.createAgent({
        name: 'CyclingAgent',
        responses: [{ text: 'Response A' }, { text: 'Response B' }],
        cycleResponses: true,
      });

      const runner = new Runner();

      const result1 = await runner.run(agent, 'Test 1');
      expect(result1.finalOutput).toBe('Response A');

      const result2 = await runner.run(agent, 'Test 2');
      expect(result2.finalOutput).toBe('Response B');

      const result3 = await runner.run(agent, 'Test 3');
      expect(result3.finalOutput).toBe('Response A'); // Should cycle back
    });

    it('should handle tool calls in responses', async () => {
      // Create a mock tool that the agent can actually call
      const mockTool = MockToolFactory.createSimpleTool(
        'test_tool',
        'Test tool',
        'Tool executed',
      );

      const agent = MockAgentFactory.createAgent({
        name: 'ToolAgent',
        tools: [mockTool],
        responses: [
          {
            text: 'I will call a tool',
            toolCalls: [
              {
                name: 'test_tool',
                arguments: { param: 'value' },
              },
            ],
          },
          {
            text: 'Tool call completed',
          },
        ],
      });

      const runner = new Runner();
      const result = await runner.run(agent, 'Use a tool');

      expect(result.finalOutput).toBe('Tool call completed');

      // Check that tool call was included in the response
      const toolCalls = result.newItems.filter(
        (item) => item.type === 'tool_call_item',
      );
      expect(toolCalls).toHaveLength(1);
      expect((toolCalls[0] as any).rawItem.name).toBe('test_tool');
    });

    it('should simulate errors when shouldError is true', async () => {
      const agent = MockAgentFactory.createAgent({
        name: 'ErrorAgent',
        responses: [
          {
            text: 'This should not be seen',
            shouldError: true,
            errorMessage: 'Test error message',
          },
        ],
      });

      const runner = new Runner();

      await expect(runner.run(agent, 'Trigger error')).rejects.toThrow(
        'Test error message',
      );
    });

    it('should simulate latency with delay', async () => {
      const startTime = Date.now();

      const agent = MockAgentFactory.createAgent({
        name: 'SlowAgent',
        responses: [
          {
            text: 'Delayed response',
            delay: 100, // 100ms delay
          },
        ],
      });

      const runner = new Runner();
      const result = await runner.run(agent, 'Slow request');

      const duration = Date.now() - startTime;
      expect(duration).toBeGreaterThanOrEqual(100);
      expect(result.finalOutput).toBe('Delayed response');
    });
  });

  describe('createSimpleAgent', () => {
    it('should create an agent that always returns the same response', async () => {
      const agent = MockAgentFactory.createSimpleAgent(
        'SimpleAgent',
        'Always this response',
      );

      const runner = new Runner();

      const result1 = await runner.run(agent, 'First input');
      expect(result1.finalOutput).toBe('Always this response');

      const result2 = await runner.run(agent, 'Different input');
      expect(result2.finalOutput).toBe('Always this response');
    });
  });

  describe('createFailingAgent', () => {
    it('should create an agent that always fails', async () => {
      const agent = MockAgentFactory.createFailingAgent(
        'FailAgent',
        'Custom failure message',
      );

      const runner = new Runner();

      await expect(runner.run(agent, 'Any input')).rejects.toThrow(
        'Custom failure message',
      );
    });

    it('should use default error message when none provided', async () => {
      const agent = MockAgentFactory.createFailingAgent('FailAgent');

      const runner = new Runner();

      await expect(runner.run(agent, 'Any input')).rejects.toThrow(
        'Mock agent failure',
      );
    });
  });

  describe('createAgentWithTools', () => {
    it('should create an agent that makes tool calls', async () => {
      const calculatorTool = MockToolFactory.createSimpleTool(
        'calculator',
        'Calculator tool',
        'Calculation result',
      );
      const weatherTool = MockToolFactory.createSimpleTool(
        'weather',
        'Weather tool',
        'Weather result',
      );

      const toolCalls = [
        { name: 'calculator', arguments: { operation: 'add', a: 1, b: 2 } },
        { name: 'weather', arguments: { location: 'New York' } },
      ];

      const agent = MockAgentFactory.createAgent({
        name: 'ToolAgent',
        tools: [calculatorTool, weatherTool],
        responses: [
          {
            text: 'I will use tools',
            toolCalls,
          },
          {
            text: 'Tools executed successfully',
          },
        ],
      });

      const runner = new Runner();
      const result = await runner.run(agent, 'Use tools');

      expect(result.finalOutput).toBe('Tools executed successfully');

      const functionCalls = result.newItems.filter(
        (item) => item.type === 'tool_call_item',
      );
      expect(functionCalls).toHaveLength(2);
      expect((functionCalls[0] as any).rawItem.name).toBe('calculator');
      expect((functionCalls[1] as any).rawItem.name).toBe('weather');
    });
  });

  describe('createConversationalAgent', () => {
    it('should create an agent with multiple conversation turns', async () => {
      const responses = ['Hello!', 'How can I help?', 'Goodbye!'];
      const agent = MockAgentFactory.createConversationalAgent(
        'ChatAgent',
        responses,
      );

      const runner = new Runner();

      const result1 = await runner.run(agent, 'Hi');
      expect(result1.finalOutput).toBe('Hello!');

      const result2 = await runner.run(agent, 'I need help');
      expect(result2.finalOutput).toBe('How can I help?');

      const result3 = await runner.run(agent, 'Thanks, bye');
      expect(result3.finalOutput).toBe('Goodbye!');

      // Should stick to last response
      const result4 = await runner.run(agent, 'Another message');
      expect(result4.finalOutput).toBe('Goodbye!');
    });
  });

  describe('createSlowAgent', () => {
    it('should create an agent with simulated latency', async () => {
      const startTime = Date.now();

      const agent = MockAgentFactory.createSlowAgent(
        'SlowAgent',
        'Slow response',
        150,
      );

      const runner = new Runner();
      const result = await runner.run(agent, 'Slow request');

      const duration = Date.now() - startTime;
      expect(duration).toBeGreaterThanOrEqual(150);
      expect(result.finalOutput).toBe('Slow response');
    });
  });
});
