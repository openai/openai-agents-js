import { expect, it } from 'vitest';
import {
  text,
  withScriptedResponses,
  type ScriptedResponse,
  type ScriptedResponses,
} from '../src/testing';

it('captures response usage and headers before serving the real HTTP envelope', async () => {
  const usage = { input_tokens: 4, output_tokens: 3, total_tokens: 7 };
  const headers = { 'x-ratelimit-remaining-requests': '5' };
  const response: ScriptedResponse = {
    items: [text('answer')],
    usage,
    headers,
  };
  await withScriptedResponses([response, [text('plain')]], async (peer) => {
    usage.total_tokens = 999;
    headers['x-ratelimit-remaining-requests'] = '0';
    const received = await fetch(`${peer.provider.baseUrl}/responses`, {
      method: 'POST',
      body: JSON.stringify({ input: 'synthetic' }),
    });
    expect(received.headers.get('x-ratelimit-remaining-requests')).toBe('5');
    const payload = await received.text();
    const events = payload
      .trim()
      .split('\n\n')
      .map((line) => JSON.parse(line.slice(6)));
    expect(events.at(-1).response.usage).toEqual({
      input_tokens: 4,
      output_tokens: 3,
      total_tokens: 7,
    });
    expect(events[0].response).not.toHaveProperty('usage');
    const plain = await fetch(`${peer.provider.baseUrl}/responses`, {
      method: 'POST',
      body: JSON.stringify({ input: 'synthetic next' }),
    });
    expect(await plain.text()).not.toContain('usage');
  });
});

it('refuses response framing overrides before starting a scripted scope', async () => {
  let entered = false;
  await expect(
    withScriptedResponses(
      [{ items: [text('answer')], headers: { 'Content-Length': '0' } }],
      () => {
        entered = true;
      },
    ),
  ).rejects.toThrow('Invalid scripted response');
  expect(entered).toBe(false);
});

it('supports dynamic responders, queue mutation and explicit raw-event identifiers', async () => {
  let retained!: ScriptedResponses;
  await withScriptedResponses([[text('discard')]], async (peer) => {
    retained = peer;
    expect(peer.remainingSteps).toBe(1);
    peer.clear();
    expect(peer.remainingSteps).toBe(0);
    peer.append(async (request) => {
      expect(peer.remainingSteps).toBe(0);
      expect(request.input).toBe('synthetic');
      peer.append({
        items: [],
        responseId: 'resp_raw_fixture',
        events: [
          {
            type: 'response.output_item.done',
            item: {
              type: 'message',
              role: 'assistant',
              id: 'msg_raw_fixture',
              content: [{ type: 'output_text', text: 'raw answer' }],
            },
          },
        ],
      });
      expect(peer.remainingSteps).toBe(1);
      return {
        items: [text('dynamic answer', { itemId: 'msg_dynamic_fixture' })],
        responseId: 'resp_dynamic_fixture',
      };
    });
    expect(peer.remainingSteps).toBe(1);
    const first = await fetch(`${peer.provider.baseUrl}/responses`, {
      method: 'POST',
      body: JSON.stringify({ input: 'synthetic' }),
    });
    const firstText = await first.text();
    expect(peer.remainingSteps).toBe(1);
    expect(firstText).toContain('resp_dynamic_fixture');
    expect(firstText).toContain('msg_dynamic_fixture');
    const second = await fetch(`${peer.provider.baseUrl}/responses`, {
      method: 'POST',
      body: JSON.stringify({ input: 'next synthetic' }),
    });
    const secondText = await second.text();
    expect(peer.remainingSteps).toBe(0);
    expect(secondText).toContain('resp_raw_fixture');
    expect(secondText).toContain('raw answer');
    expect(peer.requests).toHaveLength(2);
  });
  expect(retained.remainingSteps).toBe(0);
});

it('retains dynamic assertion failures locally without sending them to the provider', async () => {
  const failure = new Error('synthetic-private-callback-error');
  await expect(
    withScriptedResponses(
      [
        async () => {
          throw failure;
        },
      ],
      async (peer) => {
        const response = await fetch(`${peer.provider.baseUrl}/responses`, {
          method: 'POST',
          body: JSON.stringify({ input: 'synthetic' }),
        });
        expect(response.status).toBe(400);
        expect(await response.text()).not.toContain(failure.message);
        // Successful body exit reports the original callback error from exhaustion.
      },
    ),
  ).rejects.toBe(failure);
});

it('fences scripted dequeues after a callback failure even for an explicit later request', async () => {
  const failure = new Error('synthetic-private-callback-fence');
  let following = 0;
  await expect(
    withScriptedResponses(
      [
        async () => {
          throw failure;
        },
        async () => {
          following++;
          return [text('must stay queued')];
        },
      ],
      async (peer) => {
        for (let index = 0; index < 2; index++) {
          const response = await fetch(`${peer.provider.baseUrl}/responses`, {
            method: 'POST',
            body: JSON.stringify({ input: 'synthetic' }),
          });
          expect(response.status).toBe(400);
          expect(await response.text()).not.toContain(failure.message);
        }
      },
    ),
  ).rejects.toBe(failure);
  expect(following).toBe(0);
});

