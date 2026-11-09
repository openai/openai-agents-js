import { describe, expect, it, vi } from 'vitest';
import {
  computerTool,
  closeComputerResources,
  ComputerSafetyError,
  type Computer,
} from '../../src/runtime/computer';
import {
  captureTools,
  invokeFunctionTool,
  registerToolSessionOwner,
} from '../../src/runtime/tools';

function context(owner: object, signal = new AbortController().signal) {
  const value = {
    context: undefined,
    submission: {
      sessionId: 'root',
      childId: 'child',
      instanceId: '1',
      turnId: 't',
      submissionId: 's',
    },
    threadId: 'root',
    turnId: 't',
    callId: 'c',
    signal,
  };
  registerToolSessionOwner(value, owner);
  return value;
}
function driver() {
  const calls: unknown[][] = [];
  const device: Computer = {
    initRun() {
      calls.push(['init']);
    },
    screenshot() {
      calls.push(['screenshot']);
      return 'aA==';
    },
    click(x, y, button) {
      calls.push(['click', x, y, button]);
    },
    doubleClick(x, y) {
      calls.push(['double_click', x, y]);
    },
    scroll(x, y, sx, sy) {
      calls.push(['scroll', x, y, sx, sy]);
    },
    type(text) {
      calls.push(['type', text]);
    },
    wait() {
      calls.push(['wait']);
    },
    move(x, y) {
      calls.push(['move', x, y]);
    },
    keypress(keys) {
      calls.push(['keypress', keys]);
    },
    drag(path) {
      calls.push(['drag', path]);
    },
  };
  return { device, calls };
}
const call = (fields = {}) => ({
  type: 'computer_call',
  call_id: 'c',
  ...fields,
});
const invoke = (
  tool: ReturnType<typeof computerTool>,
  owner: object,
  fields = {},
  signal?: AbortSignal,
) => invokeFunctionTool(tool, call(fields), context(owner, signal), () => {});

