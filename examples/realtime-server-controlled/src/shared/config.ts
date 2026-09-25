export const DEFAULT_API_PORT = 3001;

export function parseApiPort(value: string | undefined): number {
  const port = Number(value ?? DEFAULT_API_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be a valid TCP port.');
  }
  return port;
}
