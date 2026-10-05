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
  let response = await GET(
    new NextRequest(`https://demo.test/api/session?stream=${stream}`),
  );
  const bootstrapResponse = response;
  const cookie = response.cookies.get(OWNER_COOKIE);
  if (cookie) {
    provider.cookie = cookie.value;
    response = await GET(new NextRequest(response.headers.get('location')!));
  }
  const url = new URL(response.headers.get('location')!);
  return {
    bootstrapResponse,
    response,
    url,
    sessionId: url.searchParams.get('session')!,
  };
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
  it('establishes the owner cookie before any remote conversation creation', async () => {
    const response = await GET(
      new NextRequest('https://demo.test/api/session'),
    );
    expect(response.cookies.get(OWNER_COOKIE)?.value).toBeTruthy();
    expect(provider.create).not.toHaveBeenCalled();
    expect(response.headers.get('location')).toBe(
      'https://demo.test/api/session',
    );
  });

  it('issues a private cookie and retains it when opening another conversation', async () => {
    const first = await openConversation();
    const owner = provider.cookie;
    expect(first.bootstrapResponse.cookies.get(OWNER_COOKIE)).toMatchObject({
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
    expect(first.response.headers.has('set-cookie')).toBe(false);
    expect(second.response.headers.has('set-cookie')).toBe(false);
  });

  it('keeps both first-use tabs usable when conversation creation completes out of order', async () => {
    const [firstBootstrap, secondBootstrap] = await Promise.all([
      GET(new NextRequest('https://demo.test/api/session')),
      GET(new NextRequest('https://demo.test/api/session?stream=text')),
    ]);
    expect(provider.create).not.toHaveBeenCalled();

    provider.cookie = firstBootstrap.cookies.get(OWNER_COOKIE)!.value;
    let finishFirst!: (id: string) => void;
    provider.create.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const pendingFirst = GET(
      new NextRequest(firstBootstrap.headers.get('location')!),
    );
    await vi.waitFor(() => expect(provider.create).toHaveBeenCalledTimes(1));

    // The second bootstrap response arrives while the first tab is creating its conversation.
    provider.cookie = secondBootstrap.cookies.get(OWNER_COOKIE)!.value;
    const survivingOwner = provider.cookie;
    const second = await openConversation('text');
    expect(
      (await postText(messageRequest({ sessionId: second.sessionId }))).status,
    ).toBe(200);

    finishFirst('conv_slow_first_tab');
    const firstResponse = await pendingFirst;
    // A late provider response must never restore the earlier cookie.
    expect(firstResponse.headers.has('set-cookie')).toBe(false);
    expect(provider.cookie).toBe(survivingOwner);
    expect(
      (await TextPage({ searchParams: { session: second.sessionId } })).props
        .sessionId,
    ).toBe(second.sessionId);

    const firstId = new URL(
      firstResponse.headers.get('location')!,
    ).searchParams.get('session')!;
    await expect(Page({ searchParams: { session: firstId } })).rejects.toThrow(
      'redirect:/api/session',
    );
    const recoveredFirst = await openConversation();
    expect(
      (await Page({ searchParams: { session: recoveredFirst.sessionId } }))
        .props.sessionId,
    ).toBe(recoveredFirst.sessionId);
    expect(
      (await postUi(messageRequest({ sessionId: recoveredFirst.sessionId })))
        .status,
    ).toBe(200);
    expect(
      (await postText(messageRequest({ sessionId: second.sessionId }))).status,
    ).toBe(200);
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
