import { expect, it } from 'vitest';
import {
  text,
  withScriptedResponses,
  type ScriptedResponse,
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
  await withScriptedResponses([[text('discard')]], async (peer) => {
    peer.clear();
    peer.append(async (request) => {
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
      return {
        items: [text('dynamic answer', { itemId: 'msg_dynamic_fixture' })],
        responseId: 'resp_dynamic_fixture',
      };
    });
    const first = await fetch(`${peer.provider.baseUrl}/responses`, {
      method: 'POST',
      body: JSON.stringify({ input: 'synthetic' }),
    });
    const firstText = await first.text();
    expect(firstText).toContain('resp_dynamic_fixture');
    expect(firstText).toContain('msg_dynamic_fixture');
    const second = await fetch(`${peer.provider.baseUrl}/responses`, {
      method: 'POST',
      body: JSON.stringify({ input: 'next synthetic' }),
    });
    const secondText = await second.text();
    expect(secondText).toContain('resp_raw_fixture');
    expect(secondText).toContain('raw answer');
    expect(peer.requests).toHaveLength(2);
  });
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
        throw new Error('provider failure caused by HTTP400');
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
