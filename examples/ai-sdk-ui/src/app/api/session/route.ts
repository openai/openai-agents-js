import { NextRequest, NextResponse } from 'next/server';
import { createSession, getOwnerId, OWNER_COOKIE } from '@/app/lib/session';

export async function GET(req: NextRequest) {
  const ownerId = await getOwnerId();
  if (!ownerId) {
    // Establish browser ownership before any remote conversation work.
    const response = NextResponse.redirect(req.url);
    response.cookies.set(OWNER_COOKIE, crypto.randomUUID(), {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.nextUrl.protocol === 'https:',
      path: '/',
    });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }

  const sessionId = crypto.randomUUID();
  await createSession(sessionId, ownerId);

  const path =
    req.nextUrl.searchParams.get('stream') === 'text' ? '/text' : '/';
  const response = NextResponse.redirect(
    new URL(`${path}?session=${sessionId}`, req.url),
  );
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
