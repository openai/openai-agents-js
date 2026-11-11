import { expect, it } from 'vitest';
import {
  Agent,
  ComputerSafetyError,
  computerTool,
  type Computer,
} from '@openai/agents';
import {
  computerCall,
  text,
  withScriptedResponses,
} from '@openai/agents/testing';
import type { JsonObject } from '../../src/runtime/binding';

it('executes scripted actions and replays the native screenshot continuation', async () => {
  const actions: JsonObject[] = [
    { type: 'click', x: 1, y: 2, button: 'left' },
    { type: 'screenshot' },
  ];
  const checks = [
    { id: 'synthetic-check', code: 'domain', message: 'confirm' },
  ];
  const item = computerCall(actions, {
    callId: 'computer-1',
    itemId: 'cu_script',
    pendingSafetyChecks: checks,
  });
  actions[0].x = 99;
  checks[0].message = 'later mutation';
  const calls: unknown[] = [],
    disposed: Computer[] = [];
  const unexpected = () => {
    throw new Error('Unexpected action');
  };
  const driver: Computer = {
    click: (x, y, button) => {
      calls.push(['click', x, y, button]);
    },
    screenshot: () => {
      calls.push(['screenshot']);
      return 'aA==';
    },
    doubleClick: unexpected,
    scroll: unexpected,
    type: unexpected,
    wait: unexpected,
    move: unexpected,
    keypress: unexpected,
    drag: unexpected,
  };
  await withScriptedResponses(
    [[item], [text('clicked')], [text('remembered')]],
    async (peer) => {
      const agent = new Agent({
        instructions: 'Use the computer.',
        model: 'gpt-5',
        provider: peer.provider,
        tools: [
          computerTool({
            computer: {
              create: () => driver,
              dispose: (computer) => {
                disposed.push(computer);
              },
            },
            onSafetyCheck: () => true,
          }),
        ],
      });
      const session = await agent.session();
      try {
        expect(
          (await (await session.submit('Click.')).wait()).finalOutput,
        ).toBe('clicked');
        const history = await Array.fromAsync(session.items());
        expect(
          history.find((item) => item.type === 'function_call'),
        ).toMatchObject({
          name: 'computer',
          callId: 'computer-1',
          arguments: {
            type: 'computer_call',
            actions: [
              { type: 'click', x: 1, y: 2, button: 'left' },
              { type: 'screenshot' },
            ],
          },
        });
        expect(
          (await (await session.submit('Remember.')).wait()).finalOutput,
        ).toBe('remembered');
      } finally {
        await session.close();
      }
      for (const request of peer.requests.slice(1)) {
        const output = (request.input as Record<string, unknown>[]).find(
          (item) => item.type === 'computer_call_output',
        )!;
        expect(output.call_id).toBe('computer-1');
        expect(output.output).toEqual({
          type: 'computer_screenshot',
          image_url: 'data:image/png;base64,aA==',
        });
        expect(output.acknowledged_safety_checks).toEqual([
          { id: 'synthetic-check', code: 'domain', message: 'confirm' },
        ]);
      }
      expect(calls).toEqual([['click', 1, 2, 'left'], ['screenshot']]);
      expect(disposed).toEqual([driver]);
    },
  );
});

it('preserves native safety rejection before acquiring a scripted computer', async () => {
  const created: unknown[] = [];
  await withScriptedResponses(
    [
      [
        computerCall([{ type: 'screenshot' }], {
          callId: 'denied',
          pendingSafetyChecks: [{ id: 'deny', message: 'confirm' }],
        }),
      ],
    ],
    async (peer) => {
      const agent = new Agent({
        instructions: 'Use the computer.',
        model: 'gpt-5',
        provider: peer.provider,
        tools: [
          computerTool({
            computer: {
              create: () => {
                created.push(true);
                throw new Error('Unexpected acquisition');
              },
            },
          }),
        ],
      });
      await expect(agent.run('Look.')).rejects.toBeInstanceOf(
        ComputerSafetyError,
      );
      expect(created).toEqual([]);
    },
  );
});
