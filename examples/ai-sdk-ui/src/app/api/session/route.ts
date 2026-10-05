import { NextRequest, NextResponse } from 'next/server';
import { createSession, ownerCookieName } from '@/app/lib/session';

export async function GET(req: NextRequest) {
  const sessionId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  await createSession(sessionId, ownerId);

  const path =
    req.nextUrl.searchParams.get('stream') === 'text' ? '/text' : '/';
  const response = NextResponse.redirect(
    new URL(`${path}?session=${sessionId}`, req.url),
  );
  response.cookies.set(ownerCookieName(sessionId), ownerId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.nextUrl.protocol === 'https:',
    path: '/',
  });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
