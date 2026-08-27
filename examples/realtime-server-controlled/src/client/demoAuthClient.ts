export async function requestCsrfToken(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl('/api/auth/session', {
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error('Could not initialize the application session.');
  }
  const body = (await response.json()) as { csrfToken?: unknown };
  if (typeof body.csrfToken !== 'string') {
    throw new Error('The application session returned an invalid CSRF token.');
  }
  return body.csrfToken;
}
