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
