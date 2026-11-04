import { afterEach, expect, it, vi } from 'vitest';
import { Agent, NativeProvider, checklist, localStorage } from '../../src';
import { Session } from '../../src/runtime/session';
import { captureTools } from '../../src/runtime/tools';
import type { Engine, NativeThread } from '../../src/runtime/binding';

vi.mock('../../src/runtime/binding', async (original) => ({
  ...(await original<typeof import('../../src/runtime/binding')>()),
  binding: async () => ({ _validate_python_tool_declarations: () => {} }),
}));
afterEach(() => vi.restoreAllMocks());

const wire = JSON.stringify({
  thread_id: 'root',
  turn_id: 'native-turn',
  explanation: '',
  plan: [{ step: 'Inspect', status: 'completed' }],
});
function session(read: () => Promise<string>) {
  return new Session(
    { _close_report: async () => null } as unknown as Engine,
    {
      id: 'root',
      read_checklist: read,
      _stop_sampling_for_close: () => {},
      _close_report: async () => null,
    } as unknown as NativeThread,
    captureTools([]),
    { localStorage: true },
    {},
  );
}

it('reads a detached local snapshot without granting native update authority', async () => {
  const read = vi.fn(async () => wire);
  const owned = session(read);
  try {
    const value = await owned.checklist();
    expect(value).toEqual({
      threadId: 'root',
      turnId: 'native-turn',
      explanation: '',
      plan: [{ step: 'Inspect', status: 'completed' }],
    });
    expect(Object.isFrozen(value!.plan[0])).toBe(true);
    expect(read).toHaveBeenCalledWith(null);
  } finally {
    await owned.close();
  }
});

it('keeps absence distinct from storage failure and checks its native owner each time', async () => {
  const failure = new Error('native writer failed');
  const read = vi
    .fn<() => Promise<string>>()
    .mockResolvedValueOnce('null')
    .mockRejectedValueOnce(failure);
  const owned = session(read);
  try {
    expect(await owned.checklist()).toBeNull();
    await expect(owned.checklist()).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    await owned.close();
  }
});

it('rejects a local snapshot delivered after closure wins the JS publication gap', async () => {
  const pending = Promise.withResolvers<string>();
  const owned = session(() => pending.promise);
  const result = owned.checklist();
  const rejected = expect(result).rejects.toThrow('open Session');
  await owned.close();
  pending.resolve(wire);
  await rejected;
});

it.each([undefined, 'saved-thread'])(
  'admits a declared local checklist up to the mocked native resource boundary (%s)',
  async (resume) => {
    const provider = new NativeProvider();
    const stop = new Error('mock provider boundary');
    const acquire = vi.spyOn(provider, '_acquire').mockImplementation(() => {
      throw stop;
    });
    try {
      const agent = new Agent({
        instructions: 'Inspect.',
        provider,
        tools: [checklist()],
      });
      await expect(
        agent.session({
          storage: localStorage('/unused-checklist-profile'),
          resume,
        }),
      ).rejects.toBe(stop);
      expect(acquire).toHaveBeenCalledOnce();
    } finally {
      await provider.close();
    }
  },
);

it('uses explicit empty opening tools rather than inherited duplicate Checklist declarations', async () => {
  const provider = new NativeProvider();
  const stop = new Error('mock provider boundary');
  const acquire = vi.spyOn(provider, '_acquire').mockImplementation(() => {
    throw stop;
  });
  try {
    const agent = new Agent({
      instructions: 'Inspect.',
      provider,
      tools: [checklist(), checklist()],
    });
    await expect(
      agent.session({ storage: localStorage('/unused-checklist-profile') }),
    ).rejects.toThrow('Checklist');
    expect(acquire).not.toHaveBeenCalled();
    await expect(
      agent.session({
        storage: localStorage('/unused-checklist-profile'),
        tools: [],
      }),
    ).rejects.toBe(stop);
    expect(acquire).toHaveBeenCalledOnce();
  } finally {
    await provider.close();
  }
});
