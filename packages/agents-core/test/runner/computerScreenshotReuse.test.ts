import { beforeAll, describe, expect, it, vi } from 'vitest';

import { setDefaultModelProvider, setTracingDisabled } from '../../src';
import { Agent } from '../../src/agent';
import { Runner } from '../../src/run';
import { RunContext } from '../../src/runContext';
import { executeComputerActions } from '../../src/runner/toolExecution';
import { computerTool } from '../../src/tool';
import type * as protocol from '../../src/types/protocol';
import { ScriptedModelProvider } from '../stubs';

beforeAll(() => {
  setTracingDisabled(true);
  setDefaultModelProvider(new ScriptedModelProvider());
});

function createComputer(screenshot: ReturnType<typeof vi.fn>) {
  return {
    environment: 'mac',
    dimensions: [1, 1] as [number, number],
    screenshot,
    click: vi.fn(),
    doubleClick: vi.fn(),
    drag: vi.fn(),
    keypress: vi.fn(),
    move: vi.fn(),
    scroll: vi.fn(),
    type: vi.fn(),
    wait: vi.fn(),
  } as any;
}

async function execute(toolCall: protocol.ComputerUseCallItem, computer: any) {
  const tool = computerTool({ computer });
  return executeComputerActions(
    new Agent({ name: 'Computer' }),
    [{ toolCall, computer: tool }],
    new Runner(),
    new RunContext(),
  );
}

describe('computer screenshot observations', () => {
  it('reuses an explicit screenshot as the returned observation', async () => {
    const screenshot = vi
      .fn()
      .mockResolvedValueOnce('requested')
      .mockResolvedValueOnce('unexpected-second-capture');
    const computer = createComputer(screenshot);
    const toolCall: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'screenshot-call',
      status: 'completed',
      action: { type: 'screenshot' },
    };

    const items = await execute(toolCall, computer);

    expect(screenshot).toHaveBeenCalledTimes(1);
    expect((items[0] as any).output).toBe(
      'data:image/png;base64,requested',
    );
  });

  it('takes a fresh observation after a later non-screenshot action', async () => {
    const screenshot = vi
      .fn()
      .mockResolvedValueOnce('before')
      .mockResolvedValueOnce('after');
    const computer = createComputer(screenshot);
    const toolCall: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'screenshot-then-click',
      status: 'completed',
      actions: [
        { type: 'screenshot' },
        { type: 'click', x: 1, y: 2, button: 'left' },
      ],
    };

    const items = await execute(toolCall, computer);

    expect(computer.click).toHaveBeenCalledTimes(1);
    expect(screenshot).toHaveBeenCalledTimes(2);
    expect((items[0] as any).output).toBe('data:image/png;base64,after');
  });
});
