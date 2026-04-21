import { describe, expect, test } from 'vitest';
import {
  Agent,
  RunItemStreamEvent,
  RunRawModelStreamEvent,
  RunMessageOutputItem,
  RunReasoningItem,
  RunToolApprovalItem,
  RunToolCallItem,
  RunToolCallOutputItem,
  RunToolSearchCallItem,
  RunToolSearchOutputItem,
} from '@openai/agents';
import type { RunStreamEvent } from '@openai/agents';
import type { UIMessageChunk } from 'ai';
import {
  createAiSdkUiMessageStream,
  createAiSdkUiMessageStreamResponse,
} from '../../src/ai-sdk-ui/index';

async function readResponseText(response: Response): Promise<string> {
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    output += decoder.decode(value, { stream: true });
  }

  output += decoder.decode();
  return output;
}

async function readUiMessageChunks(
  response: Response,
): Promise<UIMessageChunk[]> {
  const raw = await readResponseText(response);
  const chunks: UIMessageChunk[] = [];

  for (const block of raw.split('\n\n')) {
    const line = block.trim();
    if (!line) {
      continue;
    }
    if (!line.startsWith('data: ')) {
      continue;
    }

    const payload = line.slice('data: '.length);
    if (payload === '[DONE]') {
      continue;
    }

    chunks.push(JSON.parse(payload));
  }

  return chunks;
}

async function readUiMessageStream(
  stream: ReadableStream<UIMessageChunk>,
): Promise<UIMessageChunk[]> {
  const reader = stream.getReader();
  const chunks: UIMessageChunk[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return chunks;
}

function createRunEventStream(
  events: RunStreamEvent[],
): ReadableStream<RunStreamEvent> {
  return new ReadableStream<RunStreamEvent>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(event);
      }
      controller.close();
    },
  });
}

