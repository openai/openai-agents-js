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
import { textStream, vercelResponse } from '@openai/agents/ui';
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
    const plain = new Response(
      textStream(turn).pipeThrough(new TextEncoderStream()),
    );
    const [values, text] = await Promise.all([frames(response), plain.text()]);
    expect(text).toBe('Found it.');
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

const start: Extract<Observation, { type: 'turn_started' }> = {
  type: 'turn_started',
  sessionId: 's',
  submissionId: 'submission',
  turnId: 't',
  sequence: 1,
};
function fixture(
  observations: Observation[],
  items: SessionItem[] = [],
  finalOutput = '',
) {
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
        return { finalOutput };
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

function displayedMessage(
  id: string,
  text: string,
  phase: 'commentary' | 'final_answer' | null = null,
): SessionItem {
  return {
    id,
    turnId: 't',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    phase,
    content: [{ type: 'output_text', text }],
  };
}

function textFixture(
  deltas: readonly (readonly [string, string])[],
  items: SessionItem[],
  output: string,
) {
  return fixture(
    [
      start,
      ...deltas.map(([itemId, delta], index): Observation => ({
        ...start,
        type: 'output_text_delta',
        itemId,
        delta,
        sequence: index + 2,
      })),
    ],
    items,
    output,
  );
}

function shownText(values: any[], id: string): string {
  return values
    .filter((value) => value.type === 'text-delta' && value.id === id)
    .map((value) => value.delta)
    .join('');
}

it.each([
  ['retained commentary', 'Final answer.'],
  ['retained commentary', ''],
  ['', 'Final answer.'],
  ['', ''],
])(
  'checks done-only commentary before finish (commentary=%j, final=%j)',
  async (commentary, output) => {
    const { turn, session } = textFixture(
      output ? [['answer', output]] : [],
      [
        displayedMessage('commentary', commentary, 'commentary'),
        displayedMessage('answer', output, 'final_answer'),
      ],
      output,
    );
    const values = await frames(vercelResponse(turn, session));
    expect(values.slice(-2)).toEqual([
      commentary
        ? { type: 'error', errorText: 'resync_required' }
        : { type: 'finish' },
      '[DONE]',
    ]);
    expect(shownText(values, 'answer')).toBe(output);
    expect(await turn.wait()).toEqual({ finalOutput: output });
  },
);

it('preserves many small interleaved ASCII and Unicode deltas through canonical settlement', async () => {
  const left = 'a'.repeat(64),
    right = '🙂'.repeat(16);
  const deltas = Array.from(
    { length: 3200 },
    () =>
      [
        ['left', left],
        ['right', right],
      ] as const,
  ).flat();
  const leftText = left.repeat(3200),
    rightText = right.repeat(3200);
  const { turn, session } = textFixture(
    deltas,
    [
      displayedMessage('left', leftText),
      displayedMessage('right', rightText, 'final_answer'),
    ],
    rightText,
  );
  const values = await frames(vercelResponse(turn, session));
  expect(shownText(values, 'left')).toBe(leftText);
  expect(shownText(values, 'right')).toBe(rightText);
  expect(values.slice(-2)).toEqual([{ type: 'finish' }, '[DONE]']);
});

it.each([false, true])(
  'counts a split Unicode pair across empty and interleaved deltas at the byte cap (extra=%s)',
  async (extra) => {
    const filler = 'x'.repeat(1_048_576 - 4);
    const deltas: [string, string][] = [
      ['unicode', '\ud83d'],
      ['filler', filler],
      ['unicode', ''],
      ['unicode', '\ude42'],
      ...(extra ? [['filler', 'x'] as [string, string]] : []),
    ];
    const { turn, session } = textFixture(
      deltas,
      [
        displayedMessage('filler', filler),
        displayedMessage('unicode', '🙂', 'final_answer'),
      ],
      '🙂',
    );
    const values = await frames(vercelResponse(turn, session));
    expect(shownText(values, 'unicode')).toBe('🙂');
    expect(shownText(values, 'filler')).toBe(filler);
    expect(values.slice(-2)).toEqual([
      extra
        ? { type: 'error', errorText: 'resync_required' }
        : { type: 'finish' },
      '[DONE]',
    ]);
    expect(await turn.wait()).toEqual({ finalOutput: '🙂' });
  },
);

it.each([false, true])(
  'counts unpaired surrogates in different items separately (extra=%s)',
  async (extra) => {
    const filler = 'x'.repeat(1_048_576 - 6);
    const { turn, session } = textFixture(
      [
        ['high', '\ud83d'],
        ['low', '\ude42'],
        ['filler', filler],
        ...(extra ? [['filler', 'x'] as const] : []),
      ],
      [
        displayedMessage('high', '\ud83d'),
        displayedMessage('low', '\ude42'),
        displayedMessage('filler', filler, 'final_answer'),
      ],
      filler,
    );
    const values = await frames(vercelResponse(turn, session));
    expect(shownText(values, 'high')).toBe('\ud83d');
    expect(shownText(values, 'low')).toBe('\ude42');
    expect(shownText(values, 'filler')).toBe(filler);
    expect(values.slice(-2)).toEqual([
      extra
        ? { type: 'error', errorText: 'resync_required' }
        : { type: 'finish' },
      '[DONE]',
    ]);
  },
);

it.each([256, 257])(
  'retains at most 256 distinct empty text parts (count=%i)',
  async (count) => {
    const ids = Array.from({ length: count }, (_, index) => `part-${index}`);
    const { turn, session } = textFixture(
      ids.map((id) => [id, '']),
      ids.map((id) => displayedMessage(id, '')),
      '',
    );
    const values = await frames(vercelResponse(turn, session));
    expect(values.filter((value) => value.type === 'text-start')).toHaveLength(
      256,
    );
    expect(values.filter((value) => value.type === 'text-end')).toHaveLength(
      256,
    );
    expect(values.slice(-2)).toEqual([
      count === 256
        ? { type: 'finish' }
        : { type: 'error', errorText: 'resync_required' },
      '[DONE]',
    ]);
  },
);

it('accounts for the latest canonical text when a retained message ID is replaced', async () => {
  const other = 'y'.repeat(700 * 1024);
  const { turn, session } = textFixture(
    [
      ['other', other],
      ['answer', 'Final.'],
    ],
    [
      displayedMessage('answer', 'x'.repeat(700 * 1024)),
      displayedMessage('answer', 'Final.'),
      displayedMessage('other', other),
      displayedMessage('answer', 'Final.', 'final_answer'),
    ],
    'Final.',
  );
  const values = await frames(vercelResponse(turn, session));
  expect(shownText(values, 'answer')).toBe('Final.');
  expect(values.slice(-2)).toEqual([{ type: 'finish' }, '[DONE]']);
});

it.each([false, true])(
  'rejects unstreamed canonical text within and beyond its byte cap (extra=%s)',
  async (extra) => {
    const filler = 'x'.repeat(1_048_576 - 2 + (extra ? 1 : 0));
    const { turn, session } = textFixture(
      [['answer', 'ok']],
      [
        displayedMessage('not-shown', filler),
        displayedMessage('answer', 'ok', 'final_answer'),
      ],
      'ok',
    );
    const values = await frames(vercelResponse(turn, session));
    expect(shownText(values, 'answer')).toBe('ok');
    expect(values.slice(-2)).toEqual([
      { type: 'error', errorText: 'resync_required' },
      '[DONE]',
    ]);
  },
);
