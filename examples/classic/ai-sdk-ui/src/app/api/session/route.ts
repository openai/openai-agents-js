import { demoAccessResponse } from '@/app/lib/demoAccess';
import { NextRequest, NextResponse } from 'next/server';
import { createSession, ownerCookieName } from '@/app/lib/session';

export async function GET(req: NextRequest) {
  const denied = demoAccessResponse(req.headers);
  if (denied) return new NextResponse(denied.body, denied);
  const sessionId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  if (!(await createSession(sessionId, ownerId))) {
    return new NextResponse('Too many conversations.', { status: 429 });
  }

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
    maxAge: 60 * 60,
  });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
