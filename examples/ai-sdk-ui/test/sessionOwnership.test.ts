import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const provider = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  create: vi.fn(),
  getItems: vi.fn(),
  run: vi.fn(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = provider.cookies.get(name);
      return value ? { value } : undefined;
    },
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
import { ownerCookieName } from '../src/app/lib/session';

function receiveResponse(response: NextResponse) {
  for (const cookie of response.cookies.getAll()) {
    provider.cookies.set(cookie.name, cookie.value);
  }
  const url = new URL(response.headers.get('location')!);
  return { response, url, sessionId: url.searchParams.get('session')! };
}

async function openConversation(stream = 'ui') {
  return receiveResponse(
    await GET(
      new NextRequest(`https://demo.test/api/session?stream=${stream}`),
    ),
  );
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
  provider.cookies = new Map();
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
  it('issues an independent private cookie for each conversation', async () => {
    const first = await openConversation();
    const cookie = first.response.cookies.get(
      ownerCookieName(first.sessionId),
    )!;
    expect(cookie).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
    });
    expect(first.response.headers.get('cache-control')).toBe('no-store');
    expect(first.sessionId).not.toBe(cookie.value);
    expect(first.url.pathname).toBe('/');
    expect(first.url.href).not.toContain(cookie.value);
    const second = await openConversation('text');
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.url.pathname).toBe('/text');
    expect(provider.cookies.size).toBe(2);
    expect(provider.cookies.get(cookie.name)).toBe(cookie.value);
    expect(provider.cookies.get(ownerCookieName(second.sessionId))).not.toBe(
      cookie.value,
    );
    // Both stream views can open the same owned conversation.
    expect(
      (await TextPage({ searchParams: { session: first.sessionId } })).props
        .sessionId,
    ).toBe(first.sessionId);
  });

  for (const delayed of ['provider completion', 'cookie delivery']) {
    it(`preserves both original conversations after late ${delayed}`, async () => {
      let finishFirst!: (id: string) => void;
      provider.create.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishFirst = resolve;
          }),
      );
      const pendingFirst = GET(
        new NextRequest('https://demo.test/api/session'),
      );
      await vi.waitFor(() => expect(provider.create).toHaveBeenCalledTimes(1));
      if (delayed === 'cookie delivery') finishFirst('conv_first_tab');
      const heldResponse =
        delayed === 'cookie delivery' ? await pendingFirst : undefined;

      const second = await openConversation('text');
      expect(
        (await TextPage({ searchParams: { session: second.sessionId } })).props
          .sessionId,
      ).toBe(second.sessionId);
      expect(
        (await postText(messageRequest({ sessionId: second.sessionId })))
          .status,
      ).toBe(200);
      if (!heldResponse) finishFirst('conv_first_tab');
      const first = receiveResponse(heldResponse ?? (await pendingFirst));
      for (const { sessionId } of [first, second]) {
        expect(
          (await Page({ searchParams: { session: sessionId } })).props
            .sessionId,
        ).toBe(sessionId);
        expect((await postUi(messageRequest({ sessionId }))).status).toBe(200);
        expect((await postText(messageRequest({ sessionId }))).status).toBe(
          200,
        );
      }
      expect(provider.create).toHaveBeenCalledTimes(2);
      expect(provider.cookies.size).toBe(2);
    });
  }

  it('supports a cookie on the documented HTTP localhost demo', async () => {
    const { response, sessionId } = receiveResponse(
      await GET(new NextRequest('http://localhost:3000/api/session')),
    );
    expect(response.cookies.get(ownerCookieName(sessionId))).toMatchObject({
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
      const aliceCookies = new Map(provider.cookies);
      provider.cookies = new Map();
      const bob = await openConversation(name);
      expect(provider.cookies.has(ownerCookieName(alice.sessionId))).toBe(
        false,
      );
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
      provider.cookies = aliceCookies;
      expect(
        (await page({ searchParams: { session: alice.sessionId } })).props
          .sessionId,
      ).toBe(alice.sessionId);
    });

    it(`${name}: rejects writes and redirects reads after cookie loss`, async () => {
      const { sessionId } = await openConversation(name);
      provider.cookies = new Map();
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
