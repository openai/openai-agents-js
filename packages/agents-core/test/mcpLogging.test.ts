import { describe, expect, it } from 'vitest';
import { getMcpServerExternalName } from '../src/mcpLogging';

describe('getMcpServerExternalName', () => {
  it('removes credentials, query strings, and fragments from URL-derived names', () => {
    const credentialedUrl = new URL(
      'https://example.test:8443/mcp?token=secret#fragment',
    );
    credentialedUrl.username = 'user';
    credentialedUrl.password = 'password';

    expect(
      getMcpServerExternalName(
        `streamable-http: ${credentialedUrl.toString()}`,
      ),
    ).toBe('streamable-http: https://example.test:8443/mcp');
    expect(
      getMcpServerExternalName(
        'sse: https://example.test/events?api_key=secret',
      ),
    ).toBe('sse: https://example.test/events');
  });

  it('preserves ordinary server names', () => {
    expect(getMcpServerExternalName('diagnostic-server')).toBe(
      'diagnostic-server',
    );
  });

  it('fails closed for invalid URL-derived server names', () => {
    expect(getMcpServerExternalName('sse: not an absolute URL')).toBe(
      'sse: <redacted endpoint>',
    );
    const invalidCredentialedUrl = ['https://', 'user:password', '@'].join('');
    expect(getMcpServerExternalName(invalidCredentialedUrl)).toBe(
      '<redacted endpoint>',
    );
  });

  it('sanitizes direct HTTP URLs and preserves IPv6 hosts, ports, and paths', () => {
    const credentialedUrl = new URL(
      'https://[2001:db8::1]:8443/mcp?token=secret#fragment',
    );
    credentialedUrl.username = 'user';
    credentialedUrl.password = 'password';

    expect(getMcpServerExternalName(credentialedUrl.toString())).toBe(
      'https://[2001:db8::1]:8443/mcp',
    );
  });
});