it('preserves a primary scripted body exception after a callback failure', async () => {
  const callback = new Error('synthetic-callback-secondary');
  const primary = new Error('synthetic-primary-body');
  await expect(
    withScriptedResponses(
      [
        async () => {
          throw callback;
        },
      ],
      async (peer) => {
        const response = await fetch(`${peer.provider.baseUrl}/responses`, {
          method: 'POST',
          body: JSON.stringify({ input: [] }),
        });
        expect(response.status).toBe(400);
        await response.text();
        throw primary;
      },
    ),
  ).rejects.toBe(primary);
  expect(primary.cause).toBe(callback);
});

it('serializes callback admission without blocking append or clear', async () => {
  const callback = new Error('synthetic-concurrent-callback');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let following = false;
  let ranBeforeRelease = false;
  const statuses: number[] = [];
  await expect(
    withScriptedResponses(
      [
        async () => {
          entered();
          await gate;
          throw callback;
        },
        async () => {
          following = true;
          return [text('must remain queued')];
        },
      ],
      async (peer) => {
        const send = () =>
          fetch(`${peer.provider.baseUrl}/responses`, {
            method: 'POST',
            body: JSON.stringify({ input: [] }),
          });
        const first = send();
        await started;
        const second = send();
        try {
          await new Promise<void>((resolve, reject) => {
            const deadline = Date.now() + 2000;
            const poll = () => {
              if (peer.requests.length === 2) return resolve();
              if (Date.now() > deadline)
                return reject(new Error('second request did not arrive'));
              setTimeout(poll, 1);
            };
            poll();
          });
          ranBeforeRelease = following;
          peer.clear();
          peer.append(async () => {
            following = true;
            return [text('must stay queued')];
          });
        } finally {
          release();
        }
        const responses = await Promise.all([first, second]);
        for (const response of responses) {
          statuses.push(response.status);
          await response.text();
        }
      },
    ),
  ).rejects.toBe(callback);
  expect(statuses).toEqual([400, 400]);
  expect(ranBeforeRelease).toBe(false);
  expect(following).toBe(false);
});

it('releases concurrent admission after a successful callback in recorded order', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const called: number[] = [];
  const respond = async (body: Record<string, any>) => {
    called.push(body.tag);
    if (body.tag === 1) {
      entered();
      await gate;
    }
    return [text(String(body.tag))];
  };
  await withScriptedResponses([respond, respond, respond], async (peer) => {
    const send = (tag: number) =>
      fetch(`${peer.provider.baseUrl}/responses`, {
        method: 'POST',
        body: JSON.stringify({ tag }),
      });
    const arrived = (count: number) =>
      new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 2000;
        const poll = () => {
          if (peer.requests.length === count) return resolve();
          if (Date.now() > deadline)
            return reject(new Error('concurrent request did not arrive'));
          setTimeout(poll, 1);
        };
        poll();
      });
    const first = send(1);
    await started;
    const second = send(2);
    let third: Promise<Response>;
    try {
      await arrived(2);
      third = send(3);
      await arrived(3);
    } finally {
      release();
    }
    const responses = await Promise.all([first, second, third]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      await response.text();
    }
  });
  expect(called).toEqual([1, 2, 3]);
});

it.each([
  { explicitCause: false, cleanupFails: false },
  { explicitCause: true, cleanupFails: false },
  { explicitCause: false, cleanupFails: true },
])(
  'retains late callback diagnostics after joined close (%j)',
  async ({ explicitCause, cleanupFails }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalCause = new Error('synthetic-original-cause');
    const primary = new Error(
      'synthetic-primary-before-callback',
      explicitCause ? { cause: originalCause } : undefined,
    );
    const callback = new Error('synthetic-late-callback');
    const cleanup = new Error('synthetic-cleanup-failure');
    let callbackSettled = false;
    let request: Promise<unknown> | undefined;
    try {
      await withScriptedResponses(
        [
          async () => {
            entered();
            try {
              await gate;
              throw callback;
            } finally {
              callbackSettled = true;
            }
          },
        ],
        async (peer) => {
          if (cleanupFails) {
            const close = peer.provider.close.bind(peer.provider);
            peer.provider.close = async () => {
              await close();
              throw cleanup;
            };
          }
          request = fetch(`${peer.provider.baseUrl}/responses`, {
            method: 'POST',
            body: JSON.stringify({ input: [] }),
          }).catch(() => undefined);
          await started;
          // The callback fails only after the body has failed and close has begun.
          setTimeout(release, 20);
          throw primary;
        },
      );
      throw new Error('scripted body failure was lost');
    } catch (error) {
      expect(callbackSettled).toBe(true);
      if (cleanupFails) {
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([primary, cleanup]);
        expect((error as Error).cause).toBe(primary);
      } else expect(error).toBe(primary);
      expect(primary.cause).toBe(explicitCause ? originalCause : callback);
    } finally {
      release();
      await request;
    }
  },
);
