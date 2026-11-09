export function isOfficialOpenAIEndpoint(
  baseURL: string | URL | undefined,
  transport: 'http' | 'websocket',
): boolean {
  if (!baseURL) {
    return false;
  }

  try {
    const parsedURL = new URL(baseURL);
    if (parsedURL.hostname !== 'api.openai.com' || parsedURL.port.length > 0) {
      return false;
    }

    if (transport === 'http') {
      return parsedURL.protocol === 'https:';
    }

    return parsedURL.protocol === 'https:' || parsedURL.protocol === 'wss:';
  } catch {
    return false;
  }
}
