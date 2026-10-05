import { describe, expect, it, vi } from 'vitest';
import {
  Agent,
  Runner,
  Usage,
  computerTool,
  type ComputerTool,
  type RunContext,
  type RunItem,
  type Computer,
} from '../src';
import { ScriptedModel, modelResponder, modelResponse } from '../src/testing';
import { FakeComputer, fakeModelMessage } from './stubs';

function actionResponse(text: string) {
  return modelResponse({
    usage: new Usage(),
    output: [
      {
        type: 'computer_call',
        callId: `call-${text}`,
        status: 'completed',
        action: { type: 'type', text },
      },
    ],
  });
}

function expectScreenshot(result: { newItems: RunItem[] }, data: string) {
  const item = result.newItems.find(
    (item) => item.rawItem.type === 'computer_call_result',
  );
  expect(item?.rawItem).toMatchObject({
    output: {
      type: 'computer_screenshot',
      data: `data:image/png;base64,${data}`,
    },
  });
}

describe('computer initializer isolation through Runner', () => {
  it('retains a directly configured function initializer across completed runs', async () => {
    const computers = [new FakeComputer(), new FakeComputer()];
    const screenshots = ['Zmlyc3Q=', 'c2Vjb25k'];
    for (const [index, computer] of computers.entries()) {
      computer.screenshot = vi.fn(async () => screenshots[index]);
      computer.type = vi.fn();
    }
    const create = vi.fn(
      ({ runContext }: { runContext: RunContext<string> }) =>
        computers[runContext.context === 'first' ? 0 : 1],
    );
    const tool: ComputerTool<string> = {
      type: 'computer',
      name: 'computer_use_preview',
      computer: create,
      needsApproval: async () => false,
    };
    const agent = new Agent<string>({
      name: 'Computer',
      tools: [tool],
      model: new ScriptedModel([
        actionResponse('first'),
        modelResponse({
          output: [fakeModelMessage('done')],
          usage: new Usage(),
        }),
        actionResponse('second'),
        modelResponse({
          output: [fakeModelMessage('done')],
          usage: new Usage(),
        }),
      ]),
    });
    const runner = new Runner({ tracingDisabled: true });
    const first = await runner.run(agent, 'act', { context: 'first' });
    const second = await runner.run(agent, 'act', { context: 'second' });

    expect(create).toHaveBeenCalledTimes(2);
    expect(computers[0].type).toHaveBeenCalledExactlyOnceWith(
      'first',
      expect.anything(),
    );
    expect(computers[1].type).toHaveBeenCalledExactlyOnceWith(
      'second',
      expect.anything(),
    );
    expectScreenshot(first, screenshots[0]);
    expectScreenshot(second, screenshots[1]);
    expect(tool.computer).toBe(create);
  });

  it.each(['direct', 'copy', 'factory'] as const)(
    'isolates overlapping runs and cleanup for a %s provider tool',
    async (construction) => {
      const computers = {
        first: new FakeComputer(),
        second: new FakeComputer(),
      };
      const closed = new Set<Computer>();
      for (const [label, computer] of Object.entries(computers)) {
        computer.type = vi.fn(async () => {
          expect(closed.has(computer)).toBe(false);
        });
        computer.screenshot = vi.fn(async () => {
          expect(closed.has(computer)).toBe(false);
          return label === 'first' ? 'Zmlyc3Q=' : 'c2Vjb25k';
        });
      }
      const provider = {
        create: vi.fn(({ runContext }: { runContext: RunContext<string> }) =>
          runContext.context === 'first' ? computers.first : computers.second,
        ),
        dispose: vi.fn(async ({ computer }: { computer: Computer }) => {
          closed.add(computer);
        }),
      };
      const tool: ComputerTool<string> =
        construction === 'direct'
          ? {
              type: 'computer',
              name: 'computer_use_preview',
              computer: provider,
              needsApproval: async () => false,
            }
          : construction === 'copy'
            ? { ...computerTool<string>({ computer: provider }) }
            : computerTool<string>({ computer: provider });
      let firstReady!: () => void;
      let releaseFirst!: () => void;
      const ready = new Promise<void>((resolve) => {
        firstReady = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstAgent = new Agent<string>({
        name: 'First',
        tools: [tool],
        model: new ScriptedModel([
          actionResponse('first'),
          modelResponder(async () => {
            firstReady();
            await released;
            return { output: [fakeModelMessage('done')], usage: new Usage() };
          }),
        ]),
      });
      const secondAgent = new Agent<string>({
        name: 'Second',
        tools: [tool],
        model: new ScriptedModel([
          actionResponse('second'),
          modelResponse({
            output: [fakeModelMessage('done')],
            usage: new Usage(),
          }),
        ]),
      });
      const runner = new Runner({ tracingDisabled: true });
      const firstRun = runner.run(firstAgent, 'act', { context: 'first' });
      try {
        await ready;
        const second = await runner.run(secondAgent, 'act', {
          context: 'second',
        });
        expectScreenshot(second, 'c2Vjb25k');
        expect(closed).toEqual(new Set([computers.second]));
        expect(provider.dispose).toHaveBeenCalledExactlyOnceWith({
          runContext: second.state._context,
          computer: computers.second,
        });
      } finally {
        releaseFirst();
        await firstRun;
      }
      const first = await firstRun;
      expectScreenshot(first, 'Zmlyc3Q=');
      expect(provider.create).toHaveBeenCalledTimes(2);
      expect(provider.dispose).toHaveBeenCalledTimes(2);
      expect(provider.dispose).toHaveBeenLastCalledWith({
        runContext: first.state._context,
        computer: computers.first,
      });
      expect(computers.first.type).toHaveBeenCalledExactlyOnceWith(
        'first',
        expect.anything(),
      );
      expect(computers.second.type).toHaveBeenCalledExactlyOnceWith(
        'second',
        expect.anything(),
      );
      expect(closed).toEqual(new Set(Object.values(computers)));
      expect(tool.computer).toBe(provider);
    },
  );
});