describe('native computer callback adapter', () => {
  it('publishes dedicated GA and preview declarations', () => {
    const { device } = driver();
    expect(
      JSON.parse(captureTools([computerTool({ computer: device })]).specsJson),
    ).toEqual([{ type: 'computer', toolType: 'computer' }]);
    expect(
      JSON.parse(
        captureTools([
          computerTool({
            computer: device,
            toolType: 'computer_use_preview',
            dimensions: [800, 600],
            environment: 'browser',
          }),
        ]).specsJson,
      ),
    ).toEqual([
      {
        type: 'computer',
        toolType: 'computer_use_preview',
        displayWidth: 800,
        displayHeight: 600,
        environment: 'browser',
      },
    ]);
    expect(() =>
      computerTool({ computer: device, toolType: 'computer_use_preview' }),
    ).toThrow('dimensions');
  });

  it('executes every action in order and reuses a final screenshot', async () => {
    const { device, calls } = driver();
    const owner = {};
    const actions = [
      { type: 'click', x: 1, y: 2, button: 'left' },
      { type: 'double_click', x: 1, y: 2 },
      { type: 'scroll', x: 1, y: 2, scroll_x: 3, scroll_y: 4 },
      { type: 'type', text: 'hello' },
      { type: 'wait' },
      { type: 'move', x: 1, y: 2 },
      { type: 'keypress', keys: ['CTRL', 'C'] },
      {
        type: 'drag',
        path: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      },
      { type: 'screenshot' },
    ];
    const result = await invoke(computerTool({ computer: device }), owner, {
      actions,
    });
    expect(calls.map(([name]) => name)).toEqual([
      'init',
      ...actions.map(({ type }) => type),
    ]);
    expect(calls.at(-2)).toEqual([
      'drag',
      [
        [1, 2],
        [3, 4],
      ],
    ]);
    expect(
      JSON.parse((result.contentItems[0] as { text: string }).text),
    ).toEqual({
      output: {
        type: 'computer_screenshot',
        image_url: 'data:image/png;base64,aA==',
      },
      acknowledged_safety_checks: [],
    });
    await closeComputerResources(owner);
  });

  it('preserves preview action fallback, GA precedence and screenshot-only calls', async () => {
    const { device, calls } = driver();
    const owner = {},
      tool = computerTool({ computer: device });
    await invoke(tool, owner, { action: { type: 'wait' }, actions: [] });
    await invoke(tool, owner, {
      action: { type: 'wait' },
      actions: [{ type: 'screenshot' }],
    });
    await invoke(tool, owner);
    expect(calls.map(([name]) => name)).toEqual([
      'init',
      'wait',
      'screenshot',
      'screenshot',
      'screenshot',
    ]);
    await closeComputerResources(owner);
  });

  it.each([undefined, () => false, () => 1])(
    'fails closed before acquisition with policy %s',
    async (onSafetyCheck) => {
      const create = vi.fn(() => driver().device);
      const tool = computerTool({
        computer: { create },
        onSafetyCheck: onSafetyCheck as (() => boolean) | undefined,
      });
      await expect(
        invoke(tool, {}, { pending_safety_checks: [{ id: 's1' }] }),
      ).rejects.toBeInstanceOf(ComputerSafetyError);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('acknowledges original checks even when policy mutates its detached copy', async () => {
    const owner = {},
      check = { id: 's1', message: 'confirm', extra: { keep: true } };
    const tool = computerTool({
      computer: driver().device,
      onSafetyCheck(_context, checks) {
        (checks[0] as Record<string, unknown>).id = 'forged';
        return true;
      },
    });
    const response = await invoke(tool, owner, {
      pending_safety_checks: [check],
    });
    expect(
      JSON.parse((response.contentItems[0] as { text: string }).text)
        .acknowledged_safety_checks,
    ).toEqual([check]);
    await closeComputerResources(owner);
  });

  it('reuses one acquired driver across turns and children, isolates Sessions, and disposes once', async () => {
    const create = vi.fn(() => driver().device),
      dispose = vi.fn();
    const tool = computerTool({ computer: { create, dispose } }),
      first = {},
      second = {};
    await invoke(tool, first);
    await invoke(tool, first);
    await invoke(tool, second);
    expect(create).toHaveBeenCalledTimes(2);
    await closeComputerResources(first);
    await closeComputerResources(first);
    await closeComputerResources(second);
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid later actions before any partial device effect', async () => {
    const { device, calls } = driver();
    await expect(
      invoke(
        computerTool({ computer: device }),
        {},
        { actions: [{ type: 'wait' }, { type: 'unknown' }] },
      ),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('aborts queued calls while joining the entered driver before disposal', async () => {
    const { device } = driver(),
      owner = {},
      controller = new AbortController();
    let release!: () => void;
    const entered = Promise.withResolvers<void>();
    device.wait = async () => {
      entered.resolve();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const dispose = vi.fn(),
      tool = computerTool({ computer: { create: () => device, dispose } });
    const first = invoke(tool, owner, { action: { type: 'wait' } });
    await entered.promise;
    const second = invoke(tool, owner, {}, controller.signal);
    controller.abort(new Error('queued stop'));
    await expect(second).rejects.toThrow('queued stop');
    expect(dispose).not.toHaveBeenCalled();
    release();
    await first;
    await closeComputerResources(owner);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('checks application approval against detached actions before acquisition', async () => {
    const create = vi.fn(() => driver().device);
    const tool = computerTool({
      computer: { create },
      approve(_context, actions) {
        expect(actions).toEqual([{ type: 'wait' }]);
        (actions as unknown[]).length = 0;
        return false;
      },
    });
    await expect(
      invoke(tool, {}, { action: { type: 'wait' } }),
    ).rejects.toBeInstanceOf(ComputerSafetyError);
    expect(create).not.toHaveBeenCalled();
  });

  it('does not retry an invalid explicit screenshot', async () => {
    const { device } = driver(),
      owner = {};
    const screenshot = vi.fn(() => undefined as unknown as string);
    device.screenshot = screenshot;
    await expect(
      invoke(computerTool({ computer: device }), owner, {
        action: { type: 'screenshot' },
      }),
    ).rejects.toThrow('base64 PNG');
    expect(screenshot).toHaveBeenCalledTimes(1);
    await closeComputerResources(owner);
  });

  it('retains an acquisition that finishes after cancellation for exactly-once disposal', async () => {
    const owner = {},
      controller = new AbortController(),
      acquired = Promise.withResolvers<Computer>();
    const entered = Promise.withResolvers<void>(),
      dispose = vi.fn();
    const create = vi.fn(() => {
      entered.resolve();
      return acquired.promise;
    });
    const tool = computerTool({ computer: { create, dispose } });
    const pending = invoke(tool, owner, {}, controller.signal);
    await entered.promise;
    controller.abort(new Error('acquisition stop'));
    const { device, calls } = driver();
    acquired.resolve(device);
    await expect(pending).rejects.toThrow('acquisition stop');
    expect(calls).toEqual([]);
    await closeComputerResources(owner);
    await closeComputerResources(owner);
    expect(dispose).toHaveBeenCalledExactlyOnceWith(device);
  });

  it('does not bypass or retry a failed initializer on another turn', async () => {
    const { device, calls } = driver(),
      owner = {},
      dispose = vi.fn();
    device.initRun = vi.fn(() => {
      throw new Error('initialization failed');
    });
    const tool = computerTool({ computer: { create: () => device, dispose } });
    await expect(invoke(tool, owner)).rejects.toThrow('initialization failed');
    await expect(invoke(tool, owner)).rejects.toThrow('initialization failed');
    expect(device.initRun).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    await closeComputerResources(owner);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('does not open a queued device action before its failed sibling is reported', async () => {
    const { device, calls } = driver(),
      owner = {},
      entered = Promise.withResolvers<void>(),
      fail = Promise.withResolvers<void>();
    device.wait = async () => {
      entered.resolve();
      await fail.promise;
      throw new Error('device failed');
    };
    const tool = computerTool({ computer: device });
    let failed = false;
    const admitted = () => {
      if (failed) throw new Error('owner failed');
    };
    const reportFailure = () => {
      failed = true;
    };
    const first = invokeFunctionTool(
      tool,
      call({ action: { type: 'wait' } }),
      context(owner),
      reportFailure,
      admitted,
    ).catch((error) => {
      failed = true;
      throw error;
    });
    await entered.promise;
    const second = invokeFunctionTool(
      tool,
      call({ action: { type: 'type', text: 'must not enter' } }),
      context(owner),
      reportFailure,
      admitted,
    );
    const secondResult = second.then(
      () => 'entered',
      () => 'rejected',
    );
    fail.resolve();
    await expect(first).rejects.toThrow('device failed');
    expect(await secondResult).toBe('rejected');
    expect(calls.some(([kind]) => kind === 'type')).toBe(false);
    await closeComputerResources(owner);
  });
  it('preserves own prototype-named safety fields through the acknowledgment', async () => {
    const owner = {};
    const check = JSON.parse('{"id":"s1","__proto__":{"keep":true}}');
    const tool = computerTool({
      computer: driver().device,
      onSafetyCheck(_context, checks) {
        expect(Object.hasOwn(checks[0], '__proto__')).toBe(true);
        return true;
      },
    });
    const response = await invoke(tool, owner, {
      pending_safety_checks: [check],
    });
    expect(
      JSON.parse((response.contentItems[0] as { text: string }).text)
        .acknowledged_safety_checks,
    ).toEqual([check]);
    await closeComputerResources(owner);
  });
});
