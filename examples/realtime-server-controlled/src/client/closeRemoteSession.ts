import { requestCsrfToken } from './demoAuthClient';

export async function closeRemoteSession(
  sessionId: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  // One deadline covers Close, authentication renewal, and the Close retry.
  // The coordinator retains the session ID when this operation times out.
  const signal = AbortSignal.timeout(15_000);
  const close = (csrfToken: string) =>
    fetchImpl(`/api/realtime/sessions/${encodeURIComponent(sessionId)}/close`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrfToken },
      keepalive: true,
      signal,
    });
  let response = await close(token);
  if (response.status === 401 || response.status === 403) {
    response = await close(await requestCsrfToken(fetchImpl, signal));
  }
  // An expired demo login can renew as a different principal. A not-found
  // response means no session is accessible to that principal; it grants no
  // authority over the old call, which remains managed by the server sweep.
  if (!response.ok && response.status !== 404) {
    throw new Error('Could not close the voice session. Retry Stop.');
  }
}
