import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { TestScenarioBuilder } from '../../src/testing/testScenarioBuilder';
import { MockAgentFactory } from '../../src/testing/mockAgentFactory';
import { MockToolFactory } from '../../src/testing/mockToolFactory';
import { setDefaultModelProvider, setTracingDisabled } from '../../src';
import { FakeModelProvider } from '../stubs';

describe('TestScenarioBuilder', () => {
  beforeAll(() => {
    setTracingDisabled(true);
    setDefaultModelProvider(new FakeModelProvider());
  });

  beforeEach(() => {
    // Suppress console output during tests to reduce noise
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('builder pattern', () => {
    it('should build a complete test scenario', () => {
      const agent = MockAgentFactory.createSimpleAgent(
        'TestAgent',
        'Hello World',
      );

      const scenario = new TestScenarioBuilder()
        .withName('Simple greeting test')
        .withAgent(agent)
        .withInput('Say hello')
        .expectOutputContains('Hello World')
        .build();

      expect(scenario.name).toBe('Simple greeting test');
      expect(scenario.agent).toBe(agent);
      expect(scenario.input).toBe('Say hello');
      expect(scenario.expectations.outputContains).toBe('Hello World');
    });

    it('should require name, agent, and input', () => {
      expect(() => new TestScenarioBuilder().build()).toThrow(
        'Test scenario must have a name',
      );

      expect(() => new TestScenarioBuilder().withName('Test').build()).toThrow(
        'Test scenario must have an agent',
      );

      expect(() =>
        new TestScenarioBuilder()
          .withName('Test')
          .withAgent(MockAgentFactory.createSimpleAgent('Agent', 'Response'))
          .build(),
      ).toThrow('Test scenario must have input');
    });

    it('should support all expectation types', () => {
      const agent = MockAgentFactory.createSimpleAgent('TestAgent', 'Response');

      const scenario = new TestScenarioBuilder()
        .withName('Comprehensive test')
        .withAgent(agent)
        .withInput('Test input')
        .expectOutputContains('Response')
        .expectOutputEquals('Exact Response')
        .expectToolCall('test_tool', { param: 'value' })
        .expectHandoff('other_agent')
        .expectError('Expected error')
        .expectCustom(
          async (result) => (result.finalOutput as string).length > 0,
        )
        .withStreaming(true)
        .withMaxTurns(5)
        .withTimeout(10000)
        .build();

      expect(scenario.expectations.outputContains).toBe('Response');
      expect(scenario.expectations.outputEquals).toBe('Exact Response');
      expect(scenario.expectations.toolCalls).toHaveLength(1);
      expect(scenario.expectations.handoffs).toHaveLength(1);
      expect(scenario.expectations.shouldError).toBe(true);
      expect(scenario.expectations.errorContains).toBe('Expected error');
      expect(scenario.expectations.customValidation).toBeDefined();
      expect(scenario.streaming).toBe(true);
      expect(scenario.maxTurns).toBe(5);
      expect(scenario.timeout).toBe(10000);
    });
  });

  describe('scenario execution', () => {
    it('should execute a successful scenario', async () => {
      const agent = MockAgentFactory.createSimpleAgent(
        'SuccessAgent',
        'Success response',
      );

      const result = await new TestScenarioBuilder()
        .withName('Success test')
        .withAgent(agent)
        .withInput('Test input')
        .expectOutputContains('Success')
        .execute();

      expect(result.passed).toBe(true);
      expect(result.failures).toHaveLength(0);
      expect(result.result).toBeDefined();
      expect(result.result?.finalOutput).toBe('Success response');
      expect(result.duration).toBeGreaterThan(0);
    });

    it('should handle failed expectations', async () => {
      const agent = MockAgentFactory.createSimpleAgent(
        'FailAgent',
        'Unexpected response',
      );

      const result = await new TestScenarioBuilder()
        .withName('Failure test')
        .withAgent(agent)
        .withInput('Test input')
        .expectOutputContains('Expected text')
        .execute();

      expect(result.passed).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain(
        'Expected output to contain "Expected text"',
      );
    });

    it('should validate exact output matches', async () => {
      const agent = MockAgentFactory.createSimpleAgent(
        'ExactAgent',
        'Exact response',
      );

      const result = await new TestScenarioBuilder()
        .withName('Exact match test')
        .withAgent(agent)
        .withInput('Test input')
        .expectOutputEquals('Exact response')
        .execute();

      expect(result.passed).toBe(true);

      // Test failure case
      const failResult = await new TestScenarioBuilder()
        .withName('Exact match fail test')
        .withAgent(agent)
        .withInput('Test input')
        .expectOutputEquals('Different response')
        .execute();

      expect(failResult.passed).toBe(false);
      expect(failResult.failures[0]).toContain(
        'Expected output to equal "Different response"',
      );
    });

    it('should validate tool calls', async () => {
      const tool = MockToolFactory.createSimpleTool(
        'test_tool',
        'Test tool',
        'Tool result',
      );
      const agent = MockAgentFactory.createAgentWithTools(
        'ToolAgent',
        [{ name: 'test_tool', arguments: { param: 'value' } }],
        'Tool executed',
      );
      agent.tools = [tool];

      const result = await new TestScenarioBuilder()
        .withName('Tool call test')
        .withAgent(agent)
        .withInput('Use tool')
        .expectToolCall('test_tool', { param: 'value' })
        .execute();

      expect(result.passed).toBe(true);
    });

    it('should validate error expectations', async () => {
      const agent = MockAgentFactory.createFailingAgent(
        'ErrorAgent',
        'Expected error message',
      );

      const result = await new TestScenarioBuilder()
        .withName('Error test')
        .withAgent(agent)
        .withInput('Trigger error')
        .expectError('Expected error')
        .execute();

      expect(result.passed).toBe(true);

      // Test case where error is expected but doesn't occur
      const successAgent = MockAgentFactory.createSimpleAgent(
        'SuccessAgent',
        'Success',
      );
      const failResult = await new TestScenarioBuilder()
        .withName('Missing error test')
        .withAgent(successAgent)
        .withInput('Should succeed')
        .expectError()
        .execute();

      expect(failResult.passed).toBe(false);
      expect(failResult.failures[0]).toContain(
        'Expected an error to occur, but none did',
      );
    });

    it('should handle custom validation', async () => {
      const agent = MockAgentFactory.createSimpleAgent(
        'CustomAgent',
        'Custom response',
      );

      const result = await new TestScenarioBuilder()
        .withName('Custom validation test')
        .withAgent(agent)
        .withInput('Test input')
        .expectCustom(async (result) =>
          (result.finalOutput as string).includes('Custom'),
        )
        .execute();

      expect(result.passed).toBe(true);

      // Test failing custom validation
      const failResult = await new TestScenarioBuilder()
        .withName('Custom validation fail test')
        .withAgent(agent)
        .withInput('Test input')
        .expectCustom(async (result) =>
          (result.finalOutput as string).includes('Missing'),
        )
        .execute();

      expect(failResult.passed).toBe(false);
      expect(failResult.failures[0]).toBe('Custom validation failed');
    });

    it('should handle custom validation errors', async () => {
      const agent = MockAgentFactory.createSimpleAgent(
        'CustomAgent',
        'Response',
      );

      const result = await new TestScenarioBuilder()
        .withName('Custom validation error test')
        .withAgent(agent)
        .withInput('Test input')
        .expectCustom(async () => {
          throw new Error('Validation error');
        })
        .execute();

      expect(result.passed).toBe(false);
      expect(result.failures[0]).toContain(
        'Custom validation threw error: Error: Validation error',
      );
    });

    it('should handle scenario timeout', async () => {
      const agent = MockAgentFactory.createSlowAgent(
        'SlowAgent',
        'Slow response',
        2000,
      );

      const result = await new TestScenarioBuilder()
        .withName('Timeout test')
        .withAgent(agent)
        .withInput('Slow request')
        .withTimeout(100) // 100ms timeout
        .execute();

      expect(result.passed).toBe(false);
      expect(result.error?.message).toContain('timed out');
    });

    it('should support streaming scenarios', async () => {
      const agent = MockAgentFactory.createSimpleAgent(
        'StreamAgent',
        'Streaming response',
      );

      const result = await new TestScenarioBuilder()
        .withName('Streaming test')
        .withAgent(agent)
        .withInput('Stream input')
        .withStreaming(true)
        .withMaxTurns(3) // Allow more turns for streaming scenarios
        .expectOutputContains('Streaming')
        .execute();

      expect(result.passed).toBe(true);
    });

    it('should support context in scenarios', async () => {
      const agent = MockAgentFactory.createSimpleAgent(
        'ContextAgent',
        'Context response',
      );
      const context = { userId: 'test-user', sessionId: 'test-session' };

      const result = await new TestScenarioBuilder()
        .withName('Context test')
        .withAgent(agent)
        .withInput('Context input')
        .withContext(context)
        .expectOutputContains('Context')
        .execute();

      expect(result.passed).toBe(true);
      // Check if context is accessible - the structure might be different
      if (result.result?.state?._context) {
        expect(result.result.state._context.context).toEqual(context);
      }
    });
  });

  describe('static methods', () => {
    it('should execute multiple scenarios', async () => {
      const agent1 = MockAgentFactory.createSimpleAgent('Agent1', 'Response 1');
      const agent2 = MockAgentFactory.createSimpleAgent('Agent2', 'Response 2');

      const scenarios = [
        new TestScenarioBuilder()
          .withName('Test 1')
          .withAgent(agent1)
          .withInput('Input 1')
          .expectOutputContains('Response 1')
          .build(),
        new TestScenarioBuilder()
          .withName('Test 2')
          .withAgent(agent2)
          .withInput('Input 2')
          .expectOutputContains('Response 2')
          .build(),
      ];

      const results = await TestScenarioBuilder.executeScenarios(scenarios);

      expect(results).toHaveLength(2);
      expect(results[0].passed).toBe(true);
      expect(results[1].passed).toBe(true);
    });

    it('should create summary report', async () => {
      const agent = MockAgentFactory.createAgent({
        name: 'ReportAgent',
        responses: [{ text: 'Response', delay: 10 }], // Add small delay to ensure measurable duration
      });

      const scenarios = [
        new TestScenarioBuilder()
          .withName('Pass test')
          .withAgent(agent)
          .withInput('Input')
          .expectOutputContains('Response')
          .build(),
        new TestScenarioBuilder()
          .withName('Fail test')
          .withAgent(agent)
          .withInput('Input')
          .expectOutputContains('Missing')
          .build(),
      ];

      const results = await TestScenarioBuilder.executeScenarios(scenarios);
      const summary = TestScenarioBuilder.createSummaryReport(results);

      expect(summary.totalTests).toBe(2);
      expect(summary.passed).toBe(1);
      expect(summary.failed).toBe(1);
      expect(summary.passRate).toBe(50);
      expect(summary.totalDuration).toBeGreaterThan(0);
      expect(summary.failures).toHaveLength(1);
      expect(summary.failures[0].scenario).toBe('Fail test');
    });
  });
});
