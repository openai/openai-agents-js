import { describe, it, expect } from 'vitest';
import { MockToolFactory } from '../../src/testing/mockToolFactory';
import { RunContext } from '../../src/runContext';
import { z } from 'zod';

describe('MockToolFactory', () => {
  describe('createTool', () => {
    it('should create a mock tool with default result', async () => {
      const tool = MockToolFactory.createTool({
        name: 'test_tool',
        description: 'A test tool',
        defaultResult: 'Default response',
        trackCalls: true,
      });

      expect(tool.name).toBe('test_tool');
      expect(tool.description).toBe('A test tool');

      const result = await tool.invoke(new RunContext({}), '{}');
      expect(result).toBe('Default response');
      expect(tool.mock.getCallCount()).toBe(1);
    });

    it('should handle specific executions based on input', async () => {
      const tool = MockToolFactory.createTool({
        name: 'conditional_tool',
        description: 'A conditional tool',
        executions: [
          { input: { action: 'greet' }, result: 'Hello!' },
          { input: { action: 'farewell' }, result: 'Goodbye!' },
        ],
        defaultResult: 'Unknown action',
        trackCalls: true,
      });

      // Test specific executions
      const result1 = await tool.invoke(
        new RunContext({}),
        '{"action": "greet"}',
      );
      expect(result1).toBe('Hello!');

      const result2 = await tool.invoke(
        new RunContext({}),
        '{"action": "farewell"}',
      );
      expect(result2).toBe('Goodbye!');

      // Test default result
      const result3 = await tool.invoke(
        new RunContext({}),
        '{"action": "unknown"}',
      );
      expect(result3).toBe('Unknown action');

      expect(tool.mock.getCallCount()).toBe(3);
    });

    it('should handle failures based on input', async () => {
      const tool = MockToolFactory.createTool({
        name: 'failing_tool',
        description: 'A tool that can fail',
        failures: [
          { input: { shouldFail: true }, errorMessage: 'Intentional failure' },
        ],
        defaultResult: 'Success',
        trackCalls: true,
      });

      // Test successful execution
      const result = await tool.invoke(
        new RunContext({}),
        '{"shouldFail": false}',
      );
      expect(result).toBe('Success');

      // Test failure
      await expect(
        tool.invoke(new RunContext({}), '{"shouldFail": true}'),
      ).rejects.toThrow('Intentional failure');

      expect(tool.mock.getCallCount()).toBe(2);
    });

    it('should simulate latency with delay', async () => {
      const tool = MockToolFactory.createTool({
        name: 'slow_tool',
        description: 'A slow tool',
        executions: [{ result: 'Delayed result', delay: 100 }],
        trackCalls: true,
      });

      const startTime = Date.now();
      const result = await tool.invoke(new RunContext({}), '{}');
      const duration = Date.now() - startTime;

      expect(result).toBe('Delayed result');
      expect(duration).toBeGreaterThanOrEqual(95); // Allow for small timing variations
    });

    it('should track call information', async () => {
      const tool = MockToolFactory.createTool({
        name: 'tracked_tool',
        description: 'A tracked tool',
        defaultResult: 'Tracked result',
        trackCalls: true,
      });

      const context = new RunContext({ userId: 'test-user' });
      await tool.invoke(context, '{"param": "value"}');

      const calls = tool.mock.getCalls();
      expect(calls).toHaveLength(1);

      const call = calls[0];
      expect(call.input).toEqual({ param: 'value' });
      expect(call.context).toBe(context);
      expect(call.result).toBe('Tracked result');
      expect(call.timestamp).toBeInstanceOf(Date);
      expect(call.duration).toBeGreaterThanOrEqual(0);
    });

    it('should verify expected calls', async () => {
      const tool = MockToolFactory.createTool({
        name: 'verification_tool',
        description: 'A tool for verification',
        executions: [
          {
            input: { expected: true },
            result: 'Expected call',
            shouldBeCalled: true,
          },
          {
            input: { optional: true },
            result: 'Optional call',
            shouldBeCalled: false,
          },
        ],
        trackCalls: true,
      });

      // Make the expected call
      await tool.invoke(new RunContext({}), '{"expected": true}');

      // Verification should pass
      expect(() => tool.mock.verifyExpectedCalls()).not.toThrow();

      // Reset and test failure case
      tool.mock.resetCalls();

      // Don't make the expected call
      await tool.invoke(new RunContext({}), '{"optional": true}');

      // Verification should fail
      expect(() => tool.mock.verifyExpectedCalls()).toThrow(
        'Expected tool verification_tool to be called with {"expected":true}, but it was not',
      );
    });

    it('should handle different error types', async () => {
      const tool = MockToolFactory.createTool({
        name: 'error_types_tool',
        description: 'A tool with different error types',
        failures: [
          {
            input: { errorType: 'TypeError' },
            errorMessage: 'Type error',
            errorType: 'TypeError',
          },
          {
            input: { errorType: 'RangeError' },
            errorMessage: 'Range error',
            errorType: 'RangeError',
          },
        ],
        defaultResult: 'Success',
        trackCalls: true,
      });

      await expect(
        tool.invoke(new RunContext({}), '{"errorType": "TypeError"}'),
      ).rejects.toThrow(TypeError);

      await expect(
        tool.invoke(new RunContext({}), '{"errorType": "RangeError"}'),
      ).rejects.toThrow(RangeError);
    });
  });

  describe('createSimpleTool', () => {
    it('should create a tool that always returns the same result', async () => {
      const tool = MockToolFactory.createSimpleTool(
        'simple_tool',
        'Simple description',
        'Simple result',
      );

      const result1 = await tool.invoke(new RunContext({}), '{"any": "input"}');
      expect(result1).toBe('Simple result');

      const result2 = await tool.invoke(
        new RunContext({}),
        '{"different": "input"}',
      );
      expect(result2).toBe('Simple result');

      expect(tool.mock.getCallCount()).toBe(2);
    });
  });

  describe('createFailingTool', () => {
    it('should create a tool that always fails', async () => {
      const tool = MockToolFactory.createFailingTool(
        'failing_tool',
        'Failing description',
        'Custom error',
      );

      await expect(tool.invoke(new RunContext({}), '{}')).rejects.toThrow(
        'Custom error',
      );

      expect(tool.mock.getCallCount()).toBe(1);
    });

    it('should use default error message', async () => {
      const tool = MockToolFactory.createFailingTool(
        'failing_tool',
        'Failing description',
      );

      await expect(tool.invoke(new RunContext({}), '{}')).rejects.toThrow(
        'Mock tool failure',
      );
    });
  });

  describe('createConditionalTool', () => {
    it('should handle multiple conditional executions', async () => {
      const executions = [
        { input: { command: 'start' }, result: 'Started' },
        { input: { command: 'stop' }, result: 'Stopped' },
        { input: { command: 'status' }, result: 'Running' },
      ];

      const tool = MockToolFactory.createConditionalTool(
        'conditional_tool',
        'Conditional tool',
        executions,
      );

      const result1 = await tool.invoke(
        new RunContext({}),
        '{"command": "start"}',
      );
      expect(result1).toBe('Started');

      const result2 = await tool.invoke(
        new RunContext({}),
        '{"command": "stop"}',
      );
      expect(result2).toBe('Stopped');

      const result3 = await tool.invoke(
        new RunContext({}),
        '{"command": "status"}',
      );
      expect(result3).toBe('Running');

      expect(tool.mock.getCallCount()).toBe(3);
    });
  });

  describe('createSlowTool', () => {
    it('should simulate network latency', async () => {
      const tool = MockToolFactory.createSlowTool(
        'slow_tool',
        'Slow tool',
        'Slow result',
        150,
      );

      const startTime = Date.now();
      const result = await tool.invoke(new RunContext({}), '{}');
      const duration = Date.now() - startTime;

      expect(result).toBe('Slow result');
      expect(duration).toBeGreaterThanOrEqual(150);
    });
  });

  describe('createApprovalTool', () => {
    it('should create a tool that requires approval', async () => {
      const tool = MockToolFactory.createApprovalTool(
        'approval_tool',
        'Approval tool',
        'Approved result',
      );

      expect(tool.needsApproval).toBeDefined();

      const needsApproval = await tool.needsApproval(
        new RunContext({} as any),
        {} as any,
        'call-id',
      );
      expect(needsApproval).toBe(true);

      const result = await tool.invoke(new RunContext({} as any), '{}');
      expect(result).toBe('Approved result');
    });
  });

  describe('createTypedTool', () => {
    it('should create a tool with typed parameters', async () => {
      const parameters = z.object({
        name: z.string(),
        age: z.number(),
      });

      const tool = MockToolFactory.createTypedTool(
        'typed_tool',
        'Typed tool',
        parameters,
        'Typed result',
      );

      expect(tool.parameters).toBeDefined();

      const result = await tool.invoke(
        new RunContext({}),
        '{"name": "John", "age": 30}',
      );
      expect(result).toBe('Typed result');

      // Verify the call was tracked with parsed input
      const calls = tool.mock.getCalls();
      expect(calls[0].input).toEqual({ name: 'John', age: 30 });
    });
  });

  describe('mock utilities', () => {
    it('should check if tool was called with specific input', async () => {
      const tool = MockToolFactory.createSimpleTool(
        'check_tool',
        'Check tool',
        'Result',
      );

      await tool.invoke(new RunContext({}), '{"test": "value"}');

      expect(tool.mock.wasCalledWith({ test: 'value' })).toBe(true);
      expect(tool.mock.wasCalledWith({ test: 'other' })).toBe(false);
    });

    it('should reset call history', async () => {
      const tool = MockToolFactory.createSimpleTool(
        'reset_tool',
        'Reset tool',
        'Result',
      );

      await tool.invoke(new RunContext({}), '{}');
      expect(tool.mock.getCallCount()).toBe(1);

      tool.mock.resetCalls();
      expect(tool.mock.getCallCount()).toBe(0);
      expect(tool.mock.getCalls()).toHaveLength(0);
    });
  });
});
