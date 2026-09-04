import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, run, tool, Usage } from '../../src';
import * as protocol from '../../src/types/protocol';
import {
  ScriptedModel,
  assistantMessage,
  modelResponse,
} from '../../src/testing';

describe('needsApproval runtime validation', () => {
  it('rejects a non-boolean function-tool approval result before execution', async () => {
    const execute = vi.fn(async () => 'executed');
    const guarded = tool({
      name: 'guarded',
      description: 'guarded operation',
      parameters: z.object({}),
      needsApproval: (async () => undefined) as any,
      execute,
    });
    const call: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_1',
      callId: 'call_1',
      name: guarded.name,
      status: 'completed',
      arguments: '{}',
    };
    const model = new ScriptedModel([
      modelResponse({ output: [call], usage: new Usage() }),
      modelResponse({
        output: [assistantMessage('unexpected continuation')],
        usage: new Usage(),
      }),
    ]);
    const agent = new Agent({ name: 'approval-test', model, tools: [guarded] });

    await expect(run(agent, 'run it')).rejects.toThrow(
      'Failed to run function tools: UserError: needsApproval for tool guarded must return a boolean.',
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
