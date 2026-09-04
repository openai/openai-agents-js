import { describe, expect, it } from 'vitest';

import {
  Agent,
  RunContext,
  UserError,
  defineToolInputGuardrail,
  defineToolOutputGuardrail,
  runToolInputGuardrails,
  runToolOutputGuardrails,
} from '../src';
import type { ToolGuardrailFunctionOutput } from '../src/toolGuardrail';
import type * as protocol from '../src/types/protocol';

const toolCall: protocol.FunctionCallItem = {
  type: 'function_call',
  id: 'function-1',
  callId: 'call-1',
  name: 'dangerous',
  status: 'completed',
  arguments: '{}',
};

const invalidOutput = {
  behavior: { type: 'unknown' },
} as unknown as ToolGuardrailFunctionOutput;

describe('tool guardrail behavior validation', () => {
  it('rejects an unknown input guardrail behavior', async () => {
    await expect(
      runToolInputGuardrails({
        guardrails: [
          defineToolInputGuardrail({
            name: 'policy',
            run: async () => invalidOutput,
          }),
        ],
        context: new RunContext(),
        agent: new Agent({ name: 'test' }),
        toolCall,
      }),
    ).rejects.toBeInstanceOf(UserError);
  });

  it('rejects an unknown output guardrail behavior', async () => {
    await expect(
      runToolOutputGuardrails({
        guardrails: [
          defineToolOutputGuardrail({
            name: 'policy',
            run: async () => invalidOutput,
          }),
        ],
        context: new RunContext(),
        agent: new Agent({ name: 'test' }),
        toolCall,
        toolOutput: 'sensitive output',
      }),
    ).rejects.toBeInstanceOf(UserError);
  });
  it('rejects rejectContent without a string message', async () => {
    const malformedOutput = {
      behavior: { type: 'rejectContent' },
    } as unknown as ToolGuardrailFunctionOutput;

    await expect(
      runToolInputGuardrails({
        guardrails: [
          defineToolInputGuardrail({
            name: 'policy',
            run: async () => malformedOutput,
          }),
        ],
        context: new RunContext(),
        agent: new Agent({ name: 'test' }),
        toolCall,
      }),
    ).rejects.toBeInstanceOf(UserError);
  });
});
