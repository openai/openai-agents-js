import { describe, expect, it } from 'vitest';
import { getMcpServerLogName } from '../src/mcpLogging';

describe('getMcpServerLogName', () => {
  it('removes credentials, query strings, and fragments from URL-derived names', () => {
    const credentialedUrl = new URL(
      'https://example.test:8443/mcp?token=secret#fragment',
    );
    credentialedUrl.username = 'user';
    credentialedUrl.password = 'password';

    expect(
      getMcpServerLogName(`streamable-http: ${credentialedUrl.toString()}`),
    ).toBe('streamable-http: https://example.test:8443/mcp');
    expect(
      getMcpServerLogName('sse: https://example.test/events?api_key=secret'),
    ).toBe('sse: https://example.test/events');
  });

  it('preserves ordinary server names', () => {
    expect(getMcpServerLogName('diagnostic-server')).toBe('diagnostic-server');
  });
});
