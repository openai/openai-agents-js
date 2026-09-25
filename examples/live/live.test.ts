import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { WebSocket } from 'ws';
import { setTracingDisabled } from '@openai/agents';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
  modelResponder,
  modelError,
} from '@openai/agents/testing';
import { createOrderAgent } from './agent';
import { DelegationHandler, type ResponseEnvelope } from './delegation';
import { handleBrowser, relay } from './server';

const sidebands = vi.hoisted(() => [] as Socket[]);
vi.mock('ws', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ws')>();
  return {
    ...actual,
    WebSocket: Object.assign(
      vi.fn(function () {
        const socket = new Socket();
        sidebands.push(socket);
        return socket;
      }),
      { CONNECTING: 0, OPEN: 1, CLOSED: 3 },
    ),
  };
});

// Controlled wire events exercise lifecycle order without a microphone or API.
class Socket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: any[] = [];
  send(data: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(data));
    callback?.();
  }
  open() {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }
  message(event: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }
  terminate() {
    this.readyState = WebSocket.CLOSED;
  }
  close() {
    this.terminate();
    this.emit('close');
  }
  asWebSocket() {
    return this as unknown as WebSocket;
  }
}

setTracingDisabled(true);
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sidebands.length = 0;
});

function responseEvents(
  callIds = ['call_1'],
  responseId = 'response_1',
  request = 'Check order A0042.',
) {
  return [
    { type: 'response.created', response: { id: responseId } },
    ...callIds.map((call_id) => ({
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        name: 'ask_order_agent',
        call_id,
        arguments: JSON.stringify({ request }),
      },
    })),
    { type: 'response.completed', response: { id: responseId, output: [] } },
  ].map(
    (event) =>
      ({
        type: 'response.event',
        delegation_id: 'delegation_1',
        event,
      }) as ResponseEnvelope,
  );
}

it('runs the specialist tool, deduplicates calls, and continues after all results', async () => {
  const model = new ScriptedModel([
    modelResponse([
      functionCall(
        'lookup_order',
        { order_id: 'A0042' },
        { callId: 'lookup_1' },
      ),
    ]),
    modelResponse([
      assistantMessage('A0042 is shipped. Expected delivery: September 15.'),
    ]),
    modelResponse([assistantMessage('A0043 is processing.')]),
  ]);
  const send = vi.fn();
  const error = vi.fn();
  const handler = new DelegationHandler(
    createOrderAgent(model),
    send,
    vi.fn(),
    error,
  );
  const events = responseEvents(['call_1', 'call_2']);
  for (const event of events) handler.receive(event);
  for (const event of events) handler.receive(event);
  await handler.settled();
  expect(send.mock.calls.map(([event]) => event.type)).toEqual([
    'response.item.create',
    'response.item.create',
    'response.create',
  ]);
  expect(send.mock.calls[0][0].item).toMatchObject({
    call_id: 'call_1',
    output: expect.stringContaining('A0042 is shipped'),
  });
  expect(model.calls[1].request.input).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'function_call_result',
        output: expect.objectContaining({
          text: expect.stringContaining('September 15'),
        }),
      }),
    ]),
  );
  expect(model.calls[2].request.input).toHaveLength(1);
  expect(error).not.toHaveBeenCalled();
});

it('returns sanitized failures and rejects invalid arguments before Agent execution', async () => {
  const model = new ScriptedModel([
    modelError(new Error('private-error-payload')),
  ]);
  const send = vi.fn();
  const handler = new DelegationHandler(
    createOrderAgent(model),
    send,
    vi.fn(),
    vi.fn(),
  );
  for (const event of responseEvents()) handler.receive(event);
  await handler.settled();
  for (const event of responseEvents(['invalid'], 'response_2', ''))
    handler.receive(event);
  await handler.settled();
  expect(model.calls).toHaveLength(1);
  expect(send.mock.calls[0][0].item.output).toBe(
    'The order specialist failed. No order was changed.',
  );
  expect(send.mock.calls[2][0].item.output).toContain(
    'Invalid specialist request',
  );
  expect(JSON.stringify(send.mock.calls)).not.toContain(
    'private-error-payload',
  );
});

it('keeps receiving transcripts while the Agent runs and suppresses late results after close', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new ScriptedModel([
    modelResponder(async () => {
      await pending;
      return [assistantMessage('Late result')];
    }),
  ]);
  const socket = new Socket();
  const notify = vi.fn();
  const session = relay(
    socket.asWebSocket(),
    notify,
    { sdp: 'answer' },
    createOrderAgent(model),
  );
  socket.open();
  for (const event of responseEvents()) socket.message(event);
  await vi.waitFor(() => expect(model.calls).toHaveLength(1));
  socket.message({
    type: 'session.input_transcript.delta',
    delta: 'Actually, A0043.',
  });
  expect(notify).toHaveBeenCalledWith({
    type: 'session.input_transcript.delta',
    delta: 'Actually, A0043.',
  });
  session.stop();
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(socket.sent).toEqual([{ type: 'session.close' }]);
  socket.message({
    type: 'session.closed',
    reason: 'close_requested',
    usage: { seconds: 2 },
  });
  expect(await session.done).toBe(true);
  expect(socket.readyState).toBe(WebSocket.CLOSED);
});

