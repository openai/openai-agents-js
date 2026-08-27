export async function closeRemoteSession(
  sessionId: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(
    `/api/realtime/sessions/${encodeURIComponent(sessionId)}/close`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': token },
      keepalive: true,
    },
  );
  if (!response.ok) {
    throw new Error('Could not close the voice session. Retry Stop.');
  }
}
