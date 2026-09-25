import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { DemoAuthStore } from '../src/server/demoAuth';

function request(cookie?: string): IncomingMessage {
  return {
    headers: cookie ? { cookie } : {},
  } as unknown as IncomingMessage;
}

describe('DemoAuthStore', () => {
  it('renews the same principal when a voice session is about to start', () => {
    let now = 0;
    const auth = new DemoAuthStore({
      now: () => now,
      secureCookie: false,
    });
    const initial = auth.getOrCreate(request());
    const cookie = initial.setCookie!.split(';', 1)[0]!;

    now = 59 * 60 * 1000;
    const renewed = auth.getOrCreate(request(cookie));

    expect(renewed.principal).toMatchObject({
      csrfToken: initial.principal.csrfToken,
      ownerId: initial.principal.ownerId,
    });
    expect(renewed.setCookie).toContain('Max-Age=3600');
    expect(renewed.setCookie!.split(';', 1)[0]).toBe(cookie);

    now = 61 * 60 * 1000;
    expect(auth.authenticate(request(cookie))).toMatchObject({
      csrfToken: initial.principal.csrfToken,
      ownerId: initial.principal.ownerId,
    });
  });
});
