import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  nativeGoals,
  localStorage,
  tool,
} from '../../src';
import { nativeGoal } from '../../src/runtime/goals';
import { splitToolDeclarations } from '../../src/runtime/tool-declarations';
import { Session } from '../../src/runtime/session';
import { captureTools } from '../../src/runtime/tools';
import type { Engine, NativeThread } from '../../src/runtime/binding';

const wire = {
  threadId: 'native-root',
  objective: 'Finish the requested record',
  status: 'active',
  tokensUsed: '9007199254740993',
  timeUsedSeconds: '72',
  createdAt: '1700000000',
  updatedAt: '1700000072',
};
function session(granted: boolean) {
  const read = vi.fn(async () => JSON.stringify(wire));
  const owned = new Session(
    {} as Engine,
    { id: 'native-root', _read_goal: read } as unknown as NativeThread,
    captureTools([]),
    { localStorage: true, nativeGoals: granted },
    {},
  );
  return { owned, read };
}

describe('native goal declaration and read boundary without native loading', () => {
  it('creates an immutable structural declaration distinct from managed callbacks', () => {
    const declaration = nativeGoals();
    expect(Object.isFrozen(declaration)).toBe(true);
    expect(Object.getPrototypeOf(declaration)).toBe(Object.prototype);
    expect(splitToolDeclarations([declaration, nativeGoals()])).toMatchObject({
      tools: [],
      mcp: [],
      nativeGoals: true,
    });
  });

  it('preserves exact native integers, absent budget and detached immutable state', () => {
    const value = nativeGoal(wire)!;
    expect(value.tokensUsed).toBe(9007199254740993n);
    expect(value.timeUsedSeconds).toBe(72);
    expect(value).not.toHaveProperty('tokenBudget');
    expect(value).not.toHaveProperty('goalId');
    expect(Object.isFrozen(value)).toBe(true);
    expect(
      nativeGoal({ ...wire, tokenBudget: '9223372036854775807' })!.tokenBudget,
    ).toBe(9223372036854775807n);
    expect(nativeGoal(null)).toBeNull();
  });

  it('rejects malformed states instead of converting errors to absence or rounded counters', () => {
    for (const change of [
      { status: 'delivered' },
      { tokensUsed: 9007199254740992 },
      { tokensUsed: '-1' },
      { tokenBudget: '0' },
    ])
      expect(() => nativeGoal({ ...wire, ...change })).toThrow();
    expect(() => nativeGoal(undefined)).toThrow();
  });

  it('requires current declaration before provider acquisition', async () => {
    const provider = new NativeProvider();
    const acquire = vi.spyOn(provider, '_acquire');
    await expect(
      new Agent({
        instructions: 'Manage the goal.',
        tools: [nativeGoals()],
        provider,
      }).session(),
    ).rejects.toThrow('requires explicit local storage');
    expect(acquire).not.toHaveBeenCalled();
    await provider.close();
  });

  it.each(['create_goal', 'get_goal', 'update_goal'])(
    'reserves %s only with native grant',
    async (name) => {
      const managed = tool({
        name,
        parameters: z.object({}),
        execute: () => 'ordinary',
      });
      expect(splitToolDeclarations([managed]).tools).toEqual([managed]);
      const provider = new NativeProvider();
      const acquire = vi.spyOn(provider, '_acquire');
      await expect(
        new Agent({
          instructions: 'Manage the goal.',
          tools: [managed, nativeGoals()],
          provider,
        }).session({ storage: localStorage('/unused-goal-profile') }),
      ).rejects.toThrow('reserves');
      expect(acquire).not.toHaveBeenCalled();
      await provider.close();
    },
  );

  it('denies ungranted reads before the native owner and retains fixed opening grants on updates', async () => {
    const denied = session(false);
    await expect(denied.owned.goal()).rejects.toThrow('current NativeGoals');
    expect(denied.read).not.toHaveBeenCalled();
    await expect(
      denied.owned.update({ tools: [nativeGoals()] }),
    ).rejects.toThrow('cannot change');
  });

  it('reads again through its native owner rather than caching returned state', async () => {
    const { owned, read } = session(true);
    expect((await owned.goal())!.tokensUsed).toBe(9007199254740993n);
    read.mockResolvedValueOnce('null');
    expect(await owned.goal()).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
