import { describe, expect, it, vi } from 'vitest';
import { closeRemoteSession } from '../src/client/closeRemoteSession';

describe('closeRemoteSession', () => {
  it('requires a successful HTTP response before confirming cleanup', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      closeRemoteSession('session-id', 'token', fetchImpl),
    ).rejects.toThrow('Retry Stop');
    await expect(
      closeRemoteSession('session-id', 'token', fetchImpl),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenLastCalledWith(
      '/api/realtime/sessions/session-id/close',
      expect.objectContaining({
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': 'token' },
        method: 'POST',
      }),
    );
  });
});
