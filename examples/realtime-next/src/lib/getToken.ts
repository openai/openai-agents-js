export async function getToken(): Promise<string | undefined> {
  try {
    // Use the local FastAPI token server explicitly during dev (port 8000)
    const res = await fetch('http://127.0.0.1:8000/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-realtime' }),
    });

    if (!res.ok) {
      console.warn('Token endpoint returned non-OK status', res.status);
      return undefined;
    }

    const data = await res.json();
    return data?.token;
  } catch (e) {
    console.warn('Failed to fetch token from local server', e);
    return undefined;
  }
}
