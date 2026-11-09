import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { DefaultChatTransport, readUIMessageStream } from 'ai';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  tool,
  type Observation,
  type SessionItem,
} from '@openai/agents';
import { vercelResponse } from '@openai/agents/ui';
import { call } from './fixtures/model-server';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Actual Responses text deltas and function calls through the native engine. */
async function peer() {
  let requests = 0;
  const scripts = [
    call('lookup', { key: 'earlier-secret' }, { callId: 'old-call' }),
    'old answer',
    call('lookup', { key: 'current-secret' }, { callId: 'current-call' }),
    'Found it.',
  ];
  const server = createServer(async (request, response) => {
    for await (const _ of request) {
      /* Drain native request. */
    }
    const selected = scripts[requests++];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (value: unknown) =>
      response.write(`data: ${JSON.stringify(value)}\n\n`);
    send({ type: 'response.created', response: { id: `r${requests}` } });
    if (typeof selected === 'string') {
      const item = {
        id: `message-${requests}`,
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        status: 'completed',
        content: [{ type: 'output_text', text: selected }],
      };
      send({
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      });
      send({
        type: 'response.content_part.added',
        output_index: 0,
        content_index: 0,
        item_id: item.id,
        part: { type: 'output_text', text: '' },
      });
      send({
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        item_id: item.id,
        delta: selected,
      });
      send({
        type: 'response.output_text.done',
        output_index: 0,
        content_index: 0,
        item_id: item.id,
        text: selected,
      });
      send({ type: 'response.output_item.done', output_index: 0, item });
    } else {
      send({
        type: 'response.output_item.done',
        output_index: 0,
        item: selected,
      });
    }
    send({ type: 'response.completed', response: { id: `r${requests}` } });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture address');
  return new NativeProvider({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}

function lookup() {
  return tool({
    name: 'lookup',
    description: 'Read a record.',
    parameters: z.object({ key: z.string() }),
    execute: ({ key }) => `result:${key}`,
  });
}

async function frames(response: Response) {
  return (await response.text())
    .split('\n\n')
    .filter(Boolean)
    .map((line) => {
      const value = line.slice(6);
      return value === '[DONE]' ? value : JSON.parse(value);
    });
}

it.each([false, true])(
  'public native stream preserves text, privacy and exact turn (%s)',
  async (includeToolData) => {
    await using provider = await peer();
    await using session = await new Agent({
      instructions: 'Read.',
      provider,
      tools: [lookup()],
    }).session();
    await (await session.submit('earlier')).wait();
    const turn = await session.submit('current');
    const response = vercelResponse(turn, session, { includeToolData });
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    const values = await frames(response);
    expect(values.slice(-2)).toEqual([{ type: 'finish' }, '[DONE]']);
    expect(
      values
        .filter((value) => value.type === 'text-delta')
        .map((value) => value.delta),
    ).toEqual(['Found it.']);
    expect(JSON.stringify(values)).not.toContain('earlier-secret');
    expect(JSON.stringify(values)).not.toContain('old-call');
    if (includeToolData) {
      expect(values).toContainEqual({
        type: 'tool-input-available',
        toolCallId: 'current-call',
        toolName: 'lookup',
        input: { key: 'current-secret' },
        dynamic: true,
      });
      const output = values.find(
        (value) => value.type === 'tool-output-available',
      );
      expect(output.toolCallId).toBe('current-call');
      expect(JSON.stringify(output.output)).toContain('result:current-secret');
    } else expect(JSON.stringify(values)).not.toContain('current-secret');
  },
);

it('official AI SDK client consumes native text/tool/terminal frames', async () => {
  await using provider = await peer();
  await using session = await new Agent({
    instructions: 'Read.',
    provider,
    tools: [lookup()],
  }).session();
  await (await session.submit('earlier')).wait();
  const turn = await session.submit('current');
  const transport = new DefaultChatTransport({
    fetch: async () => vercelResponse(turn, session, { includeToolData: true }),
  });
  const chunks = await transport.sendMessages({
    trigger: 'submit-message',
    chatId: 'test',
    messageId: undefined,
    messages: [],
    abortSignal: undefined,
  });
  const snapshots = await Array.fromAsync(
    readUIMessageStream({ stream: chunks, terminateOnError: true }),
  );
  const final = snapshots.at(-1)!;
  expect(final.parts).toContainEqual({
    type: 'text',
    text: 'Found it.',
    state: 'done',
  });
  const part = final.parts.find((part) => part.type === 'dynamic-tool');
  expect(part).toMatchObject({
    type: 'dynamic-tool',
    toolName: 'lookup',
    toolCallId: 'current-call',
    state: 'output-available',
    input: { key: 'current-secret' },
  });
  expect(JSON.stringify(part)).toContain('result:current-secret');
  expect((await turn.wait()).finalOutput).toBe('Found it.');
});

it('disconnect releases the public reader without stopping its native turn', async () => {
  await using provider = await peer();
  await using session = await new Agent({
    instructions: 'Read.',
    provider,
    tools: [lookup()],
  }).session();
  const turn = await session.submit('earlier');
  const reader = vercelResponse(turn, session).body!.getReader();
  await reader.read();
  await reader.cancel();
  expect((await turn.wait()).finalOutput).toBe('old answer');
});

const start: Observation = {
  type: 'turn_started',
  sessionId: 's',
  submissionId: 'submission',
  turnId: 't',
  sequence: 1,
};
function fixture(observations: Observation[], items: SessionItem[] = []) {
  return {
    turn: {
      sessionId: 's',
      submissionId: 'submission',
      turnId: 't',
      childId: null,
      events: () =>
        (async function* () {
          yield* observations;
        })(),
      async wait() {
        return { finalOutput: '' };
      },
    },
    session: {
      id: 's',
      async *items() {
        yield* items;
      },
    },
  };
}

it('gap after the exact start fails closed with one terminal', async () => {
  const { turn, session } = fixture([
    start,
    { type: 'gap', sessionId: 's', sequence: 4, firstSequence: 2 },
  ]);
  const values = await frames(vercelResponse(turn, session));
  expect(values).toEqual([
    { type: 'start' },
    { type: 'error', errorText: 'resync_required' },
    '[DONE]',
  ]);
});

it('MCP retained completion enriches its function call without duplicate UI tools', async () => {
  const identity = { id: 'call', turnId: 't' };
  const { turn, session } = fixture(
    [start],
    [
      {
        ...identity,
        type: 'function_call',
        callId: 'call',
        name: 'mcp__docs.search',
        arguments: '{"key":"43"}',
        status: 'completed',
      },
      {
        ...identity,
        type: 'function_call_output',
        callId: 'call',
        status: 'completed',
        output: 'retained wire result',
        error: null,
      },
      {
        ...identity,
        type: 'mcp_call',
        callId: 'call',
        name: 'search',
        serverLabel: 'docs',
        arguments: { key: '43' },
        status: 'completed',
        output: { content: [{ type: 'text', text: 'record' }] },
        error: null,
      },
    ],
  );
  const values = await frames(
    vercelResponse(turn, session, { includeToolData: true }),
  );
  expect(
    values.filter((value) => value.type === 'tool-input-available'),
  ).toEqual([
    {
      type: 'tool-input-available',
      toolCallId: 'call',
      toolName: 'docs.search',
      input: { key: '43' },
      dynamic: true,
    },
  ]);
  expect(values).toContainEqual({
    type: 'tool-output-available',
    toolCallId: 'call',
    output: { content: [{ type: 'text', text: 'record' }] },
    dynamic: true,
  });
  expect(values.slice(-2)).toEqual([{ type: 'finish' }, '[DONE]']);
});

it('bounds streamed text without cancelling the underlying turn', async () => {
  const { turn, session } = fixture([
    start,
    {
      ...start,
      type: 'output_text_delta',
      itemId: 'large',
      delta: 'x'.repeat(1_048_577),
    },
  ]);
  const values = await frames(vercelResponse(turn, session));
  expect(values).toEqual([
    { type: 'start' },
    { type: 'error', errorText: 'resync_required' },
    '[DONE]',
  ]);
  expect(await turn.wait()).toEqual({ finalOutput: '' });
});
