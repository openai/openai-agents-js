import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const provider = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  create: vi.fn(),
  getItems: vi.fn(),
  run: vi.fn(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (provider.cookie ? { value: provider.cookie } : undefined),
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock('@openai/agents-openai', () => ({
  OpenAIConversationsSession: class {
    constructor(private options?: { conversationId: string }) {}
    getSessionId() {
      return provider.create();
    }
    getItems() {
      return provider.getItems(this.options?.conversationId);
    }
  },
}));
vi.mock('@openai/agents', () => ({
  Agent: class {},
  run: provider.run,
  user: (text: string) => ({ role: 'user', content: text }),
}));
vi.mock('@openai/agents-extensions/ai-sdk-ui', () => ({
  createAiSdkUiMessageStreamResponse: () => new Response('ui stream'),
  createAiSdkTextStreamResponse: () => new Response('text stream'),
}));
vi.mock('../src/app/api/chat/agents', () => ({
  agent: { name: 'Sky Guide' },
  customerSupportAgent: { name: 'Support' },
}));
vi.mock('../src/app/components/ChatView', () => ({ default: () => null }));
vi.mock('../src/app/text/TextStreamChatClient', () => ({
  default: () => null,
}));

import Page from '../src/app/page';
import TextPage from '../src/app/text/page';
import { GET } from '../src/app/api/session/route';
import { POST as postUi } from '../src/app/api/chat/route';
import { POST as postText } from '../src/app/api/chat/text/route';
import { OWNER_COOKIE } from '../src/app/lib/session';

async function openConversation(stream = 'ui') {
  const response = await GET(
    new NextRequest(`https://demo.test/api/session?stream=${stream}`),
  );
  const url = new URL(response.headers.get('location')!);
  provider.cookie = response.cookies.get(OWNER_COOKIE)!.value;
  return { response, url, sessionId: url.searchParams.get('session')! };
}

function messageRequest(identifier: Record<string, string> = {}) {
  return new Request('https://demo.test/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...identifier,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  provider.cookie = undefined;
  provider.create.mockImplementation(async () => `conv_${crypto.randomUUID()}`);
  provider.getItems.mockResolvedValue([
    { role: 'user', content: 'Private astronomy question' },
  ]);
  provider.run.mockResolvedValue({
    completed: Promise.resolve(),
    currentAgent: { name: 'Support' },
  });
});

describe('browser-owned conversations', () => {
  it('issues a private cookie and retains it when opening another conversation', async () => {
    const first = await openConversation();
    const owner = provider.cookie;
    expect(first.response.cookies.get(OWNER_COOKIE)).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
    });
    expect(first.response.headers.get('cache-control')).toBe('no-store');
    expect(first.sessionId).not.toBe(owner);
    expect(first.url.pathname).toBe('/');
    expect(first.url.href).not.toContain(owner!);
    const second = await openConversation('text');
    expect(provider.cookie).toBe(owner);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.url.pathname).toBe('/text');
  });

  it('supports a cookie on the documented HTTP localhost demo', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/api/session'),
    );
    expect(response.cookies.get(OWNER_COOKIE)).toMatchObject({
      httpOnly: true,
      secure: false,
    });
  });

  for (const [name, page, post, bootstrap] of [
    ['ui', Page, postUi, '/api/session'],
    ['text', TextPage, postText, '/api/session?stream=text'],
  ] as const) {
    it(`${name}: allows the owning browser to read and continue its conversation`, async () => {
      const { sessionId } = await openConversation(name);
      const view = await page({ searchParams: { session: sessionId } });
      expect(view.props.initialMessages[0].parts).toEqual([
        { type: 'text', text: 'Private astronomy question' },
      ]);
      const conversationId = provider.getItems.mock.calls[0][0];
      expect((await post(messageRequest({ sessionId }))).status).toBe(200);
      expect(provider.run.mock.calls[0][2].conversationId).toBe(conversationId);
      // The AI SDK id alias remains usable by the owner, including after a handoff save.
      expect((await post(messageRequest({ id: sessionId }))).status).toBe(200);
      expect(provider.run.mock.calls[1][2].conversationId).toBe(conversationId);
      expect(
        (await page({ searchParams: { session: sessionId } })).props.sessionId,
      ).toBe(sessionId);
    });

    it(`${name}: isolates a second browser following a shared conversation link`, async () => {
      const alice = await openConversation(name);
      const aliceCookie = provider.cookie;
      provider.cookie = undefined;
      const bob = await openConversation(name);
      expect(provider.cookie).not.toBe(aliceCookie);
      provider.create.mockClear();
      await expect(
        page({ searchParams: { session: alice.sessionId } }),
      ).rejects.toThrow(`redirect:${bootstrap}`);
      expect(
        (await post(messageRequest({ sessionId: alice.sessionId }))).status,
      ).toBe(404);
      expect(provider.getItems).not.toHaveBeenCalled();
      expect(provider.run).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
      // The rejected attempt neither steals Alice's entry nor damages Bob's.
      expect(
        (await page({ searchParams: { session: bob.sessionId } })).props
          .sessionId,
      ).toBe(bob.sessionId);
      provider.cookie = aliceCookie;
      expect(
        (await page({ searchParams: { session: alice.sessionId } })).props
          .sessionId,
      ).toBe(alice.sessionId);
    });

    it(`${name}: rejects writes and redirects reads after cookie loss`, async () => {
      const { sessionId } = await openConversation(name);
      provider.cookie = undefined;
      provider.create.mockClear();
      await expect(
        page({ searchParams: { session: sessionId } }),
      ).rejects.toThrow(`redirect:${bootstrap}`);
      expect((await post(messageRequest({ id: sessionId }))).status).toBe(404);
      expect(provider.getItems).not.toHaveBeenCalled();
      expect(provider.run).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
    });

    it(`${name}: rejects missing and unknown write IDs instead of creating shared sessions`, async () => {
      await openConversation(name);
      provider.create.mockClear();
      expect((await post(messageRequest())).status).toBe(400);
      expect(
        (await post(messageRequest({ sessionId: 'default' }))).status,
      ).toBe(404);
      await expect(page({ searchParams: {} })).rejects.toThrow(
        `redirect:${bootstrap}`,
      );
      await expect(
        page({ searchParams: { session: 'unknown' } }),
      ).rejects.toThrow(`redirect:${bootstrap}`);
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.getItems).not.toHaveBeenCalled();
      expect(provider.run).not.toHaveBeenCalled();
    });
  }
});
