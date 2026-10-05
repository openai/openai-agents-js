import { NextRequest, NextResponse } from 'next/server';
import { createSession, getOwnerId, OWNER_COOKIE } from '@/app/lib/session';

export async function GET(req: NextRequest) {
  const ownerId = (await getOwnerId()) || crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  await createSession(sessionId, ownerId);

  const path =
    req.nextUrl.searchParams.get('stream') === 'text' ? '/text' : '/';
  const response = NextResponse.redirect(
    new URL(`${path}?session=${sessionId}`, req.url),
  );
  response.cookies.set(OWNER_COOKIE, ownerId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.nextUrl.protocol === 'https:',
    path: '/',
  });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
