import { expect, it, vi } from 'vitest';
import { Session } from '../src/runtime/session';

it.each([false, true])(
  'forwards preservation=%s to the existing close owner',
  async (preserveDescendants) => {
    const closeStoredHistory = vi.fn().mockResolvedValue(undefined);
    const owner = { closeStoredHistory } as unknown as Session;
    await Session.prototype.deleteStored.call(owner, { preserveDescendants });
    expect(closeStoredHistory).toHaveBeenCalledExactlyOnceWith({
      kind: 'delete',
      preserve_descendants: preserveDescendants,
    });
  },
);

it('keeps physical deletion as the default', async () => {
  const closeStoredHistory = vi.fn().mockResolvedValue(undefined);
  await Session.prototype.deleteStored.call({
    closeStoredHistory,
  } as unknown as Session);
  expect(closeStoredHistory).toHaveBeenCalledExactlyOnceWith({
    kind: 'delete',
    preserve_descendants: false,
  });
});

it.each([null, 1, 'true'])(
  'rejects invalid preservation=%s before close',
  async (preserveDescendants) => {
    const closeStoredHistory = vi.fn().mockResolvedValue(undefined);
    await expect(
      Session.prototype.deleteStored.call(
        { closeStoredHistory } as unknown as Session,
        { preserveDescendants: preserveDescendants as never },
      ),
    ).rejects.toThrow('preserveDescendants');
    expect(closeStoredHistory).not.toHaveBeenCalled();
  },
);
