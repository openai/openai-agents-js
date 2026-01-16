import { describe, test, expect } from 'vitest';
import {
  InputGuardrailTripwireTriggered,
  MaxTurnsExceededError,
  ModelBehaviorError,
  OutputGuardrailTripwireTriggered,
  UserError,
  GuardrailExecutionError,
  ToolCallError,
} from '../src';

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
});
