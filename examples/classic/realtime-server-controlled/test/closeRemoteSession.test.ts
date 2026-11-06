import { describe, expect, it, vi } from 'vitest';
import { closeRemoteSession } from '../src/client/closeRemoteSession';

describe('closeRemoteSession', () => {
  it.each([401, 403])(
    'refreshes rejected authentication (%s) once before retrying Close',
    async (status) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(Response.json({ csrfToken: 'fresh-token' }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      await closeRemoteSession('session-id', 'expired-token', fetchImpl);

      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(fetchImpl).toHaveBeenNthCalledWith(2, '/api/auth/session', {
        credentials: 'same-origin',
        signal: expect.any(AbortSignal),
      });
      expect(fetchImpl).toHaveBeenLastCalledWith(
        '/api/realtime/sessions/session-id/close',
        expect.objectContaining({ headers: { 'X-CSRF-Token': 'fresh-token' } }),
      );
      expect(fetchImpl.mock.calls.map(([, init]) => init?.signal)).toEqual([
        fetchImpl.mock.calls[0]![1]!.signal,
        fetchImpl.mock.calls[0]![1]!.signal,
        fetchImpl.mock.calls[0]![1]!.signal,
      ]);
    },
  );

  it('leaves persistent authentication failure retryable without looping', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ csrfToken: 'fresh-token' }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    await expect(
      closeRemoteSession('session-id', 'expired-token', fetchImpl),
    ).rejects.toThrow('Retry Stop');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

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
