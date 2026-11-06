import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const provider = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  create: vi.fn(),
  delete: vi.fn(),
  authorization: '',
  fetchSite: '',
  getItems: vi.fn(),
  run: vi.fn(),
}));
vi.mock('next/headers', () => ({
  headers: async () =>
    new Headers({
      authorization: provider.authorization,
      ...(provider.fetchSite ? { 'sec-fetch-site': provider.fetchSite } : {}),
    }),
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
    clearSession() {
      return provider.delete(this.options?.conversationId);
    }
    getItems() {
      return provider.getItems(this.options?.conversationId);
    }
  },
}));
vi.mock('@openai/agents/classic', () => ({
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
import { proxy } from '../src/proxy';
import {
  findSession,
  readSessionHistory,
  ownerCookieName,
} from '../src/app/lib/session';

const accessToken = '0123456789abcdef0123456789abcdef';
const authorization = `Basic ${Buffer.from(`demo:${accessToken}`).toString('base64')}`;

function sessionRequest(url: string) {
  return new NextRequest(url, {
    headers: {
      authorization,
      ...(provider.fetchSite ? { 'sec-fetch-site': provider.fetchSite } : {}),
    },
  });
}

function receiveResponse(response: NextResponse) {
  for (const cookie of response.cookies.getAll()) {
    provider.cookies.set(cookie.name, cookie.value);
  }
  const url = new URL(response.headers.get('location')!);
  return { response, url, sessionId: url.searchParams.get('session')! };
}

async function openConversation(stream = 'ui') {
  return receiveResponse(
    await GET(sessionRequest(`https://demo.test/api/session?stream=${stream}`)),
  );
}

function messageRequest(identifier: Record<string, string> = {}) {
  return new Request('https://demo.test/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: provider.authorization,
      ...(provider.fetchSite ? { 'sec-fetch-site': provider.fetchSite } : {}),
    },
    body: JSON.stringify({
      ...identifier,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
    }),
  });
}

beforeEach(() => {
  vi.stubEnv('AI_SDK_UI_DEMO_ACCESS_TOKEN', accessToken);
  provider.authorization = authorization;
  provider.fetchSite = '';
  provider.delete.mockResolvedValue(undefined);
  (
    globalThis as { __aiSdkUiSessionStore?: Map<string, unknown> }
  ).__aiSdkUiSessionStore?.clear();
  const usage = (
    globalThis as {
      __aiSdkUiUsage?: {
        pendingCreations: number;
        globalRuns: number;
        globalResetAt: number;
        activeRuns: number;
      };
    }
  ).__aiSdkUiUsage;
  if (usage) {
    Object.assign(usage, {
      creationAttempts: 0,
      creationResetAt: Date.now() + 60 * 60 * 1000,
      cleanup: undefined,
      retryCleanupAfter: 0,
    });
    usage.pendingCreations = 0;
    usage.globalRuns = 0;
    usage.globalResetAt = Date.now() + 60 * 60 * 1000;
    usage.activeRuns = 0;
  }
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('browser-owned conversations', () => {
  for (const site of ['same-site', 'cross-site']) {
    it(`rejects ${site} browser requests at every protected entrypoint before provider work`, async () => {
      const { sessionId } = await openConversation();
      provider.create.mockClear();
      provider.fetchSite = site;
      for (const path of [
        '/',
        '/text',
        '/api/session',
        '/api/chat',
        '/api/chat/text',
      ]) {
        const response = proxy(sessionRequest(`https://demo.test${path}`));
        expect(response.status).toBe(403);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
      expect(
        (await GET(sessionRequest('https://demo.test/api/session'))).status,
      ).toBe(403);
      for (const post of [postUi, postText]) {
        expect((await post(messageRequest({ sessionId }))).status).toBe(403);
      }
      for (const page of [Page, TextPage]) {
        expect(
          (await page({ searchParams: { session: sessionId } })).props.children,
        ).toContain('Open this demo URL directly');
      }
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.getItems).not.toHaveBeenCalled();
      expect(provider.run).not.toHaveBeenCalled();
    });
  }

  for (const site of ['same-origin', 'none']) {
    it(`preserves normal ${site} access`, async () => {
      provider.fetchSite = site;
      expect(proxy(sessionRequest('https://demo.test/')).status).toBe(200);
      const { sessionId } = await openConversation();
      for (const page of [Page, TextPage]) {
        expect(
          (await page({ searchParams: { session: sessionId } })).props
            .sessionId,
        ).toBe(sessionId);
      }
      for (const post of [postUi, postText]) {
        expect((await post(messageRequest({ sessionId }))).status).toBe(200);
      }
    });
  }

  it('challenges both browser entry paths and APIs before provider work', async () => {
    for (const path of [
      '/',
      '/text',
      '/api/session',
      '/api/chat',
      '/api/chat/text',
    ]) {
      expect(proxy(new NextRequest(`https://demo.test${path}`)).status).toBe(
        401,
      );
      expect(proxy(sessionRequest(`https://demo.test${path}`)).status).toBe(
        200,
      );
    }
    const { sessionId } = await openConversation();
    provider.authorization = '';
    for (const post of [postUi, postText]) {
      expect((await post(messageRequest({ sessionId }))).status).toBe(401);
    }
    for (const page of [Page, TextPage]) {
      expect(
        (await page({ searchParams: { session: sessionId } })).props.children,
      ).toContain('Open this demo URL directly');
    }
    expect(provider.getItems).not.toHaveBeenCalled();
    expect(provider.run).not.toHaveBeenCalled();
  });

  it('charges failed creation attempts and recovers capacity next hour', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    provider.create.mockRejectedValue(new Error('Provider unavailable'));
    for (let i = 0; i < 32; i++) {
      await expect(
        GET(sessionRequest('https://demo.test/api/session')),
      ).rejects.toThrow('Provider unavailable');
    }
    expect(
      (await GET(sessionRequest('https://demo.test/api/session'))).status,
    ).toBe(429);
    expect(provider.create).toHaveBeenCalledTimes(32);
    vi.mocked(Date.now).mockReturnValue(now + 60 * 60 * 1000 + 1);
    provider.create.mockResolvedValue('conv_recovered');
    expect(
      (await GET(sessionRequest('https://demo.test/api/session'))).status,
    ).toBe(307);
  });

  it('waits for late streams and history before deleting expired conversations', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const first = await openConversation();
    const firstId = await provider.create.mock.results[0].value;
    let finishRun!: () => void;
    provider.run.mockResolvedValueOnce({
      completed: new Promise<void>((resolve) => {
        finishRun = resolve;
      }),
      currentAgent: { name: 'Support' },
    });
    await postUi(messageRequest({ sessionId: first.sessionId }));
    const entry = findSession(
      first.sessionId,
      provider.cookies.get(ownerCookieName(first.sessionId)),
    )!;
    let finishRead!: (items: []) => void;
    provider.getItems.mockImplementationOnce(
      () =>
        new Promise<[]>((resolve) => {
          finishRead = resolve;
        }),
    );
    const history = readSessionHistory(first.sessionId, entry);
    vi.mocked(Date.now).mockReturnValue(now + 60 * 60 * 1000 + 1);
    await openConversation();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(
      (await postText(messageRequest({ sessionId: first.sessionId }))).status,
    ).toBe(404);
    finishRun();
    await vi.waitFor(() => expect(entry.activeRuns).toBe(0));
    await openConversation();
    expect(provider.delete).not.toHaveBeenCalled();
    finishRead([]);
    await history;
    await openConversation();
    expect(provider.delete).toHaveBeenCalledWith(firstId);
    expect(findSession(first.sessionId, entry.ownerId)).toBeUndefined();
  });

  it('retains failed cleanup slots and retries deletion including already deleted conversations', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await Promise.all(Array.from({ length: 32 }, () => openConversation()));
    vi.mocked(Date.now).mockReturnValue(now + 60 * 60 * 1000 + 1);
    provider.delete.mockRejectedValue(new Error('Unavailable'));
    expect(
      (await GET(sessionRequest('https://demo.test/api/session'))).status,
    ).toBe(429);
    expect(provider.create).toHaveBeenCalledTimes(32);
    expect(provider.delete).toHaveBeenCalledTimes(32);
    expect(
      (await GET(sessionRequest('https://demo.test/api/session'))).status,
    ).toBe(429);
    expect(provider.delete).toHaveBeenCalledTimes(32);
    vi.mocked(Date.now).mockReturnValue(now + 61 * 60 * 1000 + 1);
    provider.delete.mockRejectedValue(
      Object.assign(new Error('Gone'), { status: 404 }),
    );
    expect(
      (await GET(sessionRequest('https://demo.test/api/session'))).status,
    ).toBe(307);
    expect(provider.create).toHaveBeenCalledTimes(33);
    expect(provider.delete).toHaveBeenCalledTimes(64);
  });

  it('rejects unauthenticated session creation before contacting the provider', async () => {
    const response = await GET(
      new NextRequest('https://demo.test/api/session'),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Basic');
    const invalid = await GET(
      new NextRequest('https://demo.test/api/session', {
        headers: {
          authorization: `Basic ${Buffer.from('demo:wrong-token').toString('base64')}`,
        },
      }),
    );
    expect(invalid.status).toBe(401);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('requires configuration before offering browser authentication', async () => {
    delete process.env.AI_SDK_UI_DEMO_ACCESS_TOKEN;
    const response = await GET(
      new NextRequest('https://demo.test/api/session'),
    );
    expect(response.status).toBe(503);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('caps conversations before concurrent provider creation', async () => {
    const finish: Array<(id: string) => void> = [];
    provider.create.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish.push(resolve);
        }),
    );
    const pending = Array.from({ length: 32 }, () =>
      GET(sessionRequest('https://demo.test/api/session')),
    );
    await vi.waitFor(() => expect(provider.create).toHaveBeenCalledTimes(32));
    const denied = GET(sessionRequest('https://demo.test/api/session'));
    finish.forEach((resolve, index) => resolve(`conv_${index}`));
    expect((await denied).status).toBe(429);
    expect(provider.create).toHaveBeenCalledTimes(32);
    expect(
      (await Promise.all(pending)).every((response) => response.status === 307),
    ).toBe(true);
  });

  it('caps model runs across both chat routes and rejects oversized input', async () => {
    const sessions = await Promise.all(
      Array.from({ length: 4 }, () => openConversation()),
    );
    for (const session of sessions) {
      for (let index = 0; index < 15; index += 1) {
        const post = index % 2 === 0 ? postUi : postText;
        expect(
          (await post(messageRequest({ sessionId: session.sessionId }))).status,
        ).toBe(200);
      }
    }
    expect(provider.run).toHaveBeenCalledTimes(60);
    expect(
      (await postUi(messageRequest({ id: sessions[0].sessionId }))).status,
    ).toBe(429);
    expect(provider.run).toHaveBeenCalledTimes(60);

    const oversized = new Request('https://demo.test/api/chat/text', {
      method: 'POST',
      headers: { authorization },
      body: JSON.stringify({
        sessionId: sessions[0].sessionId,
        messages: [
          {
            role: 'user',
            parts: [{ type: 'text', text: 'a'.repeat(65 * 1024) }],
          },
        ],
      }),
    });
    expect((await postText(oversized)).status).toBe(413);
    expect(provider.run).toHaveBeenCalledTimes(60);
  });

  it('caps one conversation even when it alternates stream routes', async () => {
    const { sessionId } = await openConversation();
    for (let index = 0; index < 20; index += 1) {
      const post = index % 2 === 0 ? postUi : postText;
      expect((await post(messageRequest({ sessionId }))).status).toBe(200);
    }
    expect((await postText(messageRequest({ id: sessionId }))).status).toBe(
      429,
    );
    expect(provider.run).toHaveBeenCalledTimes(20);
  });

  it('releases a run slot when model startup fails', async () => {
    const { sessionId } = await openConversation();
    provider.run.mockRejectedValueOnce(new Error('model failed'));
    await expect(postText(messageRequest({ sessionId }))).rejects.toThrow(
      'model failed',
    );
    expect((await postText(messageRequest({ sessionId }))).status).toBe(200);
    expect(provider.run).toHaveBeenCalledTimes(2);
  });

  it('limits concurrent model runs and releases slots on completion', async () => {
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    provider.run.mockResolvedValue({
      completed,
      currentAgent: { name: 'Support' },
    });
    const sessions = await Promise.all(
      Array.from({ length: 5 }, () => openConversation()),
    );
    for (const session of sessions.slice(0, 4)) {
      expect(
        (await postUi(messageRequest({ sessionId: session.sessionId }))).status,
      ).toBe(200);
    }
    expect(
      (await postText(messageRequest({ sessionId: sessions[4].sessionId })))
        .status,
    ).toBe(429);
    expect(provider.run).toHaveBeenCalledTimes(4);
    complete();
    await vi.waitFor(async () => {
      expect(
        (await postText(messageRequest({ sessionId: sessions[4].sessionId })))
          .status,
      ).toBe(200);
    });
  });

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
      const pendingFirst = GET(sessionRequest('https://demo.test/api/session'));
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
      await GET(sessionRequest('http://localhost:3000/api/session')),
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
      if (name === 'ui')
        expect(provider.run.mock.calls[1][0].name).toBe('Support');
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
