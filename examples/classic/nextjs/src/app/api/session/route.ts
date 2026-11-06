import { NextRequest, NextResponse } from 'next/server';
import {
  accessTokenConfigured,
  createDemoSession,
  getDemoSession,
  readLimitedJson,
  sameOrigin,
  sessionCookieName,
  validAccessToken,
} from '@/demoSession';

export function GET(req: NextRequest) {
  return new NextResponse(null, {
    status: getDemoSession(req) ? 204 : 401,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: 'Invalid origin' }, { status: 403 });
  }
  if (!accessTokenConfigured()) {
    return NextResponse.json(
      { error: 'Demo access token is not configured' },
      { status: 503 },
    );
  }
  const body = await readLimitedJson(req, 1024);
  if ('status' in body) {
    return NextResponse.json(
      { error: 'Invalid request' },
      { status: body.status },
    );
  }
  const token =
    body.value && typeof body.value === 'object' && 'token' in body.value
      ? body.value.token
      : undefined;
  if (typeof token !== 'string' || !validAccessToken(token)) {
    return NextResponse.json(
      { error: 'Invalid access token' },
      { status: 401 },
    );
  }
  const session = createDemoSession();
  if (!session) {
    return NextResponse.json({ error: 'Too many sessions' }, { status: 429 });
  }
  const response = NextResponse.json({ ok: true });
  response.headers.set('Cache-Control', 'no-store');
  response.cookies.set(sessionCookieName, session, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.nextUrl.protocol === 'https:',
    path: '/',
    maxAge: 60 * 60,
  });
  return response;
}