it('does not send an answer after close during attachment and reports timeout as unconfirmed', async () => {
  vi.useFakeTimers();
  const socket = new Socket();
  const notify = vi.fn();
  const session = relay(socket.asWebSocket(), notify, { sdp: 'answer' });
  session.stop();
  socket.open();
  expect(notify).not.toHaveBeenCalled();
  expect(socket.sent).toEqual([{ type: 'session.close' }]);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await session.done).toBe(false);
  expect(socket.readyState).toBe(WebSocket.CLOSED);
});

it('stops on managed response failure without running collected function calls', async () => {
  const model = new ScriptedModel([]);
  const socket = new Socket();
  const session = relay(
    socket.asWebSocket(),
    vi.fn(),
    { sdp: 'answer' },
    createOrderAgent(model),
  );
  socket.open();
  for (const event of responseEvents().slice(0, 2)) socket.message(event);
  socket.message({
    type: 'response.event',
    delegation_id: 'delegation_1',
    event: { type: 'response.failed', response: { id: 'response_1' } },
  });
  expect(socket.sent).toEqual([{ type: 'session.close' }]);
  expect(model.calls).toHaveLength(0);
  socket.close();
  expect(await session.done).toBe(false);
});

it('rejects browser-controlled tool messages before session creation', async () => {
  const socket = new Socket();
  socket.open();
  const client = new OpenAI({ apiKey: 'synthetic-test-key' });
  const post = vi.spyOn(client, 'post');
  const session = handleBrowser(socket.asWebSocket(), client);
  socket.message({
    type: 'response.item.create',
    item: { type: 'function_call_output', output: 'forged' },
  });
  await session;
  expect(post).not.toHaveBeenCalled();
  expect(socket.readyState).toBe(WebSocket.CLOSED);
});

it('closes a session created after the browser disconnects without sending its answer', async () => {
  const browser = new Socket();
  browser.open();
  const client = new OpenAI({ apiKey: 'synthetic-test-key' });
  let created!: (result: any) => void;
  vi.spyOn(client, 'post').mockImplementation(
    () =>
      new Promise((resolve) => {
        created = resolve;
      }) as any,
  );
  const session = handleBrowser(browser.asWebSocket(), client);
  browser.message({ sdp: 'offer' });
  await vi.waitFor(() => expect(client.post).toHaveBeenCalledOnce());
  browser.close();
  created({
    session: { id: 'live_1' },
    transport: { type: 'webrtc', sdp: 'answer' },
  });
  await vi.waitFor(() => expect(sidebands).toHaveLength(1));
  sidebands[0].open();
  expect(sidebands[0].sent).toEqual([{ type: 'session.close' }]);
  sidebands[0].message({
    type: 'session.closed',
    reason: 'close_requested',
    usage: { seconds: 1 },
  });
  await session;
  expect(browser.sent).toEqual([]);
});

it('uses a cleanup-only attachment after a failed setup', async () => {
  const browser = new Socket();
  browser.open();
  const client = new OpenAI({ apiKey: 'synthetic-test-key' });
  vi.spyOn(client, 'post').mockResolvedValue({
    session: { id: 'live_1' },
    transport: { type: 'webrtc', sdp: 'answer' },
  });
  const session = handleBrowser(browser.asWebSocket(), client);
  browser.message({ sdp: 'offer' });
  await vi.waitFor(() => expect(sidebands).toHaveLength(1));
  sidebands[0].emit('error', new Error('private handshake error'));
  await vi.waitFor(() => expect(sidebands).toHaveLength(2));
  sidebands[1].open();
  expect(sidebands[1].sent).toEqual([{ type: 'session.close' }]);
  for (const event of responseEvents()) sidebands[1].message(event);
  expect(sidebands[1].sent).toHaveLength(1);
  sidebands[1].message({
    type: 'session.closed',
    reason: 'close_requested',
    usage: { seconds: 1 },
  });
  await session;
  expect(browser.sent).toEqual([]);
});

it('passes a corrected self-contained request into a fresh specialist run', async () => {
  const model = new ScriptedModel([
    modelResponse([assistantMessage('A0042 is shipped.')]),
    modelResponse([assistantMessage('A0043 is processing.')]),
  ]);
  const send = vi.fn();
  const handler = new DelegationHandler(
    createOrderAgent(model),
    send,
    vi.fn(),
    vi.fn(),
  );
  for (const event of responseEvents()) handler.receive(event);
  await handler.settled();
  const correction =
    'Check the status of A0043. The user corrected A0042 to A0043.';
  for (const event of responseEvents(
    ['call_corrected'],
    'response_corrected',
    correction,
  ))
    handler.receive(event);
  await handler.settled();
  expect(model.calls[1].request.input).toHaveLength(1);
  expect(JSON.stringify(model.calls[1].request.input)).toContain(correction);
  expect(send.mock.calls[2][0].item).toMatchObject({
    call_id: 'call_corrected',
    output: 'A0043 is processing.',
  });
});

