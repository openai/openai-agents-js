import { timingSafeEqual } from 'node:crypto';

export function accessTokenConfigured(): boolean {
  return (process.env.AI_SDK_UI_DEMO_ACCESS_TOKEN?.length ?? 0) >= 32;
}

export function hasDemoAccess(req: { headers: Headers }): boolean {
  const token = process.env.AI_SDK_UI_DEMO_ACCESS_TOKEN;
  if (!token || !accessTokenConfigured()) return false;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(
    req.headers.get('authorization') ?? '',
  );
  if (!match) return false;
  const provided = Buffer.from(match[1], 'base64');
  const expected = Buffer.from(`demo:${token}`);
  return (
    provided.toString('base64') === match[1] &&
    provided.length === expected.length &&
    timingSafeEqual(provided, expected)
  );
}

export function demoAccessResponse(headers: Headers): Response | undefined {
  const site = headers.get('sec-fetch-site');
  if (site === 'same-site' || site === 'cross-site') {
    return new Response(
      'Open this demo URL directly in your browser to sign in.',
      {
        status: 403,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }
  if (!accessTokenConfigured()) {
    return new Response('Demo access token is not configured.', {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  if (!hasDemoAccess({ headers })) {
    return new Response('Demo access token required.', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="AI SDK UI Demo", charset="UTF-8"',
        'Cache-Control': 'no-store',
      },
    });
  }
}
