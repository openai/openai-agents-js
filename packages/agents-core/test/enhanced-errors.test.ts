import { describe, it, expect } from 'vitest';
import {
  SystemError,
  UserError,
  MaxTurnsExceededError,
  ModelBehaviorError,
  ToolCallError,
  GuardrailExecutionError,
  AgentDebugger,
  createErrorContext,
  addOperationToContext,
} from '../src/errors';
import { Agent } from '../src/agent';
import { RunState } from '../src/runState';
import { RunContext } from '../src/runContext';

describe('Enhanced Error Handling', () => {
  const mockAgent = new Agent({
    name: 'test-agent',
    instructions: 'Test instructions',
  });

  const mockContext = new RunContext(undefined);
  const mockState = new RunState(mockContext, 'test input', mockAgent, 10);

  describe('EnhancedErrorContext', () => {
    it('should create error context with operation tracking', () => {
      const context = createErrorContext('test_operation', mockState, {
        operationStack: ['previous_op'],
      });

      expect(context.lastSuccessfulOperation).toBe('test_operation');
      expect(context.operationStack).toEqual(['previous_op', 'test_operation']);
      expect(context.timestamp).toBeInstanceOf(Date);
    });

    it('should add operations to existing context', () => {
      const initialContext = createErrorContext('first_op');
      const updatedContext = addOperationToContext(initialContext, 'second_op');

      expect(updatedContext.operationStack).toEqual(['first_op', 'second_op']);
      expect(updatedContext.lastSuccessfulOperation).toBe('second_op');
    });
  });

  describe('Enhanced Error Classes', () => {
    it('should create SystemError with enhanced context', () => {
      const error = new SystemError(
        'Test system error',
        mockState,
        createErrorContext('system_operation', mockState),
      );

      expect(error.message).toContain('Test system error');
      expect(error.message).toContain('Agent: test-agent');
      expect(error.message).toContain('Turn: 0');
      expect(error.context?.agentName).toBe('test-agent');
      expect(error.context?.lastSuccessfulOperation).toBe('system_operation');
      expect(error.suggestions).toHaveLength(1);
      expect(error.suggestions[0].type).toBe('manual');
    });

    it('should create MaxTurnsExceededError with suggestions', () => {
      const error = new MaxTurnsExceededError(
        'Max turns exceeded',
        mockState,
        createErrorContext('turn_check', mockState),
      );

      expect(error.suggestions).toHaveLength(1);
      expect(error.suggestions[0].description).toContain('maxTurns');
    });

    it('should create ToolCallError with tool context', () => {
      const toolError = new Error('Tool execution failed');
      const error = new ToolCallError(
        'Tool call failed',
        toolError,
        mockState,
        {
          ...createErrorContext('tool_execution', mockState),
          toolName: 'test-tool',
          toolArguments: { arg1: 'value1' },
        },
      );

      expect(error.toolName).toBe('test-tool');
      expect(error.toolArguments).toEqual({ arg1: 'value1' });
      expect(error.suggestions).toHaveLength(2);
      expect(error.suggestions[0].description).toContain('test-tool');
    });

    it('should create GuardrailExecutionError with guardrail context', () => {
      const guardrailError = new Error('Guardrail failed');
      const error = new GuardrailExecutionError(
        'Guardrail execution failed',
        guardrailError,
        mockState,
        {
          ...createErrorContext('guardrail_execution', mockState),
          guardrailName: 'test-guardrail',
          guardrailType: 'input',
        },
      );

      expect(error.guardrailName).toBe('test-guardrail');
      expect(error.guardrailType).toBe('input');
      expect(error.suggestions).toHaveLength(2);
    });
  });

  describe('AgentDebugger', () => {
    it('should create detailed debug report', () => {
      const error = new SystemError(
        'Test error',
        mockState,
        createErrorContext('test_operation', mockState),
      );

      const report = AgentDebugger.createDebugReport(error);

      expect(report).toContain('AGENT ERROR DEBUG REPORT');
      expect(report).toContain('Error Type: SystemError');
      expect(report).toContain('Agent: test-agent');
      expect(report).toContain('Turn: 0');
      expect(report).toContain('Last Operation: test_operation');
      expect(report).toContain('RECOVERY SUGGESTIONS');
    });

    it('should extract state info', () => {
      const stateInfo = AgentDebugger.extractStateInfo(mockState);

      expect(stateInfo.agentName).toBe('test-agent');
      expect(stateInfo.currentTurn).toBe(0);
      expect(stateInfo.maxTurns).toBe(10);
      expect(stateInfo.generatedItemsCount).toBe(0);
      expect(stateInfo.hasActiveRun).toBe(false);
    });

    it('should sanitize state for logging', () => {
      const sanitized = AgentDebugger.sanitizeStateForLogging(mockState);

      expect(sanitized.agentName).toBe('test-agent');
      expect(sanitized.toolUseTracker).toBeUndefined();
      expect(sanitized.hasToolUsage).toBe(false);
      expect(sanitized.recentItems).toEqual([]);
    });

    it('should validate run state', () => {
      const issues = AgentDebugger.validateRunState(mockState);
      expect(issues).toEqual([]);

      // Test with invalid state
      const invalidState = new RunState(mockContext, 'test', mockAgent, 5);
      invalidState._currentTurn = -1;
      const invalidIssues = AgentDebugger.validateRunState(invalidState);
      expect(invalidIssues).toContain('Current turn is negative');
    });
  });

  describe('Error Message Enhancement', () => {
    it('should enhance error messages with context', () => {
      const error = new UserError(
        'Configuration error',
        mockState,
        createErrorContext('config_validation', mockState),
      );

      expect(error.message).toContain('Configuration error');
      expect(error.message).toContain(
        '[Agent: test-agent, Turn: 0, Last operation: config_validation]',
      );
    });

    it('should provide debug info', () => {
      const error = new ModelBehaviorError(
        'Unexpected model behavior',
        mockState,
        createErrorContext('model_response_processing', mockState),
      );

      const debugInfo = error.getDebugInfo();
      expect(debugInfo).toContain('Error: Unexpected model behavior');
      expect(debugInfo).toContain('Type: ModelBehaviorError');
      expect(debugInfo).toContain('Context:');
      expect(debugInfo).toContain('Suggestions:');
    });
  });
});