it.each([
  [400, 'Check the Live session configuration and browser SDP offer.'],
  [401, 'Check the server API key.'],
  [403, 'Check the API project permissions and GPT Live access.'],
  [429, 'Check the API project quota and rate limits.'],
  [503, 'OpenAI returned a server error. Try again later.'],
])(
  'reports HTTP %s without exposing API error payloads',
  async (status, hint) => {
    const browser = new Socket();
    browser.open();
    const client = new OpenAI({ apiKey: 'synthetic-test-key' });
    const error = new OpenAI.APIError(
      status,
      {
        message: 'private-response-body',
        code: 'private-code',
        param: 'private-param',
      },
      'private-exception-message',
      new Headers({
        'x-request-id': 'req_example_failure',
        authorization: 'private-header',
      }),
    );
    vi.spyOn(client, 'post').mockRejectedValue(error);
    const session = handleBrowser(browser.asWebSocket(), client);
    browser.message({ sdp: 'private-browser-sdp' });
    await session;
    const message = `Live session creation failed (HTTP ${status}). ${hint} Request ID: req_example_failure.`;
    expect(browser.sent).toEqual([{ type: 'error', message }]);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(message);
    expect(
      JSON.stringify([browser.sent, vi.mocked(console.error).mock.calls]),
    ).not.toContain('private-');
    expect(browser.readyState).toBe(WebSocket.CLOSED);
    expect(sidebands).toHaveLength(0);
  },
);

it.each([
  [
    new OpenAI.APIConnectionTimeoutError({ message: 'private-timeout' }),
    'Live session creation timed out. Check network connectivity and try again.',
  ],
  [
    new OpenAI.APIConnectionError({
      message: 'private-network',
      cause: new Error('private-cause'),
    }),
    'Live session creation could not reach OpenAI. Check network connectivity and proxy settings.',
  ],
  [
    new Error('private-unexpected'),
    'Live session creation failed. Check the browser connection and server configuration.',
  ],
])(
  'categorizes creation failures without raw exception details',
  async (error, message) => {
    const browser = new Socket();
    browser.open();
    const client = new OpenAI({ apiKey: 'synthetic-test-key' });
    vi.spyOn(client, 'post').mockRejectedValue(error);
    const session = handleBrowser(browser.asWebSocket(), client);
    browser.message({ sdp: 'offer' });
    await session;
    expect(browser.sent).toEqual([{ type: 'error', message }]);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(message);
    expect(browser.readyState).toBe(WebSocket.CLOSED);
  },
);

it('identifies an invalid browser offer before making an API request', async () => {
  const browser = new Socket();
  browser.open();
  const client = new OpenAI({ apiKey: 'synthetic-test-key' });
  const post = vi.spyOn(client, 'post');
  const session = handleBrowser(browser.asWebSocket(), client);
  browser.message({ sdp: '', sensitive: 'private-offer' });
  await session;
  expect(post).not.toHaveBeenCalled();
  const message =
    'Browser offer failed. Check the browser connection and server configuration.';
  expect(browser.sent).toEqual([{ type: 'error', message }]);
  expect(console.error).toHaveBeenCalledExactlyOnceWith(message);
});

it('forwards the browser SDP unchanged, including its final CRLF', async () => {
  const browser = new Socket();
  browser.open();
  const client = new OpenAI({ apiKey: 'synthetic-test-key' });
  const post = vi.spyOn(client, 'post').mockResolvedValue({
    session: { id: 'live_1' },
    transport: { type: 'webrtc', sdp: 'answer' },
  });
  const sdp = [
    'v=0',
    'o=- 123456 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
    '',
  ].join('\r\n');
  const session = handleBrowser(browser.asWebSocket(), client);
  browser.message({ sdp });
  await vi.waitFor(() => expect(sidebands).toHaveLength(1));
  expect(post).toHaveBeenCalledWith(
    '/live/sessions',
    expect.objectContaining({
      body: expect.objectContaining({ transport: { type: 'webrtc', sdp } }),
    }),
  );
  sidebands[0].open();
  expect(browser.sent).toEqual([{ type: 'answer', sdp: 'answer' }]);
  browser.message({ type: 'close' });
  sidebands[0].message({
    type: 'session.closed',
    reason: 'close_requested',
    usage: { seconds: 1 },
  });
  await session;
  expect(browser.readyState).toBe(WebSocket.CLOSED);
});

it('rejects a whitespace-only offer without creating a Live session', async () => {
  const browser = new Socket();
  browser.open();
  const client = new OpenAI({ apiKey: 'synthetic-test-key' });
  const post = vi.spyOn(client, 'post');
  const session = handleBrowser(browser.asWebSocket(), client);
  browser.message({ sdp: ' \r\n\t' });
  await session;
  expect(post).not.toHaveBeenCalled();
  expect(browser.sent[0].message).toContain('Browser offer failed.');
});
