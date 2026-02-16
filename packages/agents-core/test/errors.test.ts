import { describe, test, expect } from 'vitest';
import {
  InputGuardrailTripwireTriggered,
  MaxTurnsExceededError,
  ModelBehaviorError,
  OutputGuardrailTripwireTriggered,
  UserError,
  GuardrailExecutionError,
  ToolCallError,
  ToolTimeoutError,
  ToolInputGuardrailTripwireTriggered,
  ToolOutputGuardrailTripwireTriggered,
  SystemError,
} from '../src';
import { InvalidToolInputError } from '../src/errors';

describe('errors', () => {
  test('should be initialized', () => {
    expect(() => {
      throw new MaxTurnsExceededError('Test error', {} as any);
    }).toThrow('Test error');
    expect(() => {
      throw new ModelBehaviorError('Test error', {} as any);
    }).toThrow('Test error');
    expect(() => {
      throw new UserError('Test error', {} as any);
    }).toThrow('Test error');
    expect(() => {
      throw new InputGuardrailTripwireTriggered(
        'Test error',
        {} as any,
        {} as any,
      );
    }).toThrow('Test error');
    expect(() => {
      throw new OutputGuardrailTripwireTriggered(
        'Test error',
        {} as any,
        {} as any,
      );
    }).toThrow('Test error');
    const cause = new Error('cause');
    const guardrailError = new GuardrailExecutionError(
      'Test error',
      cause,
      {} as any,
    );
    expect(guardrailError.error).toBe(cause);
    expect(() => {
      throw guardrailError;
    }).toThrow('Test error');
    const toolCallError = new ToolCallError('Test error', cause, {} as any);
    expect(toolCallError.error).toBe(cause);
    expect(() => {
      throw toolCallError;
    }).toThrow('Test error');
  });

  test('should set error names', () => {
    expect(new MaxTurnsExceededError('Test error', {} as any).name).toBe(
      'MaxTurnsExceededError',
    );
    expect(new ModelBehaviorError('Test error', {} as any).name).toBe(
      'ModelBehaviorError',
    );
    expect(new UserError('Test error', {} as any).name).toBe('UserError');
    expect(
      new InputGuardrailTripwireTriggered('Test error', {} as any, {} as any)
        .name,
    ).toBe('InputGuardrailTripwireTriggered');
    expect(
      new OutputGuardrailTripwireTriggered('Test error', {} as any, {} as any)
        .name,
    ).toBe('OutputGuardrailTripwireTriggered');
    expect(
      new GuardrailExecutionError('Test error', new Error('cause'), {} as any)
        .name,
    ).toBe('GuardrailExecutionError');
    expect(
      new ToolCallError('Test error', new Error('cause'), {} as any).name,
    ).toBe('ToolCallError');
  });

  test('captures tool invocation and original errors', () => {
    const originalError = new Error('invalid input');
    const toolInvocation = {
      input: '{"bad": true}',
      details: { resumeState: 'resume_123' },
    };
    const error = new InvalidToolInputError(
      'Tool input invalid',
      { id: 'state' } as any,
      originalError,
      toolInvocation,
    );

    expect(error).toBeInstanceOf(ModelBehaviorError);
    expect(error.originalError).toBe(originalError);
    expect(error.toolInvocation).toEqual(toolInvocation);
    expect(error.state).toEqual({ id: 'state' });
  });

  test('adds context to tool timeout errors', () => {
    const error = new ToolTimeoutError({
      toolName: 'fetch',
      timeoutMs: 1200,
      state: { id: 'state' } as any,
    });

    expect(error.toolName).toBe('fetch');
    expect(error.timeoutMs).toBe(1200);
    expect(error.message).toBe("Tool 'fetch' timed out after 1200ms.");
    expect(error.state).toEqual({ id: 'state' });
  });

  test('stores guardrail tripwire results', () => {
    const inputResult = {
      guardrail: { type: 'tool_input', name: 'input' },
      output: { tripwireTriggered: true, outputInfo: { score: 1 } },
      tool: { name: 'tool' },
      input: { payload: true },
    } as any;
    const outputResult = {
      guardrail: { type: 'tool_output', name: 'output' },
      output: { tripwireTriggered: true, outputInfo: { score: 2 } },
      tool: { name: 'tool' },
      toolOutput: { ok: false },
    } as any;

    const inputError = new ToolInputGuardrailTripwireTriggered(
      'Input guardrail tripped',
      inputResult,
      { id: 'state' } as any,
    );
    const outputError = new ToolOutputGuardrailTripwireTriggered(
      'Output guardrail tripped',
      outputResult,
      { id: 'state' } as any,
    );

    expect(inputError.result).toBe(inputResult);
    expect(outputError.result).toBe(outputResult);
  });

  test('sets name for system error', () => {
    expect(new SystemError('System failure', {} as any).name).toBe(
      'SystemError',
    );
  });
});
