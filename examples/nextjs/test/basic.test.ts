import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const model = vi.hoisted(() => ({
  run: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  fromString: vi.fn(),
}));

vi.mock('@/agents', () => ({ agent: {} }));
vi.mock('@/db', () => ({ db: () => ({ get: model.get, set: model.set }) }));
vi.mock('@openai/agents/classic', () => ({
  Runner: class {
    run = model.run;
  },
  RunState: { fromString: model.fromString },
}));

import { POST } from '../src/app/api/basic/route';
import {
  GET as checkSession,
  POST as signIn,
} from '../src/app/api/session/route';

const origin = 'http://localhost:3000';
const accessToken = 'a'.repeat(32);
const messages = [{ type: 'message', role: 'user', content: 'Hello' }];

function request(
  body: unknown,
  cookie?: string,
  requestOrigin = origin,
): NextRequest {
  return new NextRequest(`${origin}/api/basic`, {
    method: 'POST',
    headers: {
      origin: requestOrigin,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function sessionCookie(): Promise<string> {
  const response = await signIn(
    new NextRequest(`${origin}/api/session`, {
      method: 'POST',
      headers: { origin },
      body: JSON.stringify({ token: accessToken }),
    }),
  );
  expect(response.status).toBe(200);
  const cookie = response.cookies.get('nextjs-demo-session');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'strict' });
  return `nextjs-demo-session=${cookie!.value}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXTJS_DEMO_ACCESS_TOKEN = accessToken;
  model.run.mockResolvedValue({
    interruptions: [],
    finalOutput: 'Hello',
    history: [{ type: 'message', role: 'assistant', content: 'Hello' }],
  });
});

describe('billable demo route', () => {
  it('requires a configured token and accepts an issued session on reload', async () => {
    const invalid = await signIn(
      new NextRequest(`${origin}/api/session`, {
        method: 'POST',
        headers: { origin },
        body: JSON.stringify({ token: 'wrong' }),
      }),
    );
    expect(invalid.status).toBe(401);
    const cookie = await sessionCookie();
    expect(
      checkSession(
        new NextRequest(`${origin}/api/session`, { headers: { cookie } }),
      ).status,
    ).toBe(204);
    expect(checkSession(new NextRequest(`${origin}/api/session`)).status).toBe(
      401,
    );
  });

  it('rejects a caller without a demo session before a model run', async () => {
    const response = await POST(request({ messages, decisions: {} }));
    expect(response.status).toBe(401);
    expect(model.run).not.toHaveBeenCalled();
    expect(model.get).not.toHaveBeenCalled();
  });

  it('rejects foreign origins and oversized bodies before a model run', async () => {
    const cookie = await sessionCookie();
    expect(
      (
        await POST(
          request({ messages, decisions: {} }, cookie, 'https://evil.test'),
        )
      ).status,
    ).toBe(403);
    expect(
      (await POST(request({ messages: ['x'.repeat(256 * 1024)] }, cookie)))
        .status,
    ).toBe(413);
    expect(model.run).not.toHaveBeenCalled();
  });

  it('continues a conversation with more than 16 KiB of accumulated history', async () => {
    const cookie = await sessionCookie();
    const history = [
      ...messages,
      {
        type: 'message',
        role: 'assistant',
        content: 'Long reply '.repeat(2_000),
      },
    ];
    model.run.mockResolvedValueOnce({
      interruptions: [],
      history,
      finalOutput: history[1].content,
    });
    const first = await POST(request({ messages }, cookie));
    expect(first.status).toBe(200);
    const previous = await first.json();
    const nextMessages = [
      ...previous.history,
      { type: 'message', role: 'user', content: 'Follow-up' },
    ];
    const second = await POST(
      request(
        { messages: nextMessages, conversationId: previous.conversationId },
        cookie,
      ),
    );
    expect(second.status).toBe(200);
    expect(model.run).toHaveBeenLastCalledWith({}, nextMessages);
  });

  it('returns 401 when the session expires while reading the request', async () => {
    const cookie = await sessionCookie();
    const clock = vi.spyOn(Date, 'now');
    try {
      const expiresAt = Date.now() + 60 * 60 * 1000;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            clock.mockReturnValue(expiresAt);
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify({ messages })),
            );
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const response = await POST(
        new NextRequest(`${origin}/api/basic`, {
          method: 'POST',
          headers: { origin, cookie },
          body,
          duplex: 'half',
        }),
      );
      expect(response.status).toBe(401);
      expect(model.run).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it('lets a session start and resume only its own interrupted run', async () => {
    const owner = await sessionCookie();
    const other = await sessionCookie();
    const interruption = {
      type: 'tool_approval_item',
      rawItem: { callId: 'call_1' },
      toJSON: () => ({ type: 'tool_approval_item' }),
    };
    model.run.mockResolvedValueOnce({
      interruptions: [interruption],
      history: messages,
      state: { interrupted: true },
    });
    const first = await POST(
      request({ messages, conversationId: null, decisions: {} }, owner),
    );
    expect(first.status).toBe(200);
    const { conversationId } = await first.json();
    expect(model.set).toHaveBeenCalledWith(
      `${owner.split('=')[1]}:${conversationId}`,
      JSON.stringify({ interrupted: true }),
    );

    model.run.mockClear();
    expect(
      (
        await POST(
          request(
            { messages, conversationId, decisions: { call_1: 'approved' } },
            other,
          ),
        )
      ).status,
    ).toBe(404);
    expect(model.run).not.toHaveBeenCalled();

    const state = {
      getInterruptions: () => [interruption],
      approve: vi.fn(),
      reject: vi.fn(),
    };
    model.get.mockResolvedValueOnce(JSON.stringify({ interrupted: true }));
    model.fromString.mockResolvedValueOnce(state);
    const resumed = await POST(
      request(
        { messages, conversationId, decisions: { call_1: 'approved' } },
        owner,
      ),
    );
    expect(resumed.status).toBe(200);
    expect((await resumed.json()).response).toBe('Hello');
    expect(state.approve).toHaveBeenCalledWith(interruption);
    expect(model.run).toHaveBeenCalledWith({}, state);
  });

  it('caps model runs for an authenticated session', async () => {
    const cookie = await sessionCookie();
    for (let i = 0; i < 20; i += 1) {
      expect(
        (await POST(request({ messages, decisions: {} }, cookie))).status,
      ).toBe(200);
    }
    expect(
      (await POST(request({ messages, decisions: {} }, cookie))).status,
    ).toBe(429);
    expect(model.run).toHaveBeenCalledTimes(20);
  });

  it('shares issued sessions when the model route loads in another module instance', async () => {
    const cookie = await sessionCookie();
    vi.resetModules();
    const { POST: reloadedPost } = await import('../src/app/api/basic/route');
    const response = await reloadedPost(
      request({ messages, conversationId: null, decisions: {} }, cookie),
    );
    expect(response.status).toBe(200);
    expect(model.run).toHaveBeenCalledTimes(1);
  });
});
