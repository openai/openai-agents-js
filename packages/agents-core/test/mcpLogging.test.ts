import { describe, expect, it } from 'vitest';
import { getMcpServerDiagnosticName } from '../src/mcpLogging';

describe('getMcpServerDiagnosticName', () => {
  it('removes credentials, query strings, and fragments from URL-derived names', () => {
    const credentialedUrl = new URL(
      'https://example.test:8443/mcp?token=secret#fragment',
    );
    credentialedUrl.username = 'user';
    credentialedUrl.password = 'password';

    expect(
      getMcpServerDiagnosticName(
        `streamable-http: ${credentialedUrl.toString()}`,
      ),
    ).toBe('streamable-http: https://example.test:8443/mcp');
    expect(
      getMcpServerDiagnosticName(
        'sse: https://example.test/events?api_key=secret',
      ),
    ).toBe('sse: https://example.test/events');
  });

  it('preserves ordinary server names', () => {
    expect(getMcpServerDiagnosticName('diagnostic-server')).toBe(
      'diagnostic-server',
    );
  });
});