describe('createAiSdkUiMessageStreamResponse', () => {
  test('creates a raw UI message chunk stream from toStream sources', async () => {
    const agent = new Agent({ name: 'Test Agent' });

    const messageOutput = new RunMessageOutputItem(
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Raw stream message' }],
      },
      agent,
    );

    const stream = createAiSdkUiMessageStream({
      toStream: () =>
        createRunEventStream([
          new RunItemStreamEvent('message_output_created', messageOutput),
        ]),
    });

    const chunks = await readUiMessageStream(stream);

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ]);

    const textDelta = chunks.find((chunk) => chunk.type === 'text-delta');
    expect(textDelta).toMatchObject({ delta: 'Raw stream message' });
  });

  test('cancels the underlying event iterator when a raw stream is cancelled', async () => {
    let cancelled = false;

    const events = (async function* () {
      try {
        yield new RunRawModelStreamEvent({ type: 'response_started' });
        yield new RunRawModelStreamEvent({
          type: 'output_text_delta',
          delta: 'unread',
        });
      } finally {
        cancelled = true;
      }
    })();

    const stream = createAiSdkUiMessageStream(events);
    const reader = stream.getReader();

    const first = await reader.read();
    expect(first).toMatchObject({
      done: false,
      value: { type: 'start' },
    });

    await reader.cancel();

    expect(cancelled).toBe(true);
  });

  test('maps run stream events to UI message chunks', async () => {
    const agent = new Agent({ name: 'Test Agent' });

    const toolCall = new RunToolCallItem(
      {
        type: 'function_call',
        callId: 'call-1',
        name: 'get_weather',
        arguments: JSON.stringify({ city: 'Berlin' }),
      },
      agent,
    );

    const toolOutput = new RunToolCallOutputItem(
      {
        type: 'function_call_result',
        callId: 'call-1',
        name: 'get_weather',
        status: 'completed',
        output: 'Clear skies',
      },
      agent,
      'Clear skies',
    );

    const reasoningItem = new RunReasoningItem(
      {
        type: 'reasoning',
        content: [{ type: 'input_text', text: 'Reasoning summary' }],
      },
      agent,
    );

    const events = (async function* () {
      yield new RunRawModelStreamEvent({ type: 'response_started' });
      yield new RunRawModelStreamEvent({
        type: 'output_text_delta',
        delta: 'Hello',
      });
      yield new RunItemStreamEvent('tool_called', toolCall);
      yield new RunItemStreamEvent('tool_output', toolOutput);
      yield new RunItemStreamEvent('reasoning_item_created', reasoningItem);
      yield new RunRawModelStreamEvent({
        type: 'response_done',
        response: {
          id: 'resp-1',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
          output: [{ type: 'unknown' }],
        },
      });
    })();

    const response = createAiSdkUiMessageStreamResponse(events);

    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const chunks = await readUiMessageChunks(response);
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'tool-input-start',
      'tool-input-available',
      'tool-output-available',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'text-end',
      'finish-step',
      'finish',
    ]);

    const textStart = chunks.find((chunk) => chunk.type === 'text-start') as
      | { id: string }
      | undefined;
    const textEnd = chunks.find((chunk) => chunk.type === 'text-end');
    const textDelta = chunks.find((chunk) => chunk.type === 'text-delta');
    const textStartId = textStart?.id;

    expect(textStart).toBeDefined();
    expect(textEnd).toBeDefined();
    expect(textDelta).toMatchObject({ delta: 'Hello' });
    expect(textEnd).toMatchObject({ id: textStartId });

    const toolInput = chunks.find(
      (chunk) => chunk.type === 'tool-input-available',
    );
    const toolOutputChunk = chunks.find(
      (chunk) => chunk.type === 'tool-output-available',
    );

    expect(toolInput).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'get_weather',
      input: { city: 'Berlin' },
      dynamic: true,
    });

    expect(toolOutputChunk).toMatchObject({
      toolCallId: 'call-1',
      output: 'Clear skies',
      dynamic: true,
    });

    const reasoningDelta = chunks.find(
      (chunk) => chunk.type === 'reasoning-delta',
    );
    expect(reasoningDelta).toMatchObject({ delta: 'Reasoning summary' });
  });

  test('emits finish after run-item events when response_done arrives early', async () => {
    const agent = new Agent({ name: 'Test Agent' });

    const toolCall = new RunToolCallItem(
      {
        type: 'function_call',
        callId: 'call-early',
        name: 'get_weather',
        arguments: JSON.stringify({ city: 'Tokyo' }),
      },
      agent,
    );

    const toolOutput = new RunToolCallOutputItem(
      {
        type: 'function_call_result',
        callId: 'call-early',
        name: 'get_weather',
        status: 'completed',
        output: 'Sunny',
      },
      agent,
      'Sunny',
    );

    const reasoningItem = new RunReasoningItem(
      {
        type: 'reasoning',
        content: [{ type: 'input_text', text: 'Tool follow-up' }],
      },
      agent,
    );

    const events = (async function* () {
      yield new RunRawModelStreamEvent({ type: 'response_started' });
      yield new RunRawModelStreamEvent({
        type: 'output_text_delta',
        delta: 'Hi',
      });
      yield new RunRawModelStreamEvent({
        type: 'response_done',
        response: {
          id: 'resp-early',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
          output: [{ type: 'unknown' }],
        },
      });
      yield new RunItemStreamEvent('tool_called', toolCall);
      yield new RunItemStreamEvent('tool_output', toolOutput);
      yield new RunItemStreamEvent('reasoning_item_created', reasoningItem);
    })();

    const response = createAiSdkUiMessageStreamResponse(events);
    const chunks = await readUiMessageChunks(response);
    const types = chunks.map((chunk) => chunk.type);

    expect(types.at(-1)).toBe('finish');
    expect(types.indexOf('tool-input-available')).toBeGreaterThan(-1);
    expect(types.indexOf('tool-output-available')).toBeGreaterThan(-1);
    expect(types.indexOf('reasoning-delta')).toBeGreaterThan(-1);
    expect(types.indexOf('finish')).toBe(types.length - 1);
  });

  test('emits message output when no text deltas are streamed', async () => {
    const agent = new Agent({ name: 'Test Agent' });

    const messageOutput = new RunMessageOutputItem(
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Fallback message' }],
      },
      agent,
    );

    const events = (async function* () {
      yield new RunItemStreamEvent('message_output_created', messageOutput);
    })();

    const response = createAiSdkUiMessageStreamResponse(events);
    const chunks = await readUiMessageChunks(response);

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ]);

    const textDelta = chunks.find((chunk) => chunk.type === 'text-delta');
    expect(textDelta).toMatchObject({ delta: 'Fallback message' });
  });

  test('emits hosted tool output from tool_called when output is inline', async () => {
    const agent = new Agent({ name: 'Test Agent' });

    const toolCall = new RunToolCallItem(
      {
        type: 'hosted_tool_call',
        id: 'call-1',
        name: 'web_search_call',
        status: 'completed',
        arguments: JSON.stringify({ query: 'OpenAI' }),
        output: 'Inline results',
      },
      agent,
    );

    const events = (async function* () {
      yield new RunItemStreamEvent('tool_called', toolCall);
    })();

    const response = createAiSdkUiMessageStreamResponse(events);
    const chunks = await readUiMessageChunks(response);

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'start',
      'tool-input-start',
      'tool-input-available',
      'tool-output-available',
      'finish',
    ]);

    const toolOutput = chunks.find(
      (chunk) => chunk.type === 'tool-output-available',
    );
    expect(toolOutput).toMatchObject({
      toolCallId: 'call-1',
      output: 'Inline results',
      dynamic: true,
    });
  });

  test('preserves namespaced tool names and emits tool_search events', async () => {
    const agent = new Agent({ name: 'Test Agent' });

    const toolSearchCall = new RunToolSearchCallItem(
      {
        type: 'tool_search_call',
        id: 'tool-search-call-1',
        status: 'completed',
        arguments: {
          paths: ['crm'],
          query: 'lookup account',
        },
      },
      agent,
    );

    const toolSearchOutput = new RunToolSearchOutputItem(
      {
        type: 'tool_search_output',
        id: 'tool-search-output-1',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_account',
            namespace: 'crm',
          },
        ],
      },
      agent,
    );

    const namespacedToolCall = new RunToolCallItem(
      {
        type: 'function_call',
        callId: 'call-namespace-1',
        name: 'lookup_account',
        namespace: 'crm',
        arguments: JSON.stringify({ accountId: 'acct_42' }),
      },
      agent,
    );

    const events = (async function* () {
      yield new RunItemStreamEvent('tool_search_called', toolSearchCall);
      yield new RunItemStreamEvent(
        'tool_search_output_created',
        toolSearchOutput,
      );
      yield new RunItemStreamEvent('tool_called', namespacedToolCall);
    })();

    const response = createAiSdkUiMessageStreamResponse(events);
    const chunks = await readUiMessageChunks(response);

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'start',
      'tool-input-start',
      'tool-input-available',
      'tool-output-available',
      'tool-input-start',
      'tool-input-available',
      'finish',
    ]);

    const toolSearchInput = chunks.find(
      (chunk) =>
        chunk.type === 'tool-input-available' &&
        (chunk as any).toolName === 'tool_search',
    );
    const toolSearchOutputChunk = chunks.find(
      (chunk) => chunk.type === 'tool-output-available',
    );
    const namespacedInput = chunks.find(
      (chunk) =>
        chunk.type === 'tool-input-available' &&
        (chunk as any).toolName === 'crm.lookup_account',
    );

    expect(toolSearchInput).toMatchObject({
      toolCallId: 'tool-search-call-1',
      toolName: 'tool_search',
      input: {
        paths: ['crm'],
        query: 'lookup account',
      },
      dynamic: true,
    });
    expect(toolSearchOutputChunk).toMatchObject({
      toolCallId: 'tool-search-call-1',
      output: [
        {
          type: 'tool_reference',
          functionName: 'lookup_account',
          namespace: 'crm',
        },
      ],
      dynamic: true,
    });
    expect(namespacedInput).toMatchObject({
      toolCallId: 'call-namespace-1',
      toolName: 'crm.lookup_account',
      input: { accountId: 'acct_42' },
      dynamic: true,
    });
  });

  test('matches tool_search outputs by call_id when outputs arrive out of order', async () => {
    const agent = new Agent({ name: 'Test Agent' });

    const toolSearchCall1 = new RunToolSearchCallItem(
      {
        type: 'tool_search_call',
        id: 'tool-search-call-1',
        status: 'completed',
        arguments: {
          paths: ['crm'],
          query: 'lookup account',
        },
        providerData: {
          call_id: 'call-ts-1',
        },
      },
      agent,
    );
    const toolSearchCall2 = new RunToolSearchCallItem(
      {
        type: 'tool_search_call',
        id: 'tool-search-call-2',
        status: 'completed',
        arguments: {
          paths: ['billing'],
          query: 'lookup invoice',
        },
        providerData: {
          call_id: 'call-ts-2',
        },
      },
      agent,
    );

    const toolSearchOutput2 = new RunToolSearchOutputItem(
      {
        type: 'tool_search_output',
        id: 'tool-search-output-2',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_invoice',
            namespace: 'billing',
          },
        ],
        providerData: {
          call_id: 'call-ts-2',
        },
      },
      agent,
    );
    const toolSearchOutput1 = new RunToolSearchOutputItem(
      {
        type: 'tool_search_output',
        id: 'tool-search-output-1',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_account',
            namespace: 'crm',
          },
        ],
        providerData: {
          call_id: 'call-ts-1',
        },
      },
      agent,
    );

    const events = (async function* () {
      yield new RunItemStreamEvent('tool_search_called', toolSearchCall1);
      yield new RunItemStreamEvent('tool_search_called', toolSearchCall2);
      yield new RunItemStreamEvent(
        'tool_search_output_created',
        toolSearchOutput2,
      );
      yield new RunItemStreamEvent(
        'tool_search_output_created',
        toolSearchOutput1,
      );
    })();

    const response = createAiSdkUiMessageStreamResponse(events);
    const chunks = await readUiMessageChunks(response);
    const outputs = chunks.filter(
      (chunk) => chunk.type === 'tool-output-available',
    );

    expect(outputs).toEqual([
      {
        type: 'tool-output-available',
        toolCallId: 'call-ts-2',
        output: [
          {
            type: 'tool_reference',
            functionName: 'lookup_invoice',
            namespace: 'billing',
          },
        ],
        dynamic: true,
      },
      {
        type: 'tool-output-available',
        toolCallId: 'call-ts-1',
        output: [
          {
            type: 'tool_reference',
            functionName: 'lookup_account',
            namespace: 'crm',
          },
        ],
        dynamic: true,
      },
    ]);
  });

  test('does not let server tool_search outputs without call_id consume pending client searches', async () => {
    const agent = new Agent({ name: 'Test Agent' });

    const toolSearchCall = new RunToolSearchCallItem(
      {
        type: 'tool_search_call',
        id: 'tool-search-call-client',
        status: 'completed',
        arguments: {
          paths: ['crm'],
          query: 'lookup account',
        },
        providerData: {
          execution: 'client',
        },
      },
      agent,
    );
    const serverOutput = new RunToolSearchOutputItem(
      {
        type: 'tool_search_output',
        id: 'tool-search-output-server',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_invoice',
            namespace: 'billing',
          },
        ],
        providerData: {
          execution: 'server',
        },
      },
      agent,
    );
    const clientOutput = new RunToolSearchOutputItem(
      {
        type: 'tool_search_output',
        id: 'tool-search-output-client',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_account',
            namespace: 'crm',
          },
        ],
        providerData: {
          execution: 'client',
        },
      },
      agent,
    );

    const events = (async function* () {
      yield new RunItemStreamEvent('tool_search_called', toolSearchCall);
      yield new RunItemStreamEvent('tool_search_output_created', serverOutput);
      yield new RunItemStreamEvent('tool_search_output_created', clientOutput);
    })();

    const response = createAiSdkUiMessageStreamResponse(events);
    const chunks = await readUiMessageChunks(response);
    const outputs = chunks.filter(
      (chunk) => chunk.type === 'tool-output-available',
    );

    expect(outputs).toEqual([
      {
        type: 'tool-output-available',
        toolCallId: 'tool-search-output-server',
        output: [
          {
            type: 'tool_reference',
            functionName: 'lookup_invoice',
            namespace: 'billing',
          },
        ],
        dynamic: true,
      },
      {
        type: 'tool-output-available',
        toolCallId: 'tool-search-call-client',
        output: [
          {
            type: 'tool_reference',
            functionName: 'lookup_account',
            namespace: 'crm',
          },
        ],
        dynamic: true,
      },
    ]);
  });

  test('does not queue hosted tool_search calls as pending client searches in streamed events', async () => {
    const agent = new Agent({ name: 'Test Agent' });

    const serverCall = new RunToolSearchCallItem(
      {
        type: 'tool_search_call',
        id: 'tool-search-call-server',
        status: 'completed',
        arguments: {
          paths: ['billing'],
          query: 'lookup invoice',
        },
        providerData: {
          call_id: 'ts_call_server',
          execution: 'server',
        },
      },
      agent,
    );
    const serverOutput = new RunToolSearchOutputItem(
      {
        type: 'tool_search_output',
        id: 'tool-search-output-server',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_invoice',
            namespace: 'billing',
          },
        ],
        providerData: {
          execution: 'server',
        },
      },
      agent,
    );
    const clientCall = new RunToolSearchCallItem(
      {
        type: 'tool_search_call',
        id: 'tool-search-call-client',
        status: 'completed',
        arguments: {
          paths: ['crm'],
          query: 'lookup account',
        },
        providerData: {
          call_id: 'ts_call_client',
          execution: 'client',
        },
      },
      agent,
    );
    const clientOutput = new RunToolSearchOutputItem(
      {
        type: 'tool_search_output',
        id: 'tool-search-output-client',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_account',
            namespace: 'crm',
          },
        ],
        providerData: {
          execution: 'client',
        },
      },
      agent,
    );

    const events = (async function* () {
      yield new RunItemStreamEvent('tool_search_called', serverCall);
      yield new RunItemStreamEvent('tool_search_output_created', serverOutput);
      yield new RunItemStreamEvent('tool_search_called', clientCall);
      yield new RunItemStreamEvent('tool_search_output_created', clientOutput);
    })();

    const response = createAiSdkUiMessageStreamResponse(events);
    const chunks = await readUiMessageChunks(response);
    const outputs = chunks.filter(
      (chunk) => chunk.type === 'tool-output-available',
    );

    expect(outputs).toEqual([
      {
        type: 'tool-output-available',
        toolCallId: 'ts_call_server',
        output: [
          {
            type: 'tool_reference',
            functionName: 'lookup_invoice',
            namespace: 'billing',
          },
        ],
        dynamic: true,
      },
      {
        type: 'tool-output-available',
        toolCallId: 'ts_call_client',
        output: [
          {
            type: 'tool_reference',
            functionName: 'lookup_account',
            namespace: 'crm',
          },
        ],
        dynamic: true,
      },
    ]);
  });

  test('reuses hosted tool_search call ids when streamed server outputs omit call_id', async () => {
    const agent = new Agent({ name: 'Test Agent' });

    const serverCall = new RunToolSearchCallItem(
      {
        type: 'tool_search_call',
        id: 'tool-search-call-server',
        status: 'completed',
        arguments: {
          paths: ['billing'],
          query: 'lookup invoice',
        },
        providerData: {
          execution: 'server',
        },
      },
      agent,
    );
    const serverOutput = new RunToolSearchOutputItem(
      {
        type: 'tool_search_output',
        id: 'tool-search-output-server',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_invoice',
            namespace: 'billing',
          },
        ],
        providerData: {
          execution: 'server',
        },
      },
      agent,
    );

    const events = (async function* () {
      yield new RunItemStreamEvent('tool_search_called', serverCall);
      yield new RunItemStreamEvent('tool_search_output_created', serverOutput);
    })();

    const response = createAiSdkUiMessageStreamResponse(events);
    const chunks = await readUiMessageChunks(response);
    const outputs = chunks.filter(
      (chunk) => chunk.type === 'tool-output-available',
    );

    expect(outputs).toEqual([
      {
        type: 'tool-output-available',
        toolCallId: 'tool-search-call-server',
        output: [
          {
            type: 'tool_reference',
            functionName: 'lookup_invoice',
            namespace: 'billing',
          },
        ],
        dynamic: true,
      },
    ]);
  });

  test('emits updated tool_search outputs when the same call_id repeats', async () => {
    const agent = new Agent({ name: 'Test Agent' });

    const toolSearchCall = new RunToolSearchCallItem(
      {
        type: 'tool_search_call',
        id: 'tool-search-call-1',
        status: 'completed',
        arguments: {
          paths: ['crm'],
          query: 'lookup account',
        },
        providerData: {
          call_id: 'call-ts-1',
        },
      },
      agent,
    );
    const staleOutput = new RunToolSearchOutputItem(
      {
        type: 'tool_search_output',
        id: 'tool-search-output-stale',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_account_old',
            namespace: 'crm',
          },
        ],
        providerData: {
          call_id: 'call-ts-1',
        },
      },
      agent,
    );
    const freshOutput = new RunToolSearchOutputItem(
      {
        type: 'tool_search_output',
        id: 'tool-search-output-fresh',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_account',
            namespace: 'crm',
          },
        ],
        providerData: {
          call_id: 'call-ts-1',
        },
      },
      agent,
    );

    const events = (async function* () {
      yield new RunItemStreamEvent('tool_search_called', toolSearchCall);
      yield new RunItemStreamEvent('tool_search_output_created', staleOutput);
      yield new RunItemStreamEvent('tool_search_output_created', freshOutput);
    })();

    const response = createAiSdkUiMessageStreamResponse(events);
    const chunks = await readUiMessageChunks(response);
    const outputs = chunks.filter(
      (chunk) => chunk.type === 'tool-output-available',
    );

    expect(outputs).toEqual([
      {
        type: 'tool-output-available',
        toolCallId: 'call-ts-1',
        output: [
          {
            type: 'tool_reference',
            functionName: 'lookup_account_old',
            namespace: 'crm',
          },
        ],
        dynamic: true,
      },
      {
        type: 'tool-output-available',
        toolCallId: 'call-ts-1',
        output: [
          {
            type: 'tool_reference',
            functionName: 'lookup_account',
            namespace: 'crm',
          },
        ],
        dynamic: true,
      },
    ]);
  });

  test('collapses same-name namespace tool names in streamed events', async () => {
    const agent = new Agent({ name: 'Test Agent' });

    const namespacedToolCall = new RunToolCallItem(
      {
        type: 'function_call',
        callId: 'call-namespace-self-1',
        name: 'lookup_account',
        namespace: 'lookup_account',
        arguments: JSON.stringify({ accountId: 'acct_42' }),
      },
      agent,
    );

    const events = (async function* () {
      yield new RunItemStreamEvent('tool_called', namespacedToolCall);
    })();

    const response = createAiSdkUiMessageStreamResponse(events);
    const chunks = await readUiMessageChunks(response);

    const namespacedInput = chunks.find(
      (chunk) =>
        chunk.type === 'tool-input-available' &&
        (chunk as any).toolCallId === 'call-namespace-self-1',
    );

    expect(namespacedInput).toMatchObject({
      toolCallId: 'call-namespace-self-1',
      toolName: 'lookup_account',
      input: { accountId: 'acct_42' },
      dynamic: true,
    });
  });

  test('does not duplicate text when deltas already streamed', async () => {
    const agent = new Agent({ name: 'Test Agent' });

    const messageOutput = new RunMessageOutputItem(
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Hello again' }],
      },
      agent,
    );

    const events = (async function* () {
      yield new RunRawModelStreamEvent({ type: 'response_started' });
      yield new RunRawModelStreamEvent({
        type: 'output_text_delta',
        delta: 'Hello again',
      });
      yield new RunRawModelStreamEvent({
        type: 'response_done',
        response: {
          id: 'resp-dupe',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
          output: [{ type: 'unknown' }],
        },
      });
      yield new RunItemStreamEvent('message_output_created', messageOutput);
    })();

    const response = createAiSdkUiMessageStreamResponse(events);
    const chunks = await readUiMessageChunks(response);
    const deltas = chunks.filter((chunk) => chunk.type === 'text-delta');

    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ delta: 'Hello again' });
  });

  test('falls back for invalid JSON arguments and maps non-function tool inputs', async () => {
    const agent = new Agent({ name: 'Test Agent' });

    const invalidFunctionCall = new RunToolCallItem(
      {
        type: 'function_call',
        name: 'broken_json',
        arguments: '{not valid json',
      } as any,
      agent,
    );
    const computerCall = new RunToolCallItem(
      {
        type: 'computer_call',
        callId: 'computer-call-1',
        action: { type: 'click', x: 1, y: 2, button: 'left' },
      } as any,
      agent,
    );
    const shellCall = new RunToolCallItem(
      {
        type: 'shell_call',
        callId: 'shell-call-1',
        action: {
          command: 'pwd',
          cwd: '/tmp',
        },
      } as any,
      agent,
    );
    const applyPatchCall = new RunToolCallItem(
      {
        type: 'apply_patch_call',
        callId: 'apply-patch-call-1',
        operation: '*** Begin Patch\n*** End Patch\n',
      } as any,
      agent,
    );

    const events = (async function* () {
      yield new RunItemStreamEvent('tool_called', invalidFunctionCall);
      yield new RunItemStreamEvent('tool_called', computerCall);
      yield new RunItemStreamEvent('tool_called', shellCall);
      yield new RunItemStreamEvent('tool_called', applyPatchCall);
    })();

    const response = createAiSdkUiMessageStreamResponse(events);
    const chunks = await readUiMessageChunks(response);

    expect(
      chunks.filter((chunk) => chunk.type === 'tool-input-available'),
    ).toMatchObject([
      {
        toolCallId: expect.stringMatching(/^broken_json-call-/),
        toolName: 'broken_json',
        input: { raw: '{not valid json' },
        dynamic: true,
      },
      {
        toolCallId: 'computer-call-1',
        toolName: 'computer_call',
        input: { type: 'click', x: 1, y: 2, button: 'left' },
        dynamic: true,
      },
      {
        toolCallId: 'shell-call-1',
        toolName: 'shell_call',
        input: {
          command: 'pwd',
          cwd: '/tmp',
        },
        dynamic: true,
      },
      {
        toolCallId: 'apply-patch-call-1',
        toolName: 'apply_patch_call',
        input: '*** Begin Patch\n*** End Patch\n',
        dynamic: true,
      },
    ]);
  });

  test('emits approval requests with generated fallback ids', async () => {
    const agent = new Agent({ name: 'Test Agent' });

    const approvalItem = new RunToolApprovalItem(
      {
        type: 'shell_call',
        action: {
          command: 'rm -rf /tmp/nope',
        },
      } as any,
      agent,
      'shell',
    );

    const events = (async function* () {
      yield new RunItemStreamEvent('tool_approval_requested', approvalItem);
    })();

    const response = createAiSdkUiMessageStreamResponse(events);
    const chunks = await readUiMessageChunks(response);
    const approvalRequest = chunks.find(
      (chunk) => chunk.type === 'tool-approval-request',
    );

    expect(approvalRequest).toMatchObject({
      type: 'tool-approval-request',
      toolCallId: expect.stringMatching(/^shell-call-/),
      approvalId: expect.stringMatching(/^shell-call-/),
    });
  });

  test('closes pending empty steps when response_done arrives before empty message output', async () => {
    const agent = new Agent({ name: 'Test Agent' });

    const emptyMessageOutput = new RunMessageOutputItem(
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [],
      },
      agent,
    );

    const events = (async function* () {
      yield new RunRawModelStreamEvent({ type: 'response_started' });
      yield new RunRawModelStreamEvent({
        type: 'response_done',
        response: {
          id: 'resp-empty',
          usage: {
            inputTokens: 1,
            outputTokens: 0,
            totalTokens: 1,
          },
          output: [],
        },
      });
      yield new RunItemStreamEvent(
        'message_output_created',
        emptyMessageOutput,
      );
    })();

    const response = createAiSdkUiMessageStreamResponse(events);
    const chunks = await readUiMessageChunks(response);

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'start',
      'start-step',
      'finish-step',
      'finish',
    ]);
  });
});
