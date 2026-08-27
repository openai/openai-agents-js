import { describe, expect, it, vi } from 'vitest';
import { requestCsrfToken } from '../src/client/demoAuthClient';

describe('requestCsrfToken', () => {
  it('requests a fresh application session for each voice-session attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ csrfToken: 'first-token' }))
      .mockResolvedValueOnce(
        Response.json({ csrfToken: 'second-token' }),
      ) as typeof fetch;

    await expect(requestCsrfToken(fetchImpl)).resolves.toBe('first-token');
    await expect(requestCsrfToken(fetchImpl)).resolves.toBe('second-token');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, '/api/auth/session', {
      credentials: 'same-origin',
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/api/auth/session', {
      credentials: 'same-origin',
    });
  });
});
