import { NextRequest, NextResponse } from 'next/server';
import { demoAccessResponse } from './app/lib/demoAccess';

// Challenge at the root so browsers send Basic credentials to both pages and APIs.
export function proxy(req: NextRequest) {
  return demoAccessResponse(req.headers) ?? NextResponse.next();
}

export const config = { matcher: ['/', '/text', '/api/:path*'] };
