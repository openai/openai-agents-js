import { describe, expect, test } from 'vitest';
import {
  Agent,
  RunItemStreamEvent,
  RunRawModelStreamEvent,
  RunMessageOutputItem,
  RunReasoningItem,
  RunToolCallItem,
  RunToolCallOutputItem,
} from '@openai/agents';
import type { UIMessageChunk } from 'ai';
import { createAiSdkUiMessageStreamResponse } from '../../src/ai-sdk-ui/index';

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

describe('createAiSdkUiMessageStreamResponse', () => {
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
});
