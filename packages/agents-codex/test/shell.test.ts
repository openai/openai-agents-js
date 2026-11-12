import { projectHostedToolItem } from '../src/runtime/history';
import { expect, it } from 'vitest';
import { Agent, NativeProvider, shellTool, ToolOutput } from '../src';

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

it.each(['shell_call', 'shell_call_output'] as const)(
  'retains %s without a provider item ID',
  (type) => {
    const raw = {
      type,
      call_id: 'stable-call',
      status: 'completed',
      ...(type === 'shell_call'
        ? { action: { commands: ['application'] } }
        : { output: [] }),
    };
    const projected = projectHostedToolItem(raw, 'turn');
    expect(projected).toMatchObject({
      id: type === 'shell_call' ? 'stable-call' : 'stable-call:output',
      type,
    });
    expect(projected?.provider_data).toEqual(raw);
    expect(raw).not.toHaveProperty('id');
  },
);

it('rejects Shell on the function-only registered route before requesting credentials', async () => {
  let credentials = 0;
  let effects = 0;
  await using provider = new NativeProvider({
    signInWithChatGPT: {
      getCredential: async () => {
        credentials++;
        throw new Error('Credential source must remain unused');
      },
    },
  });
  const agent = new Agent({
    provider,
    instructions: 'Use the application Shell.',
    tools: [
      shellTool({
        execute() {
          effects++;
          return { output: [] };
        },
      }),
    ],
  });
  await expect(agent.run('Execute.')).rejects.toThrow(
    /direct local function tools and settled state/,
  );
  expect(credentials).toBe(0);
  expect(effects).toBe(0);
});
