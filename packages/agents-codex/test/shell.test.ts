import { expect, it } from 'vitest';
import { shellTool, ToolOutput } from '../src';

it('rejects a generic output transformation before any application effect', () => {
  let effects = 0;
  expect(() =>
    shellTool({
      execute() {
        effects++;
        return { output: [] };
      },
      // @ts-expect-error Shell output transformations belong in the typed executor.
      after: () => ToolOutput.text('redacted'),
    }),
  ).toThrow('Shell output transformations belong in the executor');
  expect(effects).toBe(0);
});

it('captures callbacks from application option objects without changing their output', async () => {
  const { invokeFunctionTool } = await import('../src/runtime/tools');
  const result = {
    output: [
      {
        stdout: 'captured',
        stderr: '',
        outcome: { type: 'exit' as const, exit_code: 0 },
      },
    ],
  };
  class Settings {
    execute() {
      return result;
    }
  }
  const selected = shellTool(new Settings());
  const response = await invokeFunctionTool(
    selected,
    {
      type: 'shell_call',
      call_id: 'call',
      action: { commands: ['printf captured'] },
    },
    {
      context: undefined,
      submission: {
        sessionId: 's',
        childId: 'c',
        instanceId: '1',
        turnId: 't',
        submissionId: 'r',
      },
      threadId: 's',
      turnId: 't',
      callId: 'call',
      signal: new AbortController().signal,
    },
    () => {},
  );
  expect(response).toEqual({
    success: true,
    contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
  });
});
