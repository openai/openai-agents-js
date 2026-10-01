import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, Runner, type protocol } from '@openai/agents';
import { ScriptedModel, assistantMessage } from '@openai/agents/testing';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  question: vi.fn(),
  closePrompt: vi.fn(),
  closeBrowser: vi.fn(),
  mouse: {
    click: vi.fn(),
    dblclick: vi.fn(),
    move: vi.fn(),
    down: vi.fn(),
    up: vi.fn(),
  },
}));

vi.mock('@openai/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openai/agents')>()),
  run: mocks.run,
  withTrace: async (_name: string, callback: () => Promise<unknown>) =>
    callback(),
}));

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: mocks.question,
    close: mocks.closePrompt,
  }),
}));

vi.mock('playwright', () => ({
  chromium: {
    launch: async () => ({
      close: mocks.closeBrowser,
      newPage: async () => ({
        setViewportSize: async () => {},
        setContent: async () => {},
        waitForLoadState: async () => {},
        screenshot: async () => Buffer.from('synthetic screenshot'),
        mouse: mocks.mouse,
      }),
    }),
  },
}));

describe.each(['singletonComputer', 'computerPerRequest'] as const)(
  '%s approval policy',
  (mode) => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.resetModules();
      vi.stubEnv('AUTO_APPROVE_HITL', '0');
      vi.stubEnv('COMPUTER_USE_START_URL', '');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mocks.question.mockImplementation(async () => {
        for (const mouseOperation of Object.values(mocks.mouse)) {
          expect(mouseOperation).not.toHaveBeenCalled();
        }
        return 'yes';
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    async function runExample(
      actions: protocol.ComputerAction[],
      batched = false,
    ) {
      const model = new ScriptedModel([
        [
          {
            type: 'computer_call',
            callId: 'synthetic-computer-call',
            status: 'completed',
            ...(batched ? { actions } : { action: actions[0] }),
          },
        ],
        [assistantMessage('Done')],
      ]);
      const runner = new Runner({ tracingDisabled: true });
      let configuredAgent: Agent | undefined;
      mocks.run.mockImplementation((agent, input) => {
        configuredAgent ??= agent.clone({ model });
        return runner.run(configuredAgent!, input);
      });
      const example = await import('./computer-use-hitl');
      // Importing an example for testing must not start a model/browser run.
      expect(mocks.run).not.toHaveBeenCalled();
      await example[mode]();
      model.assertComplete();
      expect(mocks.closeBrowser).toHaveBeenCalledOnce();
    }

    const pointerActions: protocol.ComputerAction[] = [
      { type: 'click', x: 10, y: 20, button: 'left' },
      { type: 'double_click', x: 10, y: 20 },
      {
        type: 'drag',
        path: [
          { x: 10, y: 20 },
          { x: 30, y: 40 },
        ],
      },
    ];

    it.each(pointerActions)(
      'waits for approval before $type',
      async (action) => {
        await runExample([action]);
        expect(mocks.question).toHaveBeenCalledOnce();
        expect(mocks.closePrompt).toHaveBeenCalledOnce();
        expect(mocks.run).toHaveBeenCalledTimes(2);
        if (action.type === 'click') {
          expect(mocks.mouse.click).toHaveBeenCalledExactlyOnceWith(10, 20, {
            button: 'left',
          });
        } else if (action.type === 'double_click') {
          expect(mocks.mouse.dblclick).toHaveBeenCalledExactlyOnceWith(10, 20);
        } else {
          expect(mocks.mouse.down).toHaveBeenCalledOnce();
          expect(mocks.mouse.up).toHaveBeenCalledOnce();
          expect(mocks.mouse.move.mock.calls).toEqual([
            [10, 20],
            [30, 40],
          ]);
        }
      },
    );

    it.each(pointerActions)(
      'does not dispatch rejected $type',
      async (action) => {
        mocks.question.mockResolvedValue('no');
        await runExample([action]);
        expect(mocks.question).toHaveBeenCalledOnce();
        expect(mocks.run).toHaveBeenCalledTimes(2);
        for (const mouseOperation of Object.values(mocks.mouse)) {
          expect(mouseOperation).not.toHaveBeenCalled();
        }
      },
    );

    it('pauses the entire batch before a later double click', async () => {
      await runExample(
        [
          { type: 'move', x: 1, y: 2 },
          { type: 'double_click', x: 10, y: 20 },
        ],
        true,
      );
      expect(mocks.question).toHaveBeenCalledOnce();
      expect(mocks.mouse.move).toHaveBeenCalledExactlyOnceWith(1, 2);
      expect(mocks.mouse.dblclick).toHaveBeenCalledExactlyOnceWith(10, 20);
    });

    it('allows a pointer move without prompting', async () => {
      await runExample([{ type: 'move', x: 1, y: 2 }]);
      expect(mocks.question).not.toHaveBeenCalled();
      expect(mocks.run).toHaveBeenCalledOnce();
      expect(mocks.mouse.move).toHaveBeenCalledExactlyOnceWith(1, 2);
    });
  },
);
